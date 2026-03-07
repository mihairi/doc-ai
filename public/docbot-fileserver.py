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
    from llama_index.embeddings.huggingface import HuggingFaceEmbedding
    HAS_LLAMA = True
except ImportError:
    HAS_LLAMA = False
    print("Warning: llama-index not installed. Install with:")
    print("  pip install llama-index llama-index-embeddings-huggingface")

app = Flask(__name__)
CORS(app)

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

        Settings.embed_model = HuggingFaceEmbedding(model_name="BAAI/bge-small-en-v1.5")
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
            results.append({
                "text": node.get_text(),
                "score": float(node.get_score()) if node.get_score() is not None else 0,
                "metadata": dict(node.metadata) if node.metadata else {},
            })
        return jsonify({"results": results})

    except Exception as e:
        return jsonify({"error": str(e)}), 500


def main():
    global _folders, _index

    parser = argparse.ArgumentParser(description="DocBot File Server (LlamaIndex)")
    parser.add_argument("--port", type=int, default=5123, help="Port (default: 5123)")
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
            Settings.embed_model = HuggingFaceEmbedding(model_name="BAAI/bge-small-en-v1.5")
            Settings.llm = None
            storage_context = StorageContext.from_defaults(persist_dir=_persist_dir)
            _index = load_index_from_storage(storage_context)
            print("[DocBot] Persisted index loaded.")
        except Exception as e:
            print(f"[DocBot] Could not load persisted index: {e}")

    print(f"\nDocBot File Server running on http://0.0.0.0:{args.port}")
    print(f"Serving {len(_folders)} folder(s)\n")
    app.run(host="0.0.0.0", port=args.port, debug=False)


if __name__ == "__main__":
    main()
