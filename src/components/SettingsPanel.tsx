import { useState, useEffect } from 'react';
import { Settings, RefreshCw, Check, Wifi, WifiOff, Server, FolderOpen, Database, Zap, FileText, Cpu } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { LLMConfig, LLMProvider, getDefaultConfig, fetchModels, loadConfig, saveConfig } from '@/lib/llm-service';
import {
  FileServerConfig,
  IndexStatus,
  loadFileServerConfig,
  saveFileServerConfig,
  checkFileServerHealth,
  fetchRemoteFolders,
  fetchIndexStatus,
  triggerIndexing,
  RemoteFolder,
} from '@/lib/file-server';
import { useToast } from '@/hooks/use-toast';

interface SettingsPanelProps {
  config: LLMConfig;
  onConfigChange: (config: LLMConfig) => void;
}

export function SettingsPanel({ config, onConfigChange }: SettingsPanelProps) {
  const [models, setModels] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [connected, setConnected] = useState(false);
  const [open, setOpen] = useState(false);
  const { toast } = useToast();

  // File server state
  const [fsConfig, setFsConfig] = useState<FileServerConfig>(loadFileServerConfig);
  const [fsConnected, setFsConnected] = useState(false);
  const [fsEngine, setFsEngine] = useState<string | undefined>();
  const [fsFolders, setFsFolders] = useState<RemoteFolder[]>([]);
  const [fsChecking, setFsChecking] = useState(false);
  const [indexStatus, setIndexStatus] = useState<IndexStatus | null>(null);
  const [indexing, setIndexing] = useState(false);
  const [indexStartTime, setIndexStartTime] = useState<number | null>(null);
  const [indexElapsed, setIndexElapsed] = useState<number>(0);
  const [lastIndexDuration, setLastIndexDuration] = useState<number | null>(null);

  const refreshModels = async () => {
    setLoading(true);
    const found = await fetchModels(config);
    setModels(found);
    setConnected(found.length > 0);
    if (found.length > 0 && !config.model) {
      const updated = { ...config, model: found[0] };
      onConfigChange(updated);
      saveConfig(updated);
    }
    setLoading(false);
  };

  useEffect(() => {
    if (config.host && config.port) {
      refreshModels();
    }
  }, [config.provider, config.host, config.port]);

  const checkFileServer = async () => {
    if (!fsConfig.enabled || !fsConfig.url) {
      setFsConnected(false);
      setFsFolders([]);
      setIndexStatus(null);
      return;
    }
    setFsChecking(true);
    const health = await checkFileServerHealth(fsConfig.url);
    setFsConnected(health.ok);
    setFsEngine(health.engine);
    if (health.ok) {
      try {
        const [folders, status] = await Promise.all([
          fetchRemoteFolders(fsConfig.url),
          fetchIndexStatus(fsConfig.url),
        ]);
        setFsFolders(folders);
        setIndexStatus(status);
      } catch {
        setFsFolders([]);
        setIndexStatus(null);
      }
    } else {
      setFsFolders([]);
      setIndexStatus(null);
    }
    setFsChecking(false);
  };

  useEffect(() => {
    if (fsConfig.enabled) {
      checkFileServer();
    }
  }, [fsConfig.enabled, fsConfig.url]);

  // Poll index status while indexing
  useEffect(() => {
    if (!indexing || !fsConfig.enabled) return;
    const interval = setInterval(async () => {
      try {
        const status = await fetchIndexStatus(fsConfig.url);
        setIndexStatus(status);
        if (!status.indexing) {
          setIndexing(false);
          if (indexStartTime) {
            setLastIndexDuration(Math.round((Date.now() - indexStartTime) / 1000));
            setIndexStartTime(null);
          }
          toast({
            title: status.error ? 'Eroare la indexare' : 'Indexare completă',
            description: status.error || `${status.doc_count} documente indexate.`,
            variant: status.error ? 'destructive' : 'default',
          });
        }
      } catch {}
    }, 1000);
    return () => clearInterval(interval);
  }, [indexing, fsConfig.url, fsConfig.enabled, indexStartTime]);

  // Live elapsed timer
  useEffect(() => {
    if (!indexStartTime) return;
    const interval = setInterval(() => {
      setIndexElapsed(Math.round((Date.now() - indexStartTime) / 1000));
    }, 500);
    return () => clearInterval(interval);
  }, [indexStartTime]);

  const formatDuration = (seconds: number) => {
    if (seconds < 60) return `${seconds}s`;
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}m ${s}s`;
  };

  const handleTriggerIndex = async () => {
    try {
      const result = await triggerIndexing(fsConfig.url);
      if (result === 'already_indexing') {
        toast({ title: 'Indexarea este deja în curs...' });
      } else {
        setIndexing(true);
        setIndexStartTime(Date.now());
        setIndexElapsed(0);
        setLastIndexDuration(null);
        toast({ title: 'Indexare pornită', description: 'Se procesează documentele...' });
      }
    } catch (err: any) {
      toast({ title: 'Eroare', description: err?.message, variant: 'destructive' });
    }
  };

  const updateField = (field: keyof LLMConfig, value: string) => {
    const updated = { ...config, [field]: value };
    if (field === 'provider') {
      const defaults = getDefaultConfig(value as LLMProvider);
      updated.host = defaults.host;
      updated.port = defaults.port;
      updated.model = '';
    }
    onConfigChange(updated);
    saveConfig(updated);
  };

  const updateFsConfig = (patch: Partial<FileServerConfig>) => {
    const updated = { ...fsConfig, ...patch };
    setFsConfig(updated);
    saveFileServerConfig(updated);
  };

  return (
    <div className="relative">
      <Button
        variant="ghost"
        size="icon"
        onClick={() => setOpen(!open)}
        className="relative"
      >
        <Settings className="h-5 w-5" />
        <span className={`absolute top-1 right-1 h-2 w-2 rounded-full ${connected ? 'bg-primary' : 'bg-destructive'}`} />
      </Button>

      {open && (
        <div className="absolute left-0 top-12 z-50 w-80 rounded-lg border bg-card p-4 shadow-xl space-y-4 max-h-[80vh] overflow-y-auto scrollbar-thin">
          {/* LLM Config */}
          <div className="flex items-center justify-between">
            <h3 className="font-mono text-sm font-semibold text-foreground">Configurare LLM</h3>
            <div className="flex items-center gap-1.5 text-xs">
              {connected ? (
                <><Wifi className="h-3.5 w-3.5 text-primary" /><span className="text-primary">Conectat</span></>
              ) : (
                <><WifiOff className="h-3.5 w-3.5 text-destructive" /><span className="text-destructive">Deconectat</span></>
              )}
            </div>
          </div>

          <div className="space-y-3">
            <div>
              <Label className="text-xs text-muted-foreground">Furnizor</Label>
              <Select value={config.provider} onValueChange={(v) => updateField('provider', v)}>
                <SelectTrigger className="mt-1 h-9 bg-muted border-border">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ollama">Ollama</SelectItem>
                  <SelectItem value="lmstudio">LM Studio</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div>
                <Label className="text-xs text-muted-foreground">Gazdă / IP</Label>
                <Input
                  value={config.host}
                  onChange={(e) => updateField('host', e.target.value)}
                  placeholder="127.0.0.1"
                  className="mt-1 h-9 font-mono text-xs bg-muted border-border"
                />
              </div>
              <div>
                <Label className="text-xs text-muted-foreground">Port</Label>
                <Input
                  value={config.port}
                  onChange={(e) => updateField('port', e.target.value)}
                  placeholder="11434"
                  className="mt-1 h-9 font-mono text-xs bg-muted border-border"
                />
              </div>
            </div>

            <div>
              <div className="flex items-center justify-between">
                <Label className="text-xs text-muted-foreground">Model</Label>
                <Button variant="ghost" size="icon" className="h-6 w-6" onClick={refreshModels} disabled={loading}>
                  <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
                </Button>
              </div>
              <Select value={config.model} onValueChange={(v) => updateField('model', v)}>
                <SelectTrigger className="mt-1 h-9 bg-muted border-border font-mono text-xs">
                  <SelectValue placeholder={models.length === 0 ? 'Niciun model găsit' : 'Selectați modelul'} />
                </SelectTrigger>
                <SelectContent>
                  {models.map((m) => (
                    <SelectItem key={m} value={m} className="font-mono text-xs">{m}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* LlamaIndex Server Config */}
          <div className="border-t border-border pt-4 space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="font-mono text-sm font-semibold text-foreground flex items-center gap-2">
                <Server className="h-4 w-4" />
                LlamaIndex Server
              </h3>
              <Switch
                checked={fsConfig.enabled}
                onCheckedChange={(checked) => updateFsConfig({ enabled: checked })}
              />
            </div>

            {fsConfig.enabled && (
              <>
                <div>
                  <Label className="text-xs text-muted-foreground">URL Server</Label>
                  <div className="flex gap-2 mt-1">
                    <Input
                      value={fsConfig.url}
                      onChange={(e) => updateFsConfig({ url: e.target.value })}
                      placeholder="http://127.0.0.1:5123"
                      className="h-9 font-mono text-xs bg-muted border-border"
                    />
                    <Button variant="ghost" size="icon" className="h-9 w-9 shrink-0" onClick={checkFileServer} disabled={fsChecking}>
                      <RefreshCw className={`h-3.5 w-3.5 ${fsChecking ? 'animate-spin' : ''}`} />
                    </Button>
                  </div>
                </div>

                <div className="flex items-center gap-1.5 text-xs">
                  {fsConnected ? (
                    <>
                      <Wifi className="h-3.5 w-3.5 text-primary" />
                      <span className="text-primary">
                        Conectat{fsEngine ? ` · ${fsEngine}` : ''}
                      </span>
                    </>
                  ) : (
                    <><WifiOff className="h-3.5 w-3.5 text-destructive" /><span className="text-destructive">Deconectat</span></>
                  )}
                </div>

                {/* Index status & trigger */}
                {fsConnected && (
                  <div className="space-y-2">
                    <Button
                      variant="secondary"
                      size="sm"
                      className="w-full justify-start gap-2"
                      onClick={handleTriggerIndex}
                      disabled={indexing || (indexStatus?.indexing ?? false)}
                    >
                      {indexing || indexStatus?.indexing ? (
                        <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Zap className="h-3.5 w-3.5" />
                      )}
                      {indexing || indexStatus?.indexing ? 'Se indexează...' : 'Re-indexare documente'}
                    </Button>

                    {/* Progress indicator */}
                    {(indexing || indexStatus?.indexing) && indexStatus?.progress && indexStatus.progress.phase && (
                      <div className="space-y-1.5 bg-muted/50 rounded p-2">
                        <div className="flex items-center gap-1.5 text-[10px] font-mono text-muted-foreground">
                          {indexStatus.progress.phase === 'loading_model' && (
                            <><Cpu className="h-3 w-3 animate-pulse text-primary" /><span>Se încarcă modelul de embedding...</span></>
                          )}
                          {indexStatus.progress.phase === 'reading_files' && (
                            <><FileText className="h-3 w-3 animate-pulse text-primary" /><span>Se citesc fișierele... ({indexStatus.progress.current}/{indexStatus.progress.total} foldere)</span></>
                          )}
                          {indexStatus.progress.phase === 'building_index' && (
                            <><Database className="h-3 w-3 animate-pulse text-primary" /><span>Se construiește indexul... ({indexStatus.progress.total} documente)</span></>
                          )}
                        </div>
                        {indexStatus.progress.total > 0 && indexStatus.progress.phase === 'reading_files' && (
                          <div className="w-full bg-muted rounded-full h-1.5">
                            <div
                              className="bg-primary h-1.5 rounded-full transition-all duration-500"
                              style={{ width: `${Math.round((indexStatus.progress.current / indexStatus.progress.total) * 100)}%` }}
                            />
                          </div>
                        )}
                        {indexStatus.progress.phase === 'building_index' && (
                          <div className="w-full bg-muted rounded-full h-1.5 overflow-hidden">
                            <div className="bg-primary h-1.5 rounded-full animate-pulse w-full opacity-50" />
                          </div>
                        )}
                        <div className="text-[10px] font-mono text-muted-foreground text-right">
                          ⏱ {formatDuration(indexElapsed)}
                        </div>
                      </div>
                    )}

                    {indexStatus && (
                      <div className="text-[10px] text-muted-foreground font-mono bg-muted/50 rounded p-2 space-y-0.5">
                        <div className="flex items-center gap-1">
                          <Database className="h-3 w-3" />
                          <span>{indexStatus.doc_count} documente indexate</span>
                        </div>
                        {indexStatus.last_indexed && (
                          <div>Ultima indexare: {indexStatus.last_indexed}</div>
                        )}
                        {lastIndexDuration !== null && (
                          <div>Durată: {formatDuration(lastIndexDuration)}</div>
                        )}
                        {indexStatus.error && (
                          <div className="text-destructive">Eroare: {indexStatus.error}</div>
                        )}
                      </div>
                    )}
                  </div>
                )}

                {fsFolders.length > 0 && (
                  <div className="space-y-1">
                    <Label className="text-xs text-muted-foreground">Foldere configurate:</Label>
                    {fsFolders.map((f, i) => (
                      <div key={i} className="flex items-center gap-2 text-xs font-mono bg-muted/50 rounded px-2 py-1">
                        <FolderOpen className={`h-3 w-3 ${f.exists ? 'text-primary' : 'text-destructive'}`} />
                        <span className="truncate text-secondary-foreground">{f.path}</span>
                        {f.exists && <span className="text-muted-foreground text-[10px] ml-auto">{f.file_count}</span>}
                        {!f.exists && <span className="text-destructive text-[10px]">lipsă</span>}
                      </div>
                    ))}
                  </div>
                )}

                {!fsConnected && (
                  <div className="text-[10px] text-muted-foreground bg-muted/50 rounded p-2 space-y-1">
                    <p className="font-semibold">Porniți serverul pe mașina cu Ollama:</p>
                    <code className="block bg-muted rounded px-1.5 py-0.5 text-primary break-all">
                      pip install llama-index llama-index-embeddings-huggingface flask flask-cors
                    </code>
                    <code className="block bg-muted rounded px-1.5 py-0.5 text-primary break-all">
                      python docbot-fileserver.py --folders /cale/documente
                    </code>
                    <p>Descărcați scriptul din <span className="text-primary">/docbot-fileserver.py</span></p>
                  </div>
                )}
              </>
            )}
          </div>

          <Button variant="secondary" size="sm" className="w-full" onClick={() => setOpen(false)}>
            <Check className="h-3.5 w-3.5 mr-1.5" /> Gata
          </Button>
        </div>
      )}
    </div>
  );
}
