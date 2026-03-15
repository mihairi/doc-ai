#!/usr/bin/env python3
"""
DocBot File Server - LlamaIndex-powered RAG companion for DocBot.

Usage:
    pip install llama-index llama-index-embeddings-huggingface flask flask-cors
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

from typing import Any, List
from llama_index.core.embeddings import BaseEmbedding
from openai import OpenAI

class LMStudioEmbedding(BaseEmbedding):
    def __init__(self, model_name: str, base_url: str, **kwargs: Any):
        super().__init__(model_name=model_name, **kwargs)
        self._client = OpenAI(base_url=base_url, api_key="lm-studio")

    def _get_query_embedding(self, query: str) -> List[float]:
        """Obține embedding-ul pentru o întrebare."""
        return self._client.embeddings.create(
            input=[query], model=self.model_name
        ).data[0].embedding

    def _get_text_embedding(self, text: str) -> List[float]:
        """Obține embedding-ul pentru un document (chunk)."""
        return self._client.embeddings.create(
            input=[text], model=self.model_name
        ).data[0].embedding

    async def _aget_query_embedding(self, query: str) -> List[float]:
        return self._get_query_embedding(query)

    async def _aget_text_embedding(self, text: str) -> List[float]:
        return self._get_text_embedding(text)
        
custom_embed_model = LMStudioEmbedding(
    #model_name="text-embedding-granite-embedding-278m-multilingual",
    #model_name="text-embedding-rgveda-embedding-gemma",
    #model_name="text-embedding-nomic-embed-text-v2-moe",
    model_name="text-embedding-embedding-gemma-300m",
    base_url="http://localhost:1234/v1",
)
  
try:
    from flask import Flask, request, jsonify
    from flask_cors import CORS
except ImportError:
    print("Missing dependencies. Install with:")
    print("  pip install flask flask-cors llama-index llama-index-embeddings-huggingface")
    sys.exit(1)

try:
    from llama_index.core import (
        VectorStoreIndex,
        SimpleDirectoryReader,
        Settings,
        StorageContext,
        load_index_from_storage,
    )
    #from llama_index.embeddings.huggingface import HuggingFaceEmbedding
    HAS_LLAMA = True
except ImportError:
    HAS_LLAMA = False
    print("Warning: llama-index not installed. Install with:")
    print("  pip install llama-index llama-index-embeddings-huggingface")

app = Flask(__name__)
CORS(app, origins=[
    "http://localhost:5173", "http://127.0.0.1:5173",
    "http://localhost:5174", "http://127.0.0.1:5174",
    "http://localhost:3000", "http://127.0.0.1:3000",
    "http://localhost:8080", "http://127.0.0.1:8080",
])

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

# LLM config (LM Studio)
_llm_config = {
    "enabled": False,
    "base_url": "http://localhost:1234/v1",
    "model": "",
}
_llm_config_file = ".docbot-llm-config.json"


def _load_llm_config():
    global _llm_config
    try:
        if Path(_llm_config_file).exists():
            with open(_llm_config_file) as f:
                _llm_config.update(json.load(f))
    except Exception as e:
        print(f"[DocBot] Could not load LLM config: {e}")


def _save_llm_config():
    try:
        with open(_llm_config_file, "w") as f:
            json.dump(_llm_config, f, indent=2)
    except Exception as e:
        print(f"[DocBot] Could not save LLM config: {e}")


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
            try:
                reader = SimpleDirectoryReader(str(p), recursive=True)
                documents.extend(reader.load_data())
            except Exception as e:
                print(f"  ✗ Error reading {p}: {e}")

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
    file_path = request.args.get("path", "")
    if not file_path:
        return jsonify({"error": "Missing 'path' parameter"}), 400

    resolved = Path(file_path).resolve()
    # Security: only serve files within configured folders
    allowed = False
    for folder in _folders:
        if str(resolved).startswith(str(Path(folder).resolve())):
            allowed = True
            break
    if not allowed or not resolved.is_file():
        return jsonify({"error": "File not found or not allowed"}), 404

    from flask import send_file
    return send_file(str(resolved))


@app.route("/api/llm-config", methods=["GET"])
def get_llm_config():
    return jsonify(_llm_config)


@app.route("/api/llm-config", methods=["POST"])
def set_llm_config():
    global _llm_config
    data = request.get_json() or {}
    _llm_config["enabled"] = bool(data.get("enabled", False))
    _llm_config["base_url"] = data.get("base_url", _llm_config["base_url"])
    _llm_config["model"] = data.get("model", _llm_config["model"])
    _save_llm_config()
    return jsonify({"status": "ok", "config": _llm_config})


@app.route("/api/llm-models", methods=["GET"])
def list_llm_models():
    """List available models from the configured LM Studio server."""
    try:
        import requests as req_lib
        base = _llm_config.get("base_url", "http://localhost:1234/v1").rstrip("/")
        resp = req_lib.get(f"{base}/models", timeout=5)
        if resp.ok:
            data = resp.json()
            models = [m.get("id", "") for m in data.get("data", [])]
            return jsonify({"models": models})
        return jsonify({"models": [], "error": f"Status {resp.status_code}"}), 200
    except Exception as e:
        return jsonify({"models": [], "error": str(e)}), 200


def _rewrite_query(question: str) -> dict:
    """Use the configured local LLM to rewrite the query for better retrieval.
    Returns {"original": str, "rewritten": str, "used_llm": bool}."""
    if not _llm_config.get("enabled") or not _llm_config.get("model"):
        return {"original": question, "rewritten": question, "used_llm": False}

    try:
        client = OpenAI(
            base_url=_llm_config.get("base_url", "http://localhost:1234/v1"),
            api_key="lm-studio",
        )
        resp = client.chat.completions.create(
            model=_llm_config["model"],
            messages=[
                {
                    "role": "system",
                    "content": (
                        "You are a query rewriting assistant. Your job is to reformulate "
                        "the user's question into a better search query for semantic document retrieval. "
                        "Output ONLY the rewritten query, nothing else. Keep the same language as the input. "
                        "Make it more specific, expand abbreviations, and add relevant synonyms or context."
                    ),
                },
                {"role": "user", "content": question},
            ],
            max_tokens=200,
            temperature=0.3,
        )
        rewritten = resp.choices[0].message.content.strip()
        if rewritten:
            print(f"[DocBot] Query rewrite: '{question}' → '{rewritten}'")
            return {"original": question, "rewritten": rewritten, "used_llm": True}
    except Exception as e:
        print(f"[DocBot] Query rewrite failed (falling back to original): {e}")

    return {"original": question, "rewritten": question, "used_llm": False}


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
        # Rewrite query using local LLM if configured
        qr = _rewrite_query(question)
        search_query = qr["rewritten"]

        with _index_lock:
            retriever = _index.as_retriever(similarity_top_k=top_k)
            nodes = retriever.retrieve(search_query)

        results = []
        for node in nodes:
            meta = dict(node.metadata) if node.metadata else {}
            # Add a file_url for the frontend to create clickable links
            file_path = meta.get("file_path", "")
            if file_path:
                from urllib.parse import quote
                file_url = f"/api/file?path={quote(str(Path(file_path).resolve()), safe='')}"
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
        return jsonify({
            "results": results,
            "query_rewrite": qr,
        })

    except Exception as e:
        return jsonify({"error": str(e)}), 500


def main():
    global _folders, _index

    parser = argparse.ArgumentParser(description="DocBot File Server (LlamaIndex)")
    parser.add_argument("--port", type=int, default=5123, help="Port (default: 5123)")
    parser.add_argument("--folders", type=str, required=True,
                        help="Comma-separated folder paths")
    args = parser.parse_args()

    _load_llm_config()

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

    print(f"\nDocBot File Server running on http://127.0.0.1:{args.port}")
    print(f"Serving {len(_folders)} folder(s)\n")
    app.run(host="127.0.0.1", port=args.port, debug=False)


if __name__ == "__main__":
    main()
