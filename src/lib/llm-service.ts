export type LLMProvider = 'ollama' | 'lmstudio';

export interface LLMConfig {
  provider: LLMProvider;
  host: string;
  port: string;
  model: string;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

const DEFAULT_CONFIGS: Record<LLMProvider, Omit<LLMConfig, 'model'>> = {
  ollama: { provider: 'ollama', host: '127.0.0.1', port: '11434' },
  lmstudio: { provider: 'lmstudio', host: '127.0.0.1', port: '1234' },
};

export function getDefaultConfig(provider: LLMProvider): Omit<LLMConfig, 'model'> {
  return DEFAULT_CONFIGS[provider];
}

export function getBaseUrl(config: LLMConfig): string {
  const host = config.host || '127.0.0.1';
  const port = config.port || (config.provider === 'ollama' ? '11434' : '1234');
  return `http://${host}:${port}`;
}

export async function fetchModels(config: LLMConfig): Promise<string[]> {
  const base = getBaseUrl(config);
  try {
    if (config.provider === 'ollama') {
      const res = await fetch(`${base}/api/tags`);
      const data = await res.json();
      return (data.models || []).map((m: any) => m.name);
    } else {
      const res = await fetch(`${base}/v1/models`);
      const data = await res.json();
      return (data.data || []).map((m: any) => m.id);
    }
  } catch (e) {
    console.error('Failed to fetch models:', e);
    return [];
  }
}

export async function streamChat({
  config,
  messages,
  onDelta,
  onDone,
  onError,
  signal,
}: {
  config: LLMConfig;
  messages: ChatMessage[];
  onDelta: (text: string) => void;
  onDone: () => void;
  onError: (err: string) => void;
  signal?: AbortSignal;
}) {
  const base = getBaseUrl(config);

  try {
    if (config.provider === 'ollama') {
      const res = await fetch(`${base}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: config.model, messages, stream: true }),
        signal,
      });
      if (!res.ok) throw new Error(`Ollama error: ${res.status}`);
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() || '';
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const parsed = JSON.parse(line);
            if (parsed.message?.content) onDelta(parsed.message.content);
            if (parsed.done) { onDone(); return; }
          } catch {}
        }
      }
      onDone();
    } else {
      // LM Studio uses OpenAI-compatible API
      const res = await fetch(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: config.model, messages, stream: true }),
        signal,
      });
      if (!res.ok) throw new Error(`LM Studio error: ${res.status}`);
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf('\n')) !== -1) {
          let line = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          if (line.endsWith('\r')) line = line.slice(0, -1);
          if (!line.startsWith('data: ')) continue;
          const json = line.slice(6).trim();
          if (json === '[DONE]') { onDone(); return; }
          try {
            const parsed = JSON.parse(json);
            const content = parsed.choices?.[0]?.delta?.content;
            if (content) onDelta(content);
          } catch {}
        }
      }
      onDone();
    }
  } catch (e: any) {
    if (e.name === 'AbortError') return;
    onError(e.message || 'Connection failed');
  }
}

export function loadConfig(): LLMConfig {
  try {
    const saved = localStorage.getItem('llm-config');
    if (saved) return JSON.parse(saved);
  } catch {}
  return { provider: 'ollama', host: '127.0.0.1', port: '11434', model: '' };
}

export function saveConfig(config: LLMConfig) {
  localStorage.setItem('llm-config', JSON.stringify(config));
}
