import { getExternalConfig } from './config-loader';

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
  const ext = getExternalConfig();
  return { ...ext.fileServer };
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

function networkErrorMessage(err: unknown): string {
  if (err instanceof TypeError) {
    return 'Nu se poate conecta la server. Verifică dacă serverul Python rulează și dacă adresa/portul sunt corecte.';
  }
  if (err instanceof DOMException && err.name === 'AbortError') {
    return 'Conexiunea a expirat (timeout). Serverul nu răspunde.';
  }
  return (err as any)?.message || 'Eroare necunoscută';
}

export async function fetchIndexStatus(url: string): Promise<IndexStatus> {
  try {
    const res = await fetch(`${baseUrl(url)}/api/status`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`Server error: ${res.status}`);
    return res.json();
  } catch (err) {
    throw new Error(networkErrorMessage(err));
  }
}

export async function triggerIndexing(url: string, forceFull = false): Promise<string> {
  try {
    const res = await fetch(`${baseUrl(url)}/api/index`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ force_full: forceFull }),
      signal: AbortSignal.timeout(10000),
    });
    const data = await res.json();
    if (!res.ok && res.status === 409) return 'already_indexing';
    if (!res.ok) throw new Error(data.error || `Server error: ${res.status}`);
    return data.status;
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('Nu se poate')) throw err;
    if (err instanceof Error && err.message.startsWith('Conexiunea')) throw err;
    throw new Error(networkErrorMessage(err));
  }
}

export async function queryIndex(url: string, question: string, topK = 6): Promise<RetrievalResult[]> {
  try {
    const res = await fetch(`${baseUrl(url)}/api/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question, top_k: topK }),
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `Server error: ${res.status}`);
    }
    const data = await res.json();
    return data.results || [];
  } catch (err) {
    if (err instanceof Error && (err.message.startsWith('Nu se poate') || err.message.startsWith('Conexiunea'))) throw err;
    throw new Error(networkErrorMessage(err));
  }
}

export async function fetchRemoteFolders(url: string): Promise<RemoteFolder[]> {
  try {
    const res = await fetch(`${baseUrl(url)}/api/folders`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`Server error: ${res.status}`);
    const data = await res.json();
    return data.folders || [];
  } catch (err) {
    throw new Error(networkErrorMessage(err));
  }
}

export async function verifyPasswordOnServer(url: string, password: string): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl(url)}/api/auth/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    if (!res.ok) return false;
    const data = await res.json();
    return data.authenticated === true;
  } catch {
    return false;
  }
}

export async function changePasswordOnServer(url: string, currentPassword: string, newPassword: string): Promise<{ success: boolean; error?: string }> {
  try {
    const res = await fetch(`${baseUrl(url)}/api/auth/change-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ current_password: currentPassword, new_password: newPassword }),
    });
    const data = await res.json();
    if (!res.ok) return { success: false, error: data.error || 'Server error' };
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err?.message || 'Connection failed' };
  }
}
