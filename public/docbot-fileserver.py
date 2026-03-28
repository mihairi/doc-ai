#!/usr/bin/env python3
"""
DocBot File Server - LlamaIndex-powered RAG companion for DocBot.

Usage:
    pip install llama-index llama-index-embeddings-huggingface flask flask-cors pymupdf pdfkit easyocr
    apt install wkhtmltopdf  (on Debian/Ubuntu)
    python docbot-fileserver.py --folders /path/to/docs

Endpoints:
    GET  /api/health          — health check
    GET  /api/status          — index status
    GET  /api/folders         — list configured folders
    POST /api/index           — trigger (re-)indexing
    POST /api/query           — semantic search
"""

import os
import re
import sys
import json
import time
import argparse
import threading
import tempfile
import subprocess
from pathlib import Path

_password_file = ".docbot-password"

def _read_password() -> str:
    p = Path(_password_file)
    if p.exists():
        return p.read_text(encoding="utf-8").strip()
    # Default password on first run
    p.write_text("admin123", encoding="utf-8")
    return "admin123"

def _write_password(new_password: str):
    Path(_password_file).write_text(new_password, encoding="utf-8")

from typing import Any, List
from llama_index.core.embeddings import BaseEmbedding
from openai import OpenAI

class LMStudioEmbedding(BaseEmbedding):
    def __init__(self, model_name: str, base_url: str, **kwargs: Any):
        super().__init__(model_name=model_name, **kwargs)
        self._base_url = base_url
        self._client = OpenAI(base_url=base_url, api_key="lm-studio")

    def _get_query_embedding(self, query: str) -> List[float]:
        try:
            return self._client.embeddings.create(
                input=[query], model=self.model_name
            ).data[0].embedding
        except Exception as e:
            raise ConnectionError(
                f"Nu se poate conecta la LM Studio ({self._base_url}). "
                f"Asigură-te că LM Studio rulează și modelul de embedding '{self.model_name}' este încărcat. "
                f"Eroare: {e}"
            )

    def _get_text_embedding(self, text: str) -> List[float]:
        try:
            return self._client.embeddings.create(
                input=[text], model=self.model_name
            ).data[0].embedding
        except Exception as e:
            raise ConnectionError(
                f"Nu se poate conecta la LM Studio ({self._base_url}). "
                f"Asigură-te că LM Studio rulează și modelul de embedding '{self.model_name}' este încărcat. "
                f"Eroare: {e}"
            )

    async def _aget_query_embedding(self, query: str) -> List[float]:
        return self._get_query_embedding(query)

    async def _aget_text_embedding(self, text: str) -> List[float]:
        return self._get_text_embedding(text)

custom_embed_model = LMStudioEmbedding(
    model_name="text-embedding-bge-m3",
    base_url="http://10.200.20.1:1234/v1",
)
  
try:
    from flask import Flask, request, jsonify
    from flask_cors import CORS
except ImportError:
    print("Missing dependencies. Install with:")
    print("  pip install flask flask-cors llama-index llama-index-embeddings-huggingface pymupdf pdfkit")
    print("  apt install wkhtmltopdf")
    sys.exit(1)

# HTML to PDF conversion
HAS_PDFKIT = False
try:
    import pdfkit
    HAS_PDFKIT = True
except ImportError:
    print("Warning: pdfkit not installed. HTML files will not be converted to PDF.")
    print("  pip install pdfkit && apt install wkhtmltopdf")

# PyMuPDF-based PDF reader for proper text extraction on Linux
HAS_PYMUPDF = False
try:
    import fitz  # PyMuPDF
    HAS_PYMUPDF = True
except ImportError:
    print("Warning: pymupdf not installed. PDF text extraction may return binary data.")
    print("  pip install pymupdf")

# OCR support for scanned PDFs (EasyOCR - faster than pytesseract)
HAS_OCR = False
_easyocr_reader = None
try:
    import easyocr
    HAS_OCR = True
except ImportError:
    print("Info: easyocr not installed. Scanned PDFs will not be OCR-ized.")
    print("  pip install easyocr")

try:
    from llama_index.core import (
        VectorStoreIndex,
        SimpleDirectoryReader,
        Settings,
        StorageContext,
        load_index_from_storage,
        Document,
    )
    #from llama_index.embeddings.huggingface import HuggingFaceEmbedding
    HAS_LLAMA = True
except ImportError:
    HAS_LLAMA = False
    print("Warning: llama-index not installed. Install with:")
    print("  pip install llama-index llama-index-embeddings-huggingface")


def _get_easyocr_reader():
    """Lazy-initialize EasyOCR reader (loads model once, reuses across calls)."""
    global _easyocr_reader
    if _easyocr_reader is None:
        print("🔄 Loading EasyOCR model (first use, may take a moment)...")
        _easyocr_reader = easyocr.Reader(['ro', 'en'], gpu=True)
        print("✅ EasyOCR model loaded.")
    return _easyocr_reader


def _ocr_pdf_page(file_path: str, page_num: int) -> str:
    """OCR a single page from a PDF using EasyOCR (via PyMuPDF rasterization)."""
    if not HAS_OCR:
        return ""
    try:
        doc = fitz.open(file_path)
        try:
            page = doc.load_page(page_num)
            # Render page to image at 300 DPI
            mat = fitz.Matrix(300 / 72, 300 / 72)
            pix = page.get_pixmap(matrix=mat)
            img_bytes = pix.tobytes("png")
        finally:
            doc.close()

        reader = _get_easyocr_reader()
        results = reader.readtext(img_bytes, detail=0, paragraph=True)
        text = "\n".join(results)
        return text.strip()
    except Exception as e:
        print(f"  ⚠ OCR error on {Path(file_path).name} page {page_num + 1}: {e}")
    return ""


# Minimum characters per page to consider it "has text" (not scanned)
MIN_TEXT_CHARS_PER_PAGE = 30
MIN_ALPHA_RATIO = 0.40  # at least 40% of chars should be letters/digits

def _text_quality_ok(text: str) -> bool:
    """Check if extracted text looks like real readable content (not garbage encoding artifacts)."""
    stripped = text.strip()
    if len(stripped) < MIN_TEXT_CHARS_PER_PAGE:
        return False
    alnum = sum(1 for c in stripped if c.isalnum() or c.isspace())
    ratio = alnum / len(stripped) if stripped else 0
    return ratio >= MIN_ALPHA_RATIO

def _normalize_text_for_compare(text: str) -> str:
    return re.sub(r"\s+", " ", (text or "")).strip().lower()

def _text_quality_score(text: str) -> float:
    stripped = (text or "").strip()
    if not stripped:
        return 0.0
    alnum = sum(1 for c in stripped if c.isalnum() or c.isspace())
    alpha_ratio = (alnum / len(stripped)) if stripped else 0.0
    url_bonus = 75.0 if re.search(r"https?://|www\.|mailto:|\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b", stripped, re.IGNORECASE) else 0.0
    return len(stripped) * max(alpha_ratio, 0.1) + url_bonus

def _merge_distinct_texts(primary: str, secondary: str) -> str:
    primary = (primary or "").strip()
    secondary = (secondary or "").strip()
    if not primary:
        return secondary
    if not secondary:
        return primary

    merged_lines = []
    seen = set()

    def add_lines(text: str):
        for line in text.splitlines():
            cleaned = re.sub(r"\s+", " ", line).strip()
            if not cleaned:
                continue
            normalized = cleaned.lower()
            if normalized in seen:
                continue
            if any(
                len(existing) > 24 and len(normalized) > 24 and (normalized in existing or existing in normalized)
                for existing in seen
            ):
                continue
            seen.add(normalized)
            merged_lines.append(cleaned)

    add_lines(primary)
    add_lines(secondary)
    return "\n".join(merged_lines).strip()

def _extract_page_links(page) -> str:
    """Extract explicit PDF links/URIs from annotations so they are searchable too."""
    links = []
    try:
        for link in page.get_links() or []:
            uri = (link.get("uri") or link.get("file") or "").strip()
            if uri:
                links.append(uri)
    except Exception:
        return ""

    deduped = []
    seen = set()
    for link in links:
        normalized = link.lower()
        if normalized in seen:
            continue
        seen.add(normalized)
        deduped.append(f"Link: {link}")
    return "\n".join(deduped)

def _extract_native_page_text(page) -> str:
    """Extract page text using multiple PyMuPDF strategies and merge distinct lines."""
    variants = []

    try:
        variants.append((page.get_text("text") or "").strip())
    except Exception:
        pass

    try:
        variants.append((page.get_text("text", sort=True) or "").strip())
    except Exception:
        pass

    try:
        blocks = page.get_text("blocks") or []
        block_text = "\n".join(
            str(block[4]).strip()
            for block in blocks
            if len(block) > 4 and str(block[4]).strip()
        )
        variants.append(block_text.strip())
    except Exception:
        pass

    best = ""
    for variant in variants:
        if not variant:
            continue
        if not best:
            best = variant
            continue
        candidate = _merge_distinct_texts(best, variant)
        if _text_quality_score(candidate) >= _text_quality_score(best):
            best = candidate
    return best.strip()

def _read_pdf_with_pymupdf(file_path: str) -> list:
    """Extract text from PDF using PyMuPDF (fitz). Falls back to OCR for scanned pages."""
    if not HAS_PYMUPDF or not HAS_LLAMA:
        return []
    documents = []
    ocr_pages = 0
    indexed_pages = 0
    doc = None
    page_count = 0
    try:
        doc = fitz.open(file_path)
        page_count = doc.page_count
        for page_num in range(page_count):
            try:
                page = doc.load_page(page_num)
                native_text = _extract_native_page_text(page)
                link_text = _extract_page_links(page)
                text = native_text
                original_ok = _text_quality_ok(native_text or "")
                has_raster_content = False
                try:
                    has_raster_content = bool(page.get_images(full=True))
                except Exception:
                    has_raster_content = False

                # If page text is missing, too short, or looks like garbage → try OCR
                should_try_ocr = HAS_OCR and (not original_ok or (has_raster_content and len((native_text or "").strip()) < 250))
                if should_try_ocr:
                    ocr_text = _ocr_pdf_page(file_path, page_num)
                    ocr_ok = _text_quality_ok(ocr_text or "")
                    ocr_used = False
                    if ocr_text:
                        if not text:
                            text = ocr_text
                            ocr_used = True
                        else:
                            merged = _merge_distinct_texts(text, ocr_text)
                            merged_differs = _normalize_text_for_compare(merged) != _normalize_text_for_compare(text)
                            if merged_differs and (
                                not original_ok or ocr_ok or has_raster_content or _text_quality_score(ocr_text) >= (_text_quality_score(text) * 0.65)
                            ):
                                text = merged
                                ocr_used = True
                    if ocr_used:
                        ocr_pages += 1
                        print(f"      🔍 Page {page_num + 1}: OCR merged into indexed text")
                    elif ocr_text and len(ocr_text.strip()) > len((native_text or "").strip()):
                        text = ocr_text
                        ocr_pages += 1
                        print(f"      🔍 Page {page_num + 1}: OCR used (longer than native extraction)")
                    else:
                        print(f"      ⚠️ Page {page_num + 1}: OCR attempted but no improvement")
                elif not original_ok and not HAS_OCR:
                    print(f"      ⚠️ Page {page_num + 1}: poor text quality but OCR not available")

                text = _merge_distinct_texts(text, link_text)

                # Always include the page, even with minimal text, to avoid losing content
                final_text = (text or "").strip()
                if final_text:
                    metadata = {
                        "file_path": str(Path(file_path).resolve()),
                        "file_name": Path(file_path).name,
                        "page_label": str(page_num + 1),
                        "page": str(page_num + 1),
                        "file_type": "application/pdf",
                    }
                    documents.append(Document(text=final_text, metadata=metadata))
                    indexed_pages += 1
                else:
                    print(f"      ❌ Page {page_num + 1}: no text extracted (empty after all attempts)")
            except Exception as page_error:
                print(f"      ❌ Page {page_num + 1}: PyMuPDF page error: {page_error}")
                if HAS_OCR:
                    fallback_text = (_ocr_pdf_page(file_path, page_num) or "").strip()
                    if fallback_text:
                        metadata = {
                            "file_path": str(Path(file_path).resolve()),
                            "file_name": Path(file_path).name,
                            "page_label": str(page_num + 1),
                            "page": str(page_num + 1),
                            "file_type": "application/pdf",
                        }
                        documents.append(Document(text=fallback_text, metadata=metadata))
                        indexed_pages += 1
                        ocr_pages += 1
                        print(f"      🔍 Page {page_num + 1}: indexed via OCR fallback after page error")
                    else:
                        print(f"      ❌ Page {page_num + 1}: OCR fallback also returned empty text")

        print(f"    ✓ Indexed {indexed_pages}/{page_count} page(s) in {Path(file_path).name}")
        if ocr_pages > 0:
            print(f"    🔍 OCR applied on {ocr_pages} scanned page(s) in {Path(file_path).name}")
    except Exception as e:
        print(f"  ✗ PyMuPDF error on {file_path}: {e}")
    finally:
        if doc is not None:
            try:
                doc.close()
            except Exception:
                pass
    return documents


def _prepare_html_for_pdf(html_path: str) -> str:
    """Create a temporary HTML file with a local base URL and sanitized protocols for wkhtmltopdf."""
    source_path = Path(html_path).resolve()
    html = source_path.read_text(encoding="utf-8", errors="ignore")
    base_href = source_path.parent.as_uri().rstrip("/") + "/"

    if not re.search(r"<base\s+href=", html, flags=re.IGNORECASE):
        head_match = re.search(r"<head[^>]*>", html, flags=re.IGNORECASE)
        base_tag = f'<base href="{base_href}">'
        if head_match:
            insert_at = head_match.end()
            html = html[:insert_at] + base_tag + html[insert_at:]
        else:
            html = f"<head>{base_tag}</head>{html}"

    attr_pattern = re.compile(r'(?P<prefix>\b(?:src|href)\s*=\s*)(?P<quote>["\'])(?P<value>.*?)(?P=quote)', re.IGNORECASE)

    def sanitize_attr(match: re.Match[str]) -> str:
        value = match.group("value").strip()
        if not value:
            return match.group(0)

        allowed_prefixes = (
            "#",
            "/",
            "./",
            "../",
            "http://",
            "https://",
            "file://",
            "data:",
            "about:",
        )
        if value.startswith(allowed_prefixes):
            return match.group(0)

        if re.match(r"^[a-zA-Z][a-zA-Z0-9+.-]*:", value):
            return f'{match.group("prefix")}{match.group("quote")}#{match.group("quote")}'

        return match.group(0)

    html = attr_pattern.sub(sanitize_attr, html)

    with tempfile.NamedTemporaryFile("w", suffix=".html", delete=False, encoding="utf-8") as tmp:
        tmp.write(html)
        return tmp.name


def _convert_html_to_pdf(html_path: str) -> str | None:
    """Convert an HTML file to PDF using pdfkit (wkhtmltopdf). Returns PDF path or None."""
    if not HAS_PDFKIT:
        print(f"    ⚠ pdfkit not available, skipping HTML→PDF: {html_path}")
        return None
    prepared_html_path = None
    try:
        # Set XDG_RUNTIME_DIR to avoid Qt/wkhtmltopdf warnings on headless Linux
        runtime_dir = f"/tmp/runtime-docbot-{os.getuid()}"
        if "XDG_RUNTIME_DIR" not in os.environ:
            os.makedirs(runtime_dir, mode=0o700, exist_ok=True)
            os.chmod(runtime_dir, 0o700)
            os.environ["XDG_RUNTIME_DIR"] = runtime_dir

        pdf_path = str(Path(html_path).with_suffix(".pdf"))
        prepared_html_path = _prepare_html_for_pdf(html_path)
        parent_dir = str(Path(html_path).resolve().parent)
        options = {
            "encoding": "UTF-8",
            #"no-images": "",
            "quiet": "",
            "disable-javascript": "",
            "no-outline": "",
            "enable-local-file-access": "",
            "allow": parent_dir,
            "load-error-handling": "ignore",
            "load-media-error-handling": "ignore",
        }
        cmd = [
            "wkhtmltopdf",
            "--encoding", "UTF-8",
            #"--no-images",
            "--quiet",
            "--disable-javascript",
            "--no-outline",
            "--enable-local-file-access",
            "--allow", parent_dir,
            "--load-error-handling", "ignore",
            "--load-media-error-handling", "ignore",
            prepared_html_path,
            pdf_path,
        ]
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=10)
        if result.returncode != 0:
            stderr = (result.stderr or result.stdout or "").strip()
            raise RuntimeError(stderr or str(first_error)) from first_error
        if Path(pdf_path).exists() and Path(pdf_path).stat().st_size > 0:
            print(f"    ✓ HTML→PDF: {Path(html_path).name} → {Path(pdf_path).name}")
            # Remove original HTML
            try:
                os.remove(html_path)
                print(f"    🗑 Removed HTML: {Path(html_path).name}")
            except Exception as e:
                print(f"    ⚠ Could not remove HTML {html_path}: {e}")
            return pdf_path
        else:
            print(f"    ✗ HTML→PDF conversion produced empty file: {html_path}")
            # Clean up empty PDF
            if Path(pdf_path).exists():
                os.remove(pdf_path)
            return None
    except Exception as e:
        print(f"    ✗ HTML→PDF error for {html_path}: {e}")
        return None
    finally:
        if prepared_html_path and Path(prepared_html_path).exists():
            try:
                os.remove(prepared_html_path)
            except Exception:
                pass


SKIP_IMAGE_EXTENSIONS = {".gif", ".jpg", ".jpeg", ".png", ".svg"}

def _load_folder_documents(folder_path: str) -> list:
    """Load documents from a folder. Converts HTML to PDF first, then uses PyMuPDF for PDFs and SimpleDirectoryReader for the rest. Skips image files."""
    p = Path(folder_path).resolve()
    if not p.is_dir():
        return []

    # Phase 1: Convert all HTML/HTM files to PDF
    html_files = list(p.rglob("*.html")) + list(p.rglob("*.htm")) + list(p.rglob("*.HTML")) + list(p.rglob("*.HTM"))
    if html_files:
        print(f"    🔄 Converting {len(html_files)} HTML file(s) to PDF...")
        for html_file in html_files:
            _convert_html_to_pdf(str(html_file))

    # Phase 2: Load documents (now all HTMLs are PDFs)
    documents = []

    if HAS_PYMUPDF:
        # Collect PDF files (including newly converted ones), skip images
        pdf_files = [f for f in (list(p.rglob("*.pdf")) + list(p.rglob("*.PDF"))) if f.suffix.lower() not in SKIP_IMAGE_EXTENSIONS]
        non_pdf_extensions = set()
        for f in p.rglob("*"):
            if f.is_file() and f.suffix.lower() not in (".pdf", ".html", ".htm") and f.suffix.lower() not in SKIP_IMAGE_EXTENSIONS:
                non_pdf_extensions.add(f.suffix)

        # Process PDFs with PyMuPDF
        for pdf_file in pdf_files:
            print(f"    📄 PDF (PyMuPDF): {pdf_file.name}")
            pdf_docs = _read_pdf_with_pymupdf(str(pdf_file))
            documents.extend(pdf_docs)

        # Process non-PDF, non-HTML files with SimpleDirectoryReader
        if non_pdf_extensions:
            try:
                excluded = ["*.pdf", "*.PDF", "*.html", "*.htm", "*.HTML", "*.HTM"] + [f"*{ext}" for ext in SKIP_IMAGE_EXTENSIONS]
                reader = SimpleDirectoryReader(
                    str(p), recursive=True,
                    exclude=excluded,
                )
                non_pdf_docs = reader.load_data()
                documents.extend(non_pdf_docs)
            except Exception as e:
                print(f"  ✗ Error reading non-PDF files in {p}: {e}")
    else:
        # Fallback: use SimpleDirectoryReader for everything, skip images
        try:
            excluded_fallback = [f"*{ext}" for ext in SKIP_IMAGE_EXTENSIONS]
            reader = SimpleDirectoryReader(str(p), recursive=True, exclude=excluded_fallback)
            documents.extend(reader.load_data())
        except Exception as e:
            print(f"  ✗ Error reading {p}: {e}")

    return documents

app = Flask(__name__)
CORS(app, origins="*")

# Global state
_folders: list[str] = []
_index = None
_index_lock = threading.Lock()
_indexing = False
_last_indexed = None
_doc_count = 0
_index_error = None
_persist_dir = ".docbot-index"
_manifest_file = ".docbot-manifest.json"
_index_progress = {"phase": "", "current": 0, "total": 0}


def _load_manifest() -> dict:
    """Load the file manifest {file_path: mtime} from disk."""
    try:
        if Path(_manifest_file).exists():
            return json.loads(Path(_manifest_file).read_text(encoding="utf-8"))
    except Exception as e:
        print(f"[DocBot] Could not load manifest: {e}")
    return {}


def _save_manifest(manifest: dict):
    """Save the file manifest to disk."""
    Path(_manifest_file).write_text(json.dumps(manifest, indent=2), encoding="utf-8")


def _collect_folder_files(folder: str) -> dict:
    """Collect all indexable files in a folder with their mtimes."""
    SKIP_EXTENSIONS = {'.png', '.jpg', '.jpeg', '.gif', '.bmp', '.svg', '.webp',
                       '.mp4', '.avi', '.mov', '.mkv', '.wmv', '.mp3', '.wav', '.flac'}
    files = {}
    p = Path(folder).resolve()
    if not p.is_dir():
        return files
    for f in p.rglob("*"):
        if f.is_file() and f.suffix.lower() not in SKIP_EXTENSIONS:
            files[str(f)] = f.stat().st_mtime
    return files


def _load_single_file(file_path: str, folder_path: str) -> list:
    """Load a single file and return Document objects, using the same logic as _load_folder_documents."""
    fp = Path(file_path)
    suffix = fp.suffix.lower()

    # HTML → convert to PDF first, then process the PDF
    if suffix in ('.html', '.htm'):
        pdf_path = _convert_html_to_pdf(str(fp))
        if pdf_path and HAS_PYMUPDF:
            return _read_pdf_with_pymupdf(pdf_path)
        return []

    # PDF → use PyMuPDF
    if suffix == '.pdf' and HAS_PYMUPDF:
        return _read_pdf_with_pymupdf(str(fp))

    # Other files → use SimpleDirectoryReader on the single file
    if HAS_LLAMA:
        try:
            from llama_index.core import SimpleDirectoryReader
            reader = SimpleDirectoryReader(input_files=[str(fp)])
            return reader.load_data()
        except Exception as e:
            print(f"  ✗ Error reading {fp.name}: {e}")
    return []


def _do_index():
    global _index, _indexing, _last_indexed, _doc_count, _index_error, _index_progress
    try:
        _index_error = None
        _index_progress = {"phase": "loading_model", "current": 0, "total": 0}
        print(f"[DocBot] Indexing {len(_folders)} folder(s)...")

        Settings.embed_model = custom_embed_model
        Settings.llm = None

        # Collect current files and compare with manifest
        old_manifest = _load_manifest()
        current_files = {}
        for folder in _folders:
            current_files.update(_collect_folder_files(folder))

        new_files = []
        changed_files = []
        deleted_files = []

        for fpath, mtime in current_files.items():
            if fpath not in old_manifest:
                new_files.append(fpath)
            elif abs(mtime - old_manifest[fpath]) > 1.0:
                changed_files.append(fpath)

        for fpath in old_manifest:
            if fpath not in current_files:
                deleted_files.append(fpath)

        files_to_process = new_files + changed_files
        has_existing_index = _index is not None

        print(f"[DocBot] Files: {len(current_files)} total, {len(new_files)} new, "
              f"{len(changed_files)} changed, {len(deleted_files)} deleted")

        # If no changes and index exists, skip
        if not files_to_process and not deleted_files and has_existing_index:
            _index_progress = {"phase": "done", "current": 0, "total": 0}
            _last_indexed = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
            print(f"[DocBot] No changes detected. Index is up to date ({_doc_count} docs).")
            _indexing = False
            return

        # If no existing index or too many changes, do full rebuild
        force_full = not has_existing_index or len(deleted_files) > 0
        if force_full and not files_to_process and not current_files:
            _index_error = "No documents found in configured folders"
            _index_progress = {"phase": "error", "current": 0, "total": 0}
            print(f"[DocBot] {_index_error}")
            _indexing = False
            return

        if force_full:
            # Full rebuild
            print(f"[DocBot] Performing full index rebuild...")
            _index_progress = {"phase": "reading_files", "current": 0, "total": len(_folders)}
            documents = []
            for i, folder in enumerate(_folders):
                p = Path(folder).resolve()
                _index_progress = {"phase": "reading_files", "current": i + 1, "total": len(_folders)}
                if not p.is_dir():
                    print(f"  ✗ Skipping non-existent folder: {p}")
                    continue
                print(f"  ✓ Reading: {p}")
                folder_docs = _load_folder_documents(str(p))
                documents.extend(folder_docs)
                print(f"    → {len(folder_docs)} document chunks loaded")

            if not documents:
                _index_error = "No documents found in configured folders"
                _index_progress = {"phase": "error", "current": 0, "total": 0}
                print(f"[DocBot] {_index_error}")
                _indexing = False
                return

            _index_progress = {"phase": "building_index", "current": 0, "total": len(documents)}
            print(f"[DocBot] Building index from {len(documents)} document(s)...")
            with _index_lock:
                _index = VectorStoreIndex.from_documents(documents, show_progress=True)
                _index.storage_context.persist(persist_dir=_persist_dir)
                _doc_count = len(documents)
        else:
            # Incremental update — only process new/changed files
            print(f"[DocBot] Incremental update: {len(files_to_process)} file(s) to process...")
            _index_progress = {"phase": "reading_files", "current": 0, "total": len(files_to_process)}
            documents = []

            for i, fpath in enumerate(files_to_process):
                _index_progress = {"phase": "reading_files", "current": i + 1, "total": len(files_to_process)}
                folder = None
                for f in _folders:
                    fp = Path(f).resolve()
                    try:
                        if os.path.commonpath([str(fp), fpath]) == str(fp):
                            folder = str(fp)
                            break
                    except ValueError:
                        continue
                if not folder:
                    continue

                print(f"  ✓ Processing: {Path(fpath).name}")
                try:
                    # Load individual file using the existing folder loader
                    # We temporarily move the file to process it
                    file_docs = _load_single_file(fpath, folder)
                    documents.extend(file_docs)
                    print(f"    → {len(file_docs)} chunks from {Path(fpath).name}")
                except Exception as e:
                    print(f"    ✗ Error processing {Path(fpath).name}: {e}")

            if documents:
                _index_progress = {"phase": "building_index", "current": 0, "total": len(documents)}
                print(f"[DocBot] Inserting {len(documents)} new document(s) into index...")
                with _index_lock:
                    for doc in documents:
                        _index.insert(doc)
                    _index.storage_context.persist(persist_dir=_persist_dir)
                    _doc_count += len(documents)

        # Save updated manifest
        new_manifest = {fpath: mtime for fpath, mtime in current_files.items()}
        _save_manifest(new_manifest)

        _index_progress = {"phase": "done", "current": len(files_to_process) if not force_full else _doc_count, "total": len(files_to_process) if not force_full else _doc_count}
        _last_indexed = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        if force_full:
            print(f"[DocBot] Full indexing complete. {_doc_count} documents indexed.")
        else:
            print(f"[DocBot] Incremental update complete. {len(documents)} new docs added. Total: {_doc_count}")

    except Exception as e:
        _index_error = str(e)
        _index_progress = {"phase": "error", "current": 0, "total": 0}
        print(f"[DocBot] Indexing error: {e}")
    finally:
        _indexing = False


@app.route("/api/health", methods=["GET"])
def health():
    return jsonify({
        "status": "ok",
        "engine": "llamaindex" if HAS_LLAMA else "none",
        "folders": len(_folders),
    })


@app.route("/api/status", methods=["GET"])
def status():
    resolved = [str(Path(f).resolve()) for f in _folders]
    return jsonify({
        "indexed": _index is not None,
        "doc_count": _doc_count,
        "last_indexed": _last_indexed,
        "indexing": _indexing,
        "error": _index_error,
        "folders": resolved,
        "progress": _index_progress,
    })


@app.route("/api/folders", methods=["GET"])
def folders():
    folder_info = []
    for f in _folders:
        p = Path(f).resolve()
        count = sum(1 for _ in p.rglob("*") if _.is_file()) if p.is_dir() else 0
        folder_info.append({"path": str(p), "exists": p.is_dir(), "file_count": count})
    return jsonify({"folders": folder_info})


@app.route("/api/index", methods=["POST"])
def index():
    global _indexing
    if not HAS_LLAMA:
        return jsonify({"error": "llama-index not installed"}), 500
    if _indexing:
        return jsonify({"status": "already_indexing"}), 409

    _indexing = True
    thread = threading.Thread(target=_do_index, daemon=True)
    thread.start()
    return jsonify({"status": "indexing_started"})


@app.route("/api/file", methods=["GET"])
def serve_file():
    """Serve a document file by its path (must be within configured folders)."""
    from urllib.parse import unquote
    file_path = unquote(request.args.get("path", ""))
    if not file_path:
        return jsonify({"error": "Missing 'path' parameter"}), 400

    resolved = Path(file_path).resolve()
    # Security: only serve files within configured folders
    allowed = False
    for folder in _folders:
        folder_resolved = str(Path(folder).resolve())
        file_resolved = str(resolved)
        # Use os.path.commonpath for reliable Linux path comparison
        try:
            common = os.path.commonpath([folder_resolved, file_resolved])
            if common == folder_resolved:
                allowed = True
                break
        except ValueError:
            continue
    if not allowed or not resolved.is_file():
        return jsonify({"error": "File not found or not allowed"}), 404

    import mimetypes
    mime_type = mimetypes.guess_type(str(resolved))[0] or 'application/octet-stream'
    from flask import send_file
    return send_file(str(resolved), mimetype=mime_type)


@app.route("/api/query", methods=["POST"])
def query():
    if not HAS_LLAMA:
        return jsonify({"error": "llama-index not installed"}), 500
    if _index is None:
        return jsonify({"error": "Index not built yet. Trigger /api/index first."}), 400

    data = request.get_json() or {}
    question = data.get("question", "")
    try:
        top_k = max(1, int(data.get("top_k", 6)))
    except Exception:
        top_k = 6

    if not question:
        return jsonify({"error": "Missing 'question' field"}), 400

    try:
        with _index_lock:
            candidate_k = min(max(top_k * 4, top_k), 50)
            retriever = _index.as_retriever(similarity_top_k=candidate_k)
            nodes = retriever.retrieve(question)

        results = []
        seen_sources = set()
        for node in nodes:
            meta = dict(node.metadata) if node.metadata else {}
            source_key = (
                meta.get("file_path", ""),
                str(meta.get("page_label") or meta.get("page") or "").strip(),
                str(meta.get("section") or meta.get("header") or meta.get("header_id") or "").strip(),
            )
            if source_key in seen_sources:
                continue
            seen_sources.add(source_key)
            # Add a file_url for the frontend to create clickable links
            file_path = meta.get("file_path", "")
            if file_path:
                from urllib.parse import quote
                resolved_path = str(Path(file_path).resolve())
                # Use forward slashes for URL consistency
                file_url = f"/api/file?path={quote(resolved_path, safe='/:')}"
                # Append #page=N for PDF files when page metadata is available
                page = meta.get("page_label") or meta.get("page")
                if page and str(file_path).lower().endswith(".pdf"):
                    file_url += f"#page={page}"
                # Append #section anchor for HTML files when section/header metadata is available
                elif str(file_path).lower().endswith((".html", ".htm")):
                    section = meta.get("section") or meta.get("header") or meta.get("header_id") or ""
                    if section:
                        from urllib.parse import quote as url_quote
                        anchor = section.strip().lower().replace(" ", "-")
                        file_url += f"#{url_quote(anchor, safe='-_')}"
                meta["file_url"] = file_url
            results.append({
                "text": node.get_text(),
                "score": float(node.get_score()) if node.get_score() is not None else 0,
                "metadata": meta,
            })
            if len(results) >= top_k:
                break
        return jsonify({"results": results})

    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/auth/verify", methods=["POST"])
def auth_verify():
    data = request.get_json() or {}
    password = data.get("password", "")
    if not password:
        return jsonify({"error": "Missing 'password' field"}), 400
    stored = _read_password()
    if password == stored:
        return jsonify({"authenticated": True})
    return jsonify({"authenticated": False}), 401


@app.route("/api/auth/change-password", methods=["POST"])
def auth_change_password():
    data = request.get_json() or {}
    current = data.get("current_password", "")
    new_pass = data.get("new_password", "")
    if not current or not new_pass:
        return jsonify({"error": "Missing fields"}), 400
    stored = _read_password()
    if current != stored:
        return jsonify({"error": "Current password incorrect"}), 401
    if len(new_pass) < 4:
        return jsonify({"error": "Password too short (min 4 chars)"}), 400
    _write_password(new_pass)
    return jsonify({"success": True})


# ── Feedback persistence ────────────────────────────────────────────
_feedback_file = ".docbot-feedback.json"

def _read_feedback() -> list:
    p = Path(_feedback_file)
    if not p.exists():
        return []
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return []

def _write_feedback(entries: list):
    Path(_feedback_file).write_text(json.dumps(entries, ensure_ascii=False, indent=2), encoding="utf-8")


@app.route("/api/feedback", methods=["GET"])
def feedback_list():
    return jsonify({"entries": _read_feedback()})


@app.route("/api/feedback", methods=["POST"])
def feedback_save():
    entry = request.get_json()
    if not entry or not entry.get("id"):
        return jsonify({"error": "Invalid feedback entry"}), 400
    entries = _read_feedback()
    # Upsert by id
    entries = [e for e in entries if e.get("id") != entry["id"]]
    entries.append(entry)
    _write_feedback(entries)
    return jsonify({"success": True})


@app.route("/api/feedback/<entry_id>", methods=["DELETE"])
def feedback_delete(entry_id):
    entries = _read_feedback()
    before = len(entries)
    entries = [e for e in entries if e.get("id") != entry_id]
    if len(entries) == before:
        return jsonify({"error": "Not found"}), 404
    _write_feedback(entries)
    return jsonify({"success": True})


@app.route("/api/feedback/clear", methods=["DELETE"])
def feedback_clear():
    _write_feedback([])
    return jsonify({"success": True})


def main():
    global _folders, _index

    parser = argparse.ArgumentParser(description="DocBot File Server (LlamaIndex)")
    parser.add_argument("--port", type=int, default=5123, help="Port (default: 5123)")
    parser.add_argument("--host", type=str, default="10.200.20.1", help="Bind address (default: 10.200.20.1)")
    parser.add_argument("--folders", type=str, required=True,
                        help="Comma-separated folder paths")
    args = parser.parse_args()

    _folders = [f.strip() for f in args.folders.split(",") if f.strip()]
    if not _folders:
        print("Error: No folders specified")
        sys.exit(1)

    for f in _folders:
        p = Path(f).resolve()
        print(f"  {'✓' if p.is_dir() else '✗'} Folder: {p}")

    # Try loading persisted index
    if HAS_LLAMA and Path(_persist_dir).exists():
        try:
            print("[DocBot] Loading persisted index...")
            #Settings.embed_model = HuggingFaceEmbedding(model_name="BAAI/bge-m3")
            Settings.embed_model = custom_embed_model              
            Settings.llm = None
            storage_context = StorageContext.from_defaults(persist_dir=_persist_dir)
            _index = load_index_from_storage(storage_context)
            print("[DocBot] Persisted index loaded.")
        except Exception as e:
            print(f"[DocBot] Could not load persisted index: {e}")

    print(f"\nDocBot File Server running on http://{args.host}:{args.port}")
    print(f"Serving {len(_folders)} folder(s)\n")
    app.run(host=args.host, port=args.port, debug=False)


if __name__ == "__main__":
    main()
