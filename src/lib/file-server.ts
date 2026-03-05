// File server client for accessing folders on the Ollama/local server

export interface FileServerConfig {
  enabled: boolean;
  url: string; // e.g. http://127.0.0.1:5123
}

export interface RemoteFileEntry {
  name: string;
  path: string;
  folder: string;
  type: 'text' | 'image' | 'pdf';
  size: number;
}

const FS_CONFIG_KEY = 'docbot-fileserver-config';

export function loadFileServerConfig(): FileServerConfig {
  try {
    const saved = localStorage.getItem(FS_CONFIG_KEY);
    if (saved) return JSON.parse(saved);
  } catch {}
  return { enabled: false, url: 'http://127.0.0.1:5123' };
}

export function saveFileServerConfig(config: FileServerConfig) {
  localStorage.setItem(FS_CONFIG_KEY, JSON.stringify(config));
}

export async function checkFileServerHealth(url: string): Promise<boolean> {
  try {
    const res = await fetch(`${url.replace(/\/+$/, '')}/api/health`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return false;
    const data = await res.json();
    return data.status === 'ok';
  } catch {
    return false;
  }
}

export async function fetchRemoteFiles(url: string): Promise<RemoteFileEntry[]> {
  const res = await fetch(`${url.replace(/\/+$/, '')}/api/files`);
  if (!res.ok) throw new Error(`File server error: ${res.status}`);
  const data = await res.json();
  return data.files || [];
}

export async function scanRemoteFolders(url: string): Promise<RemoteFileEntry[]> {
  const res = await fetch(`${url.replace(/\/+$/, '')}/api/scan`, { method: 'POST' });
  if (!res.ok) throw new Error(`File server error: ${res.status}`);
  const data = await res.json();
  return data.files || [];
}

export async function fetchRemoteFileContent(url: string, filePath: string): Promise<{ type: string; content: string; name: string }> {
  const res = await fetch(`${url.replace(/\/+$/, '')}/api/file?path=${encodeURIComponent(filePath)}`);
  if (!res.ok) throw new Error(`File server error: ${res.status}`);
  return res.json();
}

export async function fetchRemoteFolders(url: string): Promise<{ path: string; exists: boolean }[]> {
  const res = await fetch(`${url.replace(/\/+$/, '')}/api/folders`);
  if (!res.ok) throw new Error(`File server error: ${res.status}`);
  const data = await res.json();
  return data.folders || [];
}
