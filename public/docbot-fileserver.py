#!/usr/bin/env python3
"""
DocBot File Server - Companion script to serve local folders to DocBot.
Run this on the same machine as Ollama to give DocBot access to local folders.

Usage:
    python docbot-fileserver.py [--port 5123] [--folders /path/to/docs,/path/to/other]

The server exposes:
    GET  /api/folders         — list configured folders
    GET  /api/files           — list all files in all folders (recursive)
    GET  /api/file?path=...   — read a single file's content (text or base64)
    POST /api/scan            — re-scan all folders and return file list
    GET  /api/health          — health check

All responses include CORS headers for browser access.
"""

import os
import sys
import json
import base64
import argparse
import mimetypes
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs
from pathlib import Path

# Supported file extensions
TEXT_EXTENSIONS = {
    '.txt', '.md', '.html', '.htm', '.json', '.csv', '.xml', '.yaml', '.yml',
    '.log', '.py', '.js', '.ts', '.tsx', '.jsx', '.css', '.sql', '.sh', '.env',
    '.cfg', '.ini', '.toml', '.rst', '.rtf', '.tex', '.org', '.adoc', '.wiki',
    '.bat', '.cmd', '.ps1', '.rb', '.php', '.java', '.c', '.cpp', '.h', '.hpp',
    '.go', '.rs', '.swift', '.kt', '.scala', '.r', '.m', '.pl', '.lua',
    '.dockerfile', '.makefile', '.gitignore', '.editorconfig',
    '.svelte', '.vue', '.sass', '.scss', '.less',
}

IMAGE_EXTENSIONS = {'.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.svg'}
PDF_EXTENSION = '.pdf'

MAX_IMAGE_SIZE = 2 * 1024 * 1024   # 2MB
MAX_PDF_SIZE = 10 * 1024 * 1024    # 10MB
MAX_TEXT_SIZE = 5 * 1024 * 1024    # 5MB


def get_file_type(filepath: str):
    ext = Path(filepath).suffix.lower()
    name = Path(filepath).name.lower()
    if ext in IMAGE_EXTENSIONS:
        return 'image'
    if ext == PDF_EXTENSION:
        return 'pdf'
    if ext in TEXT_EXTENSIONS:
        return 'text'
    if name in ('dockerfile', 'makefile', 'readme', 'license', 'changelog'):
        return 'text'
    return None


class FileServerHandler(BaseHTTPRequestHandler):
    folders = []
    _file_cache = None

    def _cors_headers(self):
        return {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type',
            'Content-Type': 'application/json; charset=utf-8',
        }

    def _send_json(self, data, status=200):
        body = json.dumps(data, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        for k, v in self._cors_headers().items():
            self.send_header(k, v)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        for k, v in self._cors_headers().items():
            self.send_header(k, v)
        self.end_headers()

    def _scan_folders(self):
        files = []
        for folder in self.folders:
            folder_path = Path(folder).resolve()
            if not folder_path.is_dir():
                continue
            for filepath in folder_path.rglob('*'):
                if not filepath.is_file():
                    continue
                ftype = get_file_type(str(filepath))
                if ftype is None:
                    continue
                rel = str(filepath.relative_to(folder_path))
                size = filepath.stat().st_size

                # Skip oversized files
                if ftype == 'image' and size > MAX_IMAGE_SIZE:
                    continue
                if ftype == 'pdf' and size > MAX_PDF_SIZE:
                    continue
                if ftype == 'text' and size > MAX_TEXT_SIZE:
                    continue

                files.append({
                    'name': rel,
                    'path': str(filepath),
                    'folder': str(folder_path),
                    'type': ftype,
                    'size': size,
                })
        FileServerHandler._file_cache = files
        return files

    def _get_files(self):
        if FileServerHandler._file_cache is not None:
            return FileServerHandler._file_cache
        return self._scan_folders()

    def _read_file(self, filepath: str):
        p = Path(filepath)
        if not p.is_file():
            return None, None

        # Security: ensure path is within one of the configured folders
        resolved = p.resolve()
        allowed = False
        for folder in self.folders:
            if str(resolved).startswith(str(Path(folder).resolve())):
                allowed = True
                break
        if not allowed:
            return None, None

        ftype = get_file_type(str(p))
        if ftype == 'image':
            mime = mimetypes.guess_type(str(p))[0] or 'image/png'
            data = p.read_bytes()
            b64 = base64.b64encode(data).decode('ascii')
            return ftype, f'data:{mime};base64,{b64}'
        elif ftype == 'pdf':
            # Return raw text extraction would need a library;
            # for now return base64 so the client can handle it
            data = p.read_bytes()
            b64 = base64.b64encode(data).decode('ascii')
            return ftype, f'data:application/pdf;base64,{b64}'
        else:
            try:
                text = p.read_text(encoding='utf-8', errors='replace')
                return 'text', text
            except Exception:
                return None, None

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path.rstrip('/')
        params = parse_qs(parsed.query)

        if path == '/api/health':
            self._send_json({'status': 'ok', 'folders': len(self.folders)})

        elif path == '/api/folders':
            folder_info = []
            for f in self.folders:
                p = Path(f).resolve()
                folder_info.append({
                    'path': str(p),
                    'exists': p.is_dir(),
                })
            self._send_json({'folders': folder_info})

        elif path == '/api/files':
            files = self._get_files()
            self._send_json({'files': files, 'total': len(files)})

        elif path == '/api/file':
            file_path = params.get('path', [None])[0]
            if not file_path:
                self._send_json({'error': 'Missing path parameter'}, 400)
                return
            ftype, content = self._read_file(file_path)
            if content is None:
                self._send_json({'error': 'File not found or not allowed'}, 404)
                return
            self._send_json({'type': ftype, 'content': content, 'name': Path(file_path).name})

        else:
            self._send_json({'error': 'Not found'}, 404)

    def do_POST(self):
        parsed = urlparse(self.path)
        path = parsed.path.rstrip('/')

        if path == '/api/scan':
            files = self._scan_folders()
            self._send_json({'files': files, 'total': len(files)})
        else:
            self._send_json({'error': 'Not found'}, 404)

    def log_message(self, format, *args):
        print(f"[DocBot FileServer] {args[0]}")


def main():
    parser = argparse.ArgumentParser(description='DocBot File Server')
    parser.add_argument('--port', type=int, default=5123, help='Port to listen on (default: 5123)')
    parser.add_argument('--folders', type=str, required=True,
                        help='Comma-separated list of folder paths to serve')
    args = parser.parse_args()

    folders = [f.strip() for f in args.folders.split(',') if f.strip()]
    if not folders:
        print("Error: No folders specified")
        sys.exit(1)

    FileServerHandler.folders = folders

    for f in folders:
        p = Path(f).resolve()
        if p.is_dir():
            print(f"  ✓ Folder: {p}")
        else:
            print(f"  ✗ Folder not found: {p}")

    server = HTTPServer(('0.0.0.0', args.port), FileServerHandler)
    print(f"\nDocBot File Server running on http://0.0.0.0:{args.port}")
    print(f"Serving {len(folders)} folder(s)\n")

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down...")
        server.server_close()


if __name__ == '__main__':
    main()
