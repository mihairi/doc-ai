/**
 * Loads configuration from /config.json at startup.
 * Values from config.json serve as defaults; localStorage overrides still apply.
 */

import { LLMConfig } from './llm-service';
import { FileServerConfig } from './file-server';
import { AppConfig } from './app-config';

export interface ExternalConfig {
  fileServer: FileServerConfig;
  llm: LLMConfig;
  app: AppConfig;
}

let _cached: ExternalConfig | null = null;
let _loadPromise: Promise<ExternalConfig> | null = null;

const FALLBACK: ExternalConfig = {
  fileServer: { enabled: false, url: 'http://127.0.0.1:5123' },
  llm: { provider: 'ollama', host: '127.0.0.1', port: '11434', model: '' },
  app: { appName: 'DocBot', backgroundHsl: '220 20% 7%', feedbackEnabled: true, feedbackMaxChars: 1500 },
};

export async function loadExternalConfig(): Promise<ExternalConfig> {
  if (_cached) return _cached;
  if (_loadPromise) return _loadPromise;

  _loadPromise = (async () => {
    try {
      const res = await fetch('/config.json', { cache: 'no-cache' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      _cached = {
        fileServer: { ...FALLBACK.fileServer, ...data.fileServer },
        llm: { ...FALLBACK.llm, ...data.llm },
        app: { ...FALLBACK.app, ...data.app },
      };
    } catch (err) {
      console.warn('[Config] Could not load /config.json, using defaults:', err);
      _cached = { ...FALLBACK };
    }
    return _cached;
  })();

  return _loadPromise;
}

/** Synchronous access after initial load */
export function getExternalConfig(): ExternalConfig {
  return _cached || FALLBACK;
}
