export type LLMProvider = 'ollama' | 'lmstudio';

export interface LLMConfig {
  provider: LLMProvider;
  host: string;
  port: string;
  model: string;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | ChatContentPart[];
}

export type ChatContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

export interface ImageData {
  name: string;
  base64: string;
  mimeType: string;
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
  images,
  onDelta,
  onDone,
  onError,
  signal,
}: {
  config: LLMConfig;
  messages: ChatMessage[];
  images?: ImageData[];
  onDelta: (text: string) => void;
  onDone: () => void;
  onError: (err: string) => void;
  signal?: AbortSignal;
}) {
  const base = getBaseUrl(config);
  const hasImages = images && images.length > 0;

  try {
    if (config.provider === 'ollama') {
      // Ollama supports images via the 'images' field in messages
      const ollamaMessages = messages.map(m => {
        const msg: any = { role: m.role, content: typeof m.content === 'string' ? m.content : m.content.map(p => p.type === 'text' ? p.text : '').join('') };
        return msg;
      });

      // Attach images to the last user message
      if (hasImages && ollamaMessages.length > 0) {
        let lastUserIdx = -1;
        for (let i = ollamaMessages.length - 1; i >= 0; i--) {
          if (ollamaMessages[i].role === 'user') { lastUserIdx = i; break; }
        }
        if (lastUserIdx !== -1) {
          ollamaMessages[lastUserIdx].images = images.map(img => img.base64);
        }
      }

      const res = await fetch(`${base}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: config.model, messages: ollamaMessages, stream: true }),
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
      // LM Studio uses OpenAI-compatible API with vision support
      const openaiMessages = messages.map(m => {
        if (typeof m.content === 'string' && !hasImages) {
          return { role: m.role, content: m.content };
        }
        // For messages with images, use content array format
        if (m.role === 'user' && typeof m.content === 'string') {
          return { role: m.role, content: m.content };
        }
        if (Array.isArray(m.content)) {
          return { role: m.role, content: m.content };
        }
        return { role: m.role, content: m.content };
      });

      // Attach images to last user message using OpenAI vision format
      if (hasImages && openaiMessages.length > 0) {
        let lastUserIdx = -1;
        for (let i = openaiMessages.length - 1; i >= 0; i--) {
          if (openaiMessages[i].role === 'user') { lastUserIdx = i; break; }
        }
        if (lastUserIdx !== -1) {
          const msg = openaiMessages[lastUserIdx];
          const textContent = typeof msg.content === 'string' ? msg.content : '';
          const contentParts: any[] = [{ type: 'text', text: textContent }];
          for (const img of images) {
            contentParts.push({
              type: 'image_url',
              image_url: { url: `data:${img.mimeType};base64,${img.base64}` }
            });
          }
          openaiMessages[lastUserIdx] = { role: msg.role, content: contentParts };
        }
      }

      const res = await fetch(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: config.model, messages: openaiMessages, stream: true }),
        signal,
      });
      if (!res.ok) throw new Error(`LM Studio error: ${res.status}`);
      if (!res.body) throw new Error('LM Studio stream indisponibil');

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';

      const processLine = (rawLine: string) => {
        let line = rawLine;
        if (line.endsWith('\r')) line = line.slice(0, -1);
        if (!line.trim()) return false;
        if (!line.startsWith('data:')) return false;

        const json = line.slice(5).trim();
        if (!json) return false;
        if (json === '[DONE]') {
          onDone();
          return true;
        }

        try {
          const parsed = JSON.parse(json);
          const deltaContent = parsed.choices?.[0]?.delta?.content;
          const messageContent = parsed.choices?.[0]?.message?.content;
          const content = deltaContent || messageContent;
          if (content) onDelta(content);
        } catch {
          // ignore malformed/incomplete SSE chunks
        }
        return false;
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buf += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          const shouldStop = processLine(line);
          if (shouldStop) return;
        }
      }

      // final flush (in case stream ends without trailing newline)
      if (buf.trim()) {
        processLine(buf);
      }
      onDone();
    }
  } catch (e: any) {
    if (e.name === 'AbortError') return;

    const rawMessage = e?.message || 'Connection failed';
    if (rawMessage.toLowerCase().includes('failed to fetch')) {
      onError('Conexiunea către LLM a eșuat. Verificați host/port și că serverul LLM rulează.');
      return;
    }

    onError(rawMessage);
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
