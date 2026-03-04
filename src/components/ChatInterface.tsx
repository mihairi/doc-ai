import { useState, useRef, useEffect } from 'react';
import { Send, Square, Bot, User } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { LLMConfig, streamChat, ChatMessage } from '@/lib/llm-service';
import { DocEntry, buildContextPrompt, getImageEntries } from '@/lib/document-store';
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
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const { toast } = useToast();

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  const handleSend = async () => {
    const text = input.trim();
    if (!text || isStreaming) return;

    if (!config.model) {
      toast({ title: 'Niciun model selectat', description: 'Configurați LLM-ul din setări mai întâi.', variant: 'destructive' });
      return;
    }

    if (documents.length === 0) {
      toast({ title: 'Nu sunt documente încărcate', description: 'Contactați administratorul pentru a încărca documentația.', variant: 'destructive' });
      return;
    }

    const userMsg: DisplayMessage = { role: 'user', content: text };
    setMessages(prev => [...prev, userMsg]);
    setInput('');
    setIsStreaming(true);

    const systemPrompt = buildContextPrompt(documents);
    const imageEntries = getImageEntries(documents);
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
            setMessages(prev => [...prev, { role: 'assistant', content: 'Această informație nu există în documentele furnizate.' }]);
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

  return (
    <div className="flex flex-col h-full">
      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto scrollbar-thin p-4 space-y-4">
        {messages.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full text-center text-muted-foreground">
            <Bot className="h-12 w-12 mb-4 opacity-30" />
             <h2 className="text-lg font-semibold mb-1 text-foreground">DocBot</h2>
             <p className="text-sm max-w-sm">
               Încărcați documentația, conectați-vă la LLM-ul local și puneți întrebări. Răspunsurile provin exclusiv din documentele dvs.
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
            placeholder={documents.length === 0 ? "Încărcați documente mai întâi..." : "Întrebați despre documentația dvs..."}
            disabled={documents.length === 0}
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
              disabled={!input.trim() || documents.length === 0}
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
