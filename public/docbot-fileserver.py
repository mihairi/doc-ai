#!/usr/bin/env python3
"""
DocBot File Server - LlamaIndex-powered RAG companion for DocBot.

Usage:
    pip install llama-index llama-index-embeddings-huggingface flask flask-cors pymupdf pdfkit
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
import sys
import json
import time
import argparse
import threading
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
    model_name="text-embedding-embedding-gemma-300m",
    base_url="http://localhost:1234/v1",
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


def _read_pdf_with_pymupdf(file_path: str) -> list:
    """Extract text from PDF using PyMuPDF (fitz) - works reliably on Linux."""
    if not HAS_PYMUPDF or not HAS_LLAMA:
        return []
    documents = []
    try:
        doc = fitz.open(file_path)
        for page_num in range(len(doc)):
            page = doc[page_num]
            text = page.get_text("text")
            if text and text.strip():
                metadata = {
                    "file_path": str(Path(file_path).resolve()),
                    "file_name": Path(file_path).name,
                    "page_label": str(page_num + 1),
                    "file_type": "application/pdf",
                }
                documents.append(Document(text=text, metadata=metadata))
        doc.close()
    except Exception as e:
        print(f"  ✗ PyMuPDF error on {file_path}: {e}")
    return documents


def _convert_html_to_pdf(html_path: str) -> str | None:
    """Convert an HTML file to PDF using pdfkit (wkhtmltopdf). Returns PDF path or None."""
    if not HAS_PDFKIT:
        print(f"    ⚠ pdfkit not available, skipping HTML→PDF: {html_path}")
        return None
    try:
        pdf_path = str(Path(html_path).with_suffix(".pdf"))
        options = {
            "encoding": "UTF-8",
            "no-images": "",
            "quiet": "",
            "disable-javascript": "",
        }
        pdfkit.from_file(html_path, pdf_path, options=options)
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


def _load_folder_documents(folder_path: str) -> list:
    """Load documents from a folder. Converts HTML to PDF first, then uses PyMuPDF for PDFs and SimpleDirectoryReader for the rest."""
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
        # Collect PDF files (including newly converted ones)
        pdf_files = list(p.rglob("*.pdf")) + list(p.rglob("*.PDF"))
        non_pdf_extensions = set()
        for f in p.rglob("*"):
            if f.is_file() and f.suffix.lower() not in (".pdf", ".html", ".htm"):
                non_pdf_extensions.add(f.suffix)

        # Process PDFs with PyMuPDF
        for pdf_file in pdf_files:
            print(f"    📄 PDF (PyMuPDF): {pdf_file.name}")
            pdf_docs = _read_pdf_with_pymupdf(str(pdf_file))
            documents.extend(pdf_docs)

        # Process non-PDF, non-HTML files with SimpleDirectoryReader
        if non_pdf_extensions:
            try:
                excluded = ["*.pdf", "*.PDF", "*.html", "*.htm", "*.HTML", "*.HTM"]
                reader = SimpleDirectoryReader(
                    str(p), recursive=True,
                    exclude=excluded,
                )
                non_pdf_docs = reader.load_data()
                documents.extend(non_pdf_docs)
            except Exception as e:
                print(f"  ✗ Error reading non-PDF files in {p}: {e}")
    else:
        # Fallback: use SimpleDirectoryReader for everything
        try:
            reader = SimpleDirectoryReader(str(p), recursive=True)
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
_index_progress = {"phase": "", "current": 0, "total": 0}


def _do_index():
    global _index, _indexing, _last_indexed, _doc_count, _index_error, _index_progress
    try:
        _index_error = None
        _index_progress = {"phase": "loading_model", "current": 0, "total": 0}
        print(f"[DocBot] Indexing {len(_folders)} folder(s)...")

        #Settings.embed_model = HuggingFaceEmbedding(model_name="BAAI/bge-m3")
        Settings.embed_model = custom_embed_model
        Settings.llm = None

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
            _index = VectorStoreIndex.from_documents(
                documents,
                show_progress=True,
            )
            _index.storage_context.persist(persist_dir=_persist_dir)
            _doc_count = len(documents)

        _index_progress = {"phase": "done", "current": len(documents), "total": len(documents)}
        _last_indexed = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        print(f"[DocBot] Indexing complete. {_doc_count} documents indexed.")

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
    top_k = data.get("top_k", 6)

    if not question:
        return jsonify({"error": "Missing 'question' field"}), 400

    try:
        with _index_lock:
            retriever = _index.as_retriever(similarity_top_k=top_k)
            nodes = retriever.retrieve(question)

        results = []
        for node in nodes:
            meta = dict(node.metadata) if node.metadata else {}
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


def main():
    global _folders, _index

    parser = argparse.ArgumentParser(description="DocBot File Server (LlamaIndex)")
    parser.add_argument("--port", type=int, default=5123, help="Port (default: 5123)")
    parser.add_argument("--host", type=str, default="0.0.0.0", help="Bind address (default: 0.0.0.0)")
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
