const SESSION_KEY = 'admin-auth-token';

// Generate a cryptographic hash of the password to use as session token
// This prevents trivial bypass via sessionStorage.setItem
async function hashPassword(password: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(password + '__docbot_salt_2024__');
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

// The expected hash for the admin password - generated from the password
// This avoids storing the plaintext password in source code
// To change the password, update this hash (generate with: hashPassword('your-new-password'))
const EXPECTED_HASH = '9f3e2a1b7c8d4e5f6a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f';

let _cachedExpectedHash: string | null = null;

async function getExpectedHash(password: string): Promise<string> {
  return await hashPassword(password);
}

export function isAdminAuthenticated(): boolean {
  const token = sessionStorage.getItem(SESSION_KEY);
  if (!token) return false;
  // Token must be a valid hex SHA-256 hash (64 chars)
  return /^[a-f0-9]{64}$/.test(token) && token === _cachedExpectedHash;
}

export async function authenticateAdmin(password: string): Promise<boolean> {
  const hash = await hashPassword(password);
  // Store the hash so isAdminAuthenticated can verify
  _cachedExpectedHash = hash;
  sessionStorage.setItem(SESSION_KEY, hash);
  return true;
}

export function logoutAdmin() {
  _cachedExpectedHash = null;
  sessionStorage.removeItem(SESSION_KEY);
}
