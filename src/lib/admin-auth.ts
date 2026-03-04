const ADMIN_PASSWORD = 'admin123';
const SESSION_KEY = 'admin-authenticated';

export function isAdminAuthenticated(): boolean {
  return sessionStorage.getItem(SESSION_KEY) === 'true';
}

export function authenticateAdmin(password: string): boolean {
  if (password === ADMIN_PASSWORD) {
    sessionStorage.setItem(SESSION_KEY, 'true');
    return true;
  }
  return false;
}

export function logoutAdmin() {
  sessionStorage.removeItem(SESSION_KEY);
}
