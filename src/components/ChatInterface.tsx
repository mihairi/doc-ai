import { useState, useRef, useEffect } from 'react';
import { Send, Square, Bot, User, Server } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { LLMConfig, streamChat, ChatMessage } from '@/lib/llm-service';
import { DocEntry, buildContextPrompt, getImageEntries } from '@/lib/document-store';
import { loadFileServerConfig, queryIndex } from '@/lib/file-server';
import { useToast } from '@/hooks/use-toast';

interface DisplayMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface ChatInterfaceProps {
  config: LLMConfig;
  documents: DocEntry[];
}

export function ChatInterface({ config, documents }: ChatInterfaceProps) {
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [input, setInput] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [usingServer, setUsingServer] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const { toast } = useToast();

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  // Check if LlamaIndex server is available
  useEffect(() => {
    const fsConfig = loadFileServerConfig();
    setUsingServer(fsConfig.enabled);
  }, []);

  const buildContextFromServer = async (question: string): Promise<string> => {
    const fsConfig = loadFileServerConfig();
    const results = await queryIndex(fsConfig.url, question, 6);
    
    if (results.length === 0) return '';

    const chunks = results
      .map((r, i) => {
        const source = r.metadata?.file_name || r.metadata?.file_path || `Fragment ${i + 1}`;
        return `--- ${source} (scor: ${r.score.toFixed(3)}) ---\n${r.text}`;
      })
      .join('\n\n');

    return `Ești un asistent de documentație. Răspunde EXCLUSIV pe baza fragmentelor de documentație furnizate mai jos.

REGULI IMPORTANTE:
1. Răspunde în limba în care este pusă întrebarea.
2. Dacă informația NU se găsește în documentele furnizate, spune clar acest lucru.
3. NU folosi cunoștințe externe.
4. Oferă răspuns concret și complet bazat pe fragmente.

Documentație relevantă:
${chunks}`;
  };

  const handleSend = async () => {
    const text = input.trim();
    if (!text || isStreaming) return;

    if (!config.model) {
      toast({ title: 'Niciun model selectat', description: 'Configurați LLM-ul din setări mai întâi.', variant: 'destructive' });
      return;
    }

    const fsConfig = loadFileServerConfig();
    const serverMode = fsConfig.enabled;

    if (!serverMode && documents.length === 0) {
      toast({ title: 'Nu sunt documente', description: 'Încărcați documente local sau activați LlamaIndex Server din Setări.', variant: 'destructive' });
      return;
    }

    const userMsg: DisplayMessage = { role: 'user', content: text };
    setMessages(prev => [...prev, userMsg]);
    setInput('');
    setIsStreaming(true);

    let systemPrompt: string;
    
    try {
      if (serverMode) {
        // Use LlamaIndex server for retrieval
        systemPrompt = await buildContextFromServer(text);
        if (!systemPrompt) {
          systemPrompt = 'Nu s-au găsit documente relevante pe server. Informează utilizatorul.';
        }
      } else {
        // Fallback to local documents
        systemPrompt = buildContextPrompt(documents, text);
      }
    } catch (err: any) {
      toast({ title: 'Eroare retrieval', description: err?.message || 'Nu s-a putut interoga serverul.', variant: 'destructive' });
      // Fallback to local
      systemPrompt = buildContextPrompt(documents, text);
    }

    const imageEntries = !serverMode ? getImageEntries(documents) : [];
    const history: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      ...messages.map(m => ({ role: m.role as 'user' | 'assistant', content: m.content })),
      { role: 'user' as const, content: text },
    ];

    let assistantSoFar = '';
    const controller = new AbortController();
    abortRef.current = controller;

    const upsert = (chunk: string) => {
      assistantSoFar += chunk;
      setMessages(prev => {
        const last = prev[prev.length - 1];
        if (last?.role === 'assistant' && prev.length > 0 && prev[prev.length - 2]?.content === text) {
          return prev.map((m, i) => i === prev.length - 1 ? { ...m, content: assistantSoFar } : m);
        }
        return [...prev, { role: 'assistant', content: assistantSoFar }];
      });
    };

    try {
      await streamChat({
        config,
        messages: history,
        images: imageEntries.length > 0 ? imageEntries : undefined,
        onDelta: upsert,
        onDone: () => {
          setIsStreaming(false);
          if (!assistantSoFar.trim()) {
            setMessages(prev => [...prev, { role: 'assistant', content: 'Nu am primit răspuns de la model. Verificați conexiunea la LLM și modelul selectat.' }]);
          }
        },
        onError: (err) => {
          setIsStreaming(false);
          toast({ title: 'Eroare conexiune LLM', description: err, variant: 'destructive' });
        },
        signal: controller.signal,
      });
    } catch (e) {
      setIsStreaming(false);
      toast({ title: 'Eroare', description: 'A apărut o eroare neașteptată la trimiterea mesajului.', variant: 'destructive' });
    }
  };

  const handleStop = () => {
    abortRef.current?.abort();
    setIsStreaming(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const fsConfig = loadFileServerConfig();
  const hasSource = fsConfig.enabled || documents.length > 0;

  return (
    <div className="flex flex-col h-full">
      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto scrollbar-thin p-4 space-y-4">
        {messages.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full text-center text-muted-foreground">
            <Bot className="h-12 w-12 mb-4 opacity-30" />
             <h2 className="text-lg font-semibold mb-1 text-foreground">DocBot</h2>
             <p className="text-sm max-w-sm">
               {fsConfig.enabled ? (
                 <span className="flex items-center justify-center gap-1.5">
                   <Server className="h-3.5 w-3.5 text-primary" />
                   Conectat la LlamaIndex Server · Puneți întrebări despre documentația dvs.
                 </span>
               ) : (
                 'Încărcați documentația, conectați-vă la LLM-ul local și puneți întrebări.'
               )}
             </p>
          </div>
        )}
        {messages.map((msg, i) => (
          <div key={i} className={`flex gap-3 ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            {msg.role === 'assistant' && (
              <div className="shrink-0 h-7 w-7 rounded-md bg-primary/10 flex items-center justify-center mt-0.5">
                <Bot className="h-4 w-4 text-primary" />
              </div>
            )}
            <div
              className={`max-w-[75%] rounded-lg px-4 py-2.5 text-sm ${
                msg.role === 'user'
                  ? 'bg-chat-user text-foreground'
                  : 'bg-chat-assistant text-foreground'
              }`}
            >
              {msg.role === 'assistant' ? (
                <div className="prose prose-sm prose-invert max-w-none [&_code]:font-mono [&_code]:text-primary [&_pre]:bg-muted [&_pre]:rounded-md">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.content}</ReactMarkdown>
                </div>
              ) : (
                <p className="whitespace-pre-wrap">{msg.content}</p>
              )}
            </div>
            {msg.role === 'user' && (
              <div className="shrink-0 h-7 w-7 rounded-md bg-secondary flex items-center justify-center mt-0.5">
                <User className="h-4 w-4 text-secondary-foreground" />
              </div>
            )}
          </div>
        ))}
        {isStreaming && messages[messages.length - 1]?.role !== 'assistant' && (
          <div className="flex gap-3">
            <div className="shrink-0 h-7 w-7 rounded-md bg-primary/10 flex items-center justify-center">
              <Bot className="h-4 w-4 text-primary animate-pulse" />
            </div>
            <div className="bg-chat-assistant rounded-lg px-4 py-2.5">
              <div className="flex gap-1">
                <span className="h-2 w-2 rounded-full bg-primary/40 animate-bounce" style={{ animationDelay: '0ms' }} />
                <span className="h-2 w-2 rounded-full bg-primary/40 animate-bounce" style={{ animationDelay: '150ms' }} />
                <span className="h-2 w-2 rounded-full bg-primary/40 animate-bounce" style={{ animationDelay: '300ms' }} />
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Input */}
      <div className="border-t border-border p-4">
        <div className="flex gap-2 items-end">
          <Textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={!hasSource ? "Configurați o sursă de documente mai întâi..." : "Întrebați despre documentația dvs..."}
            disabled={!hasSource}
            className="min-h-[44px] max-h-32 resize-none bg-muted border-border font-sans text-sm"
            rows={1}
          />
          {isStreaming ? (
            <Button variant="destructive" size="icon" onClick={handleStop} className="shrink-0 h-11 w-11">
              <Square className="h-4 w-4" />
            </Button>
          ) : (
            <Button
              size="icon"
              onClick={handleSend}
              disabled={!input.trim() || !hasSource}
              className="shrink-0 h-11 w-11"
            >
              <Send className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
