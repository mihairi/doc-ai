const SESSION_KEY = 'admin-auth-token';

// Generate a cryptographic hash of the password to use as session token
async function hashPassword(password: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(password + '__docbot_salt_2024__');
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

// Pre-computed SHA-256 hash — password is NOT stored in source.
// To change, run in browser console:
//   crypto.subtle.digest('SHA-256', new TextEncoder().encode('yourPassword' + '__docbot_salt_2024__'))
//     .then(b => Array.from(new Uint8Array(b)).map(x => x.toString(16).padStart(2,'0')).join(''))
const EXPECTED_HASH = '52a358e48a726774b2d67971ca54fac53676aa2a3e18e52e440f8f9e401e4a9e';

let _cachedSessionHash: string | null = null;

export function isAdminAuthenticated(): boolean {
  const token = sessionStorage.getItem(SESSION_KEY);
  if (!token) return false;
  return /^[a-f0-9]{64}$/.test(token) && token === _cachedSessionHash;
}

export async function authenticateAdmin(password: string): Promise<boolean> {
  const hash = await hashPassword(password);
  if (hash !== EXPECTED_HASH) return false;
  _cachedSessionHash = hash;
  sessionStorage.setItem(SESSION_KEY, hash);
  return true;
}

export function logoutAdmin() {
  _cachedSessionHash = null;
  sessionStorage.removeItem(SESSION_KEY);
}
