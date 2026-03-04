import { useState, useEffect } from 'react';
import { Settings, RefreshCw, Check, Wifi, WifiOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { LLMConfig, LLMProvider, getDefaultConfig, fetchModels, loadConfig, saveConfig } from '@/lib/llm-service';

interface SettingsPanelProps {
  config: LLMConfig;
  onConfigChange: (config: LLMConfig) => void;
}

export function SettingsPanel({ config, onConfigChange }: SettingsPanelProps) {
  const [models, setModels] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [connected, setConnected] = useState(false);
  const [open, setOpen] = useState(false);

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
        <div className="absolute right-0 top-12 z-50 w-80 rounded-lg border bg-card p-4 shadow-xl space-y-4">
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

          <Button variant="secondary" size="sm" className="w-full" onClick={() => setOpen(false)}>
            <Check className="h-3.5 w-3.5 mr-1.5" /> Gata
          </Button>
        </div>
      )}
    </div>
  );
}
