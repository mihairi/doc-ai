import { loadAppConfig, hashPassword } from './app-config';

const SESSION_KEY = 'admin-auth-token';

let _cachedSessionHash: string | null = null;

export function isAdminAuthenticated(): boolean {
  const token = sessionStorage.getItem(SESSION_KEY);
  if (!token) return false;
  return /^[a-f0-9]{64}$/.test(token) && token === _cachedSessionHash;
}

export async function authenticateAdmin(password: string): Promise<boolean> {
  const config = loadAppConfig();
  const hash = await hashPassword(password);
  if (hash !== config.adminPasswordHash) return false;
  _cachedSessionHash = hash;
  sessionStorage.setItem(SESSION_KEY, hash);
  return true;
}

export function logoutAdmin() {
  _cachedSessionHash = null;
  sessionStorage.removeItem(SESSION_KEY);
}
