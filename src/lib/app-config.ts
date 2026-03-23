import { getExternalConfig } from './config-loader';

const CONFIG_KEY = 'docbot-app-config';

export interface AppConfig {
  appName: string;
  backgroundHsl: string; // stored as HSL values e.g. "220 20% 7%"
  feedbackEnabled: boolean;
  feedbackMaxChars: number; // max chars for feedback section injected into prompt
}

const DEFAULT_CONFIG: AppConfig = {
  appName: 'DocBot',
  backgroundHsl: '220 20% 7%',
  feedbackEnabled: true,
  feedbackMaxChars: 1500,
};

export function loadAppConfig(): AppConfig {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    if (raw) {
      return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
    }
  } catch {}
  const ext = getExternalConfig();
  return { ...DEFAULT_CONFIG, ...ext.app };
}

export function saveAppConfig(config: AppConfig) {
  localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
}

/** Apply the background color from config to the CSS variable */
export function applyBackground(hsl: string) {
  document.documentElement.style.setProperty('--background', hsl);
}

/** Apply app name to document title */
export function applyAppName(name: string) {
  document.title = name;
}
