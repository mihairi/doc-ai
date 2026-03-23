import { useState, useEffect, useCallback } from 'react';
import { MessageSquare, Trash2, Download, ThumbsUp, ThumbsDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { FeedbackEntry, loadAllFeedback, deleteFeedback, clearAllFeedback } from '@/lib/feedback-store';
import { AppConfig, saveAppConfig } from '@/lib/app-config';
import { useToast } from '@/hooks/use-toast';

interface FeedbackPanelProps {
  appConfig: AppConfig;
  onAppConfigChange: (config: AppConfig) => void;
}

export function FeedbackPanel({ appConfig, onAppConfigChange }: FeedbackPanelProps) {
  const [entries, setEntries] = useState<FeedbackEntry[]>([]);
  const [open, setOpen] = useState(false);
  const { toast } = useToast();

  const refresh = useCallback(async () => {
    const all = await loadAllFeedback();
    all.sort((a, b) => b.createdAt - a.createdAt);
    setEntries(all);
  }, []);

  useEffect(() => {
    if (open) refresh();
  }, [open, refresh]);

  const toggleFeedback = (enabled: boolean) => {
    const updated = { ...appConfig, feedbackEnabled: enabled };
    saveAppConfig(updated);
    onAppConfigChange(updated);
  };

  const handleDelete = async (id: string) => {
    await deleteFeedback(id);
    setEntries(prev => prev.filter(e => e.id !== id));
    toast({ title: 'Feedback șters' });
  };

  const handleClearAll = async () => {
    await clearAllFeedback();
    setEntries([]);
    toast({ title: 'Toate feedback-urile au fost șterse' });
  };

  const handleExport = () => {
    if (entries.length === 0) {
      toast({ title: 'Nu există feedback de exportat', variant: 'destructive' });
      return;
    }
    const data = JSON.stringify(entries, null, 2);
    const blob = new Blob([data], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `feedback-export-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast({ title: `${entries.length} feedback-uri exportate` });
  };

  const formatDate = (ts: number) => {
    const d = new Date(ts);
    return d.toLocaleDateString('ro-RO', { day: '2-digit', month: '2-digit', year: 'numeric' }) +
      ' ' + d.toLocaleTimeString('ro-RO', { hour: '2-digit', minute: '2-digit' });
  };

  return (
    <div className="border-t border-border pt-4 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="font-mono text-sm font-semibold text-foreground flex items-center gap-2">
          <MessageSquare className="h-4 w-4" />
          Feedback utilizatori
        </h3>
        <Switch
          checked={appConfig.feedbackEnabled}
          onCheckedChange={toggleFeedback}
        />
      </div>

      <p className="text-[10px] text-muted-foreground">
        {appConfig.feedbackEnabled
          ? 'Utilizatorii pot evalua răspunsurile. Feedback-ul este folosit pentru a îmbunătăți răspunsurile viitoare.'
          : 'Colectarea de feedback este dezactivată.'}
      </p>

      <Button
        variant="secondary"
        size="sm"
        className="w-full justify-start gap-2"
        onClick={() => setOpen(!open)}
      >
        <MessageSquare className="h-3.5 w-3.5" />
        {open ? 'Ascunde feedback-uri' : `Vezi feedback-uri (${entries.length})`}
      </Button>

      {open && (
        <div className="space-y-2">
          {/* Actions */}
          <div className="flex gap-2">
            <Button variant="outline" size="sm" className="flex-1 gap-1.5 text-xs" onClick={handleExport}>
              <Download className="h-3 w-3" /> Export JSON
            </Button>
            <Button
              variant="destructive"
              size="sm"
              className="flex-1 gap-1.5 text-xs"
              onClick={handleClearAll}
              disabled={entries.length === 0}
            >
              <Trash2 className="h-3 w-3" /> Șterge tot
            </Button>
          </div>

          {/* Entries */}
          {entries.length === 0 ? (
            <p className="text-xs text-muted-foreground text-center py-3">Nu există feedback-uri colectate.</p>
          ) : (
            <div className="space-y-2 max-h-60 overflow-y-auto scrollbar-thin">
              {entries.map(entry => (
                <div key={entry.id} className="bg-muted/50 rounded-lg p-2.5 space-y-1 text-xs">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-1.5">
                      {entry.rating === 'good' ? (
                        <ThumbsUp className="h-3 w-3 text-green-400" />
                      ) : (
                        <ThumbsDown className="h-3 w-3 text-red-400" />
                      )}
                      <span className={`font-medium ${entry.rating === 'good' ? 'text-green-400' : 'text-red-400'}`}>
                        {entry.rating === 'good' ? 'Bun' : 'Slab'}
                      </span>
                      <span className="text-muted-foreground">· {formatDate(entry.createdAt)}</span>
                    </div>
                    <button
                      onClick={() => handleDelete(entry.id)}
                      className="p-1 rounded text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
                      title="Șterge"
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </div>
                  <div className="text-muted-foreground">
                    <span className="font-medium text-foreground">Î:</span> {entry.question.slice(0, 120)}{entry.question.length > 120 ? '…' : ''}
                  </div>
                  <div className="text-muted-foreground">
                    <span className="font-medium text-foreground">R:</span> {entry.answer.slice(0, 200)}{entry.answer.length > 200 ? '…' : ''}
                  </div>
                  {entry.comment && (
                    <div className="text-muted-foreground italic">
                      <span className="font-medium text-foreground not-italic">💬</span> {entry.comment}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
