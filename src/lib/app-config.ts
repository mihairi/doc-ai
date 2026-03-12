const CONFIG_KEY = 'docbot-app-config';

export interface AppConfig {
  appName: string;
  adminPasswordHash: string;
  backgroundHsl: string; // stored as HSL values e.g. "220 20% 7%"
}

const DEFAULT_CONFIG: AppConfig = {
  appName: 'DocBot',
  adminPasswordHash: '', // will be set on first load
  backgroundHsl: '220 20% 7%',
};

export async function hashPassword(password: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(password + '__docbot_salt_2024__');
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

export function loadAppConfig(): AppConfig {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    if (raw) {
      return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
    }
  } catch {}
  return { ...DEFAULT_CONFIG };
}

export function saveAppConfig(config: AppConfig) {
  localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
}

/** Ensure a default password hash exists on first run */
export async function ensureDefaultPassword(config: AppConfig): Promise<AppConfig> {
  if (!config.adminPasswordHash) {
    const hash = await hashPassword('admin123');
    config = { ...config, adminPasswordHash: hash };
    saveAppConfig(config);
  }
  return config;
}

/** Apply the background color from config to the CSS variable */
export function applyBackground(hsl: string) {
  document.documentElement.style.setProperty('--background', hsl);
}

/** Apply app name to document title */
export function applyAppName(name: string) {
  document.title = name;
}
