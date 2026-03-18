import { loadFileServerConfig, verifyPasswordOnServer } from './file-server';

const SESSION_KEY = 'admin-auth-token';

export function isAdminAuthenticated(): boolean {
  return sessionStorage.getItem(SESSION_KEY) === 'authenticated';
}

export async function authenticateAdmin(password: string): Promise<boolean> {
  const fsConfig = loadFileServerConfig();
  if (!fsConfig.enabled || !fsConfig.url) {
    // Fallback: no server configured, deny access
    return false;
  }
  const ok = await verifyPasswordOnServer(fsConfig.url, password);
  if (ok) {
    sessionStorage.setItem(SESSION_KEY, 'authenticated');
  }
  return ok;
}

export function logoutAdmin() {
  sessionStorage.removeItem(SESSION_KEY);
}
