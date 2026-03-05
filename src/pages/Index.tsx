import { useState, useCallback, useEffect } from 'react';
import { Terminal, Lock, LogOut, KeyRound } from 'lucide-react';
import { SettingsPanel } from '@/components/SettingsPanel';
import { DocumentManager } from '@/components/DocumentManager';
import { ChatInterface } from '@/components/ChatInterface';
import { LLMConfig, loadConfig } from '@/lib/llm-service';
import { DocEntry, loadDocuments, migrateFromLocalStorage } from '@/lib/document-store';
import { isAdminAuthenticated, authenticateAdmin, logoutAdmin } from '@/lib/admin-auth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useToast } from '@/hooks/use-toast';

const Index = () => {
  const [config, setConfig] = useState<LLMConfig>(loadConfig);
  const [documents, setDocuments] = useState<DocEntry[]>([]);
  const [isAdmin, setIsAdmin] = useState(isAdminAuthenticated);
  const [showLogin, setShowLogin] = useState(false);
  const [password, setPassword] = useState('');
  const { toast } = useToast();

  // Load docs from IndexedDB on mount (+ migrate from localStorage if needed)
  useEffect(() => {
    (async () => {
      const migrated = await migrateFromLocalStorage();
      if (migrated > 0) {
        toast({ title: `${migrated} documente migrate din localStorage în IndexedDB` });
      }
      const docs = await loadDocuments();
      setDocuments(docs);
    })();
  }, []);

  const refreshDocs = useCallback(async () => {
    const docs = await loadDocuments();
    setDocuments(docs);
  }, []);

  const handleAdminLogin = () => {
    if (authenticateAdmin(password)) {
      setIsAdmin(true);
      setShowLogin(false);
      setPassword('');
      toast({ title: 'Autentificare reușită', description: 'Aveți acces la setări și documente.' });
    } else {
      toast({ title: 'Parolă incorectă', variant: 'destructive' });
    }
  };

  const handleAdminLogout = () => {
    logoutAdmin();
    setIsAdmin(false);
    toast({ title: 'Deconectat', description: 'Sesiunea de administrator s-a încheiat.' });
  };

  return (
    <div className="flex h-screen bg-background">
      {/* Sidebar - only for admin */}
      {isAdmin && (
        <aside className="w-80 border-r border-border flex flex-col bg-card shrink-0">
          <div className="p-4 border-b border-border flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Terminal className="h-5 w-5 text-primary" />
              <h1 className="font-mono text-sm font-bold tracking-tight text-foreground">DocBot</h1>
            </div>
            <div className="flex items-center gap-1">
              <SettingsPanel config={config} onConfigChange={setConfig} />
              <Button variant="ghost" size="icon" onClick={handleAdminLogout} title="Deconectare admin">
                <LogOut className="h-4 w-4" />
              </Button>
            </div>
          </div>
          <div className="flex-1 p-4 overflow-y-auto scrollbar-thin">
            <DocumentManager documents={documents} onDocumentsChange={refreshDocs} />
          </div>
          <div className="p-3 border-t border-border">
            <p className="text-[10px] text-muted-foreground font-mono text-center">
              {config.provider.toUpperCase()} · {config.host}:{config.port} · {config.model || 'no model'}
            </p>
          </div>
        </aside>
      )}

      {/* Main Chat */}
      <main className="flex-1 flex flex-col min-w-0">
        {/* Top bar for non-admin */}
        {!isAdmin && (
          <div className="p-3 border-b border-border flex items-center justify-between bg-card">
            <div className="flex items-center gap-2">
              <Terminal className="h-5 w-5 text-primary" />
              <h1 className="font-mono text-sm font-bold tracking-tight text-foreground">DocBot</h1>
            </div>
            {!showLogin ? (
              <Button variant="ghost" size="icon" onClick={() => setShowLogin(true)} title="Admin login">
                <Lock className="h-4 w-4 text-muted-foreground" />
              </Button>
            ) : (
              <div className="flex items-center gap-2">
                <Input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleAdminLogin()}
                  placeholder="Parolă admin"
                  className="h-8 w-40 text-xs font-mono bg-muted border-border"
                  autoFocus
                />
                <Button variant="secondary" size="sm" onClick={handleAdminLogin}>
                  <KeyRound className="h-3.5 w-3.5" />
                </Button>
                <Button variant="ghost" size="sm" onClick={() => { setShowLogin(false); setPassword(''); }}>
                  ✕
                </Button>
              </div>
            )}
          </div>
        )}
        <ChatInterface config={config} documents={documents} />
      </main>
    </div>
  );
};

export default Index;
