// LlamaIndex server client for document indexing and retrieval

export interface FileServerConfig {
  enabled: boolean;
  url: string; // e.g. http://127.0.0.1:5123
}

export interface IndexProgress {
  phase: 'loading_model' | 'reading_files' | 'building_index' | 'done' | 'error' | '';
  current: number;
  total: number;
}

export interface IndexStatus {
  indexed: boolean;
  doc_count: number;
  last_indexed: string | null;
  indexing: boolean;
  error: string | null;
  folders: string[];
  progress: IndexProgress;
}

export interface RetrievalResult {
  text: string;
  score: number;
  metadata: Record<string, string>;
}

export interface RemoteFolder {
  path: string;
  exists: boolean;
  file_count: number;
}

const FS_CONFIG_KEY = 'docbot-fileserver-config';

function baseUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

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

export async function checkFileServerHealth(url: string): Promise<{ ok: boolean; engine?: string }> {
  try {
    const res = await fetch(`${baseUrl(url)}/api/health`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return { ok: false };
    const data = await res.json();
    return { ok: data.status === 'ok', engine: data.engine };
  } catch (err) {
    console.error('[FileServer] Health check failed:', err);
    return { ok: false };
  }
}

export async function fetchIndexStatus(url: string): Promise<IndexStatus> {
  const res = await fetch(`${baseUrl(url)}/api/status`);
  if (!res.ok) throw new Error(`Server error: ${res.status}`);
  return res.json();
}

export async function triggerIndexing(url: string): Promise<string> {
  const res = await fetch(`${baseUrl(url)}/api/index`, { method: 'POST' });
  const data = await res.json();
  if (!res.ok && res.status === 409) return 'already_indexing';
  if (!res.ok) throw new Error(data.error || `Server error: ${res.status}`);
  return data.status;
}

export async function queryIndex(url: string, question: string, topK = 6): Promise<RetrievalResult[]> {
  const res = await fetch(`${baseUrl(url)}/api/query`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question, top_k: topK }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Server error: ${res.status}`);
  }
  const data = await res.json();
  return data.results || [];
}

export async function fetchRemoteFolders(url: string): Promise<RemoteFolder[]> {
  const res = await fetch(`${baseUrl(url)}/api/folders`);
  if (!res.ok) throw new Error(`Server error: ${res.status}`);
  const data = await res.json();
  return data.folders || [];
}
