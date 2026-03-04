import { useState, useRef } from 'react';
import { FileText, Link, Upload, X, Globe, Loader2, FolderOpen } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { DocEntry, addDocument, removeDocument } from '@/lib/document-store';
import { useToast } from '@/hooks/use-toast';

interface DocumentManagerProps {
  documents: DocEntry[];
  onDocumentsChange: () => void;
}

export function DocumentManager({ documents, onDocumentsChange }: DocumentManagerProps) {
  const [urlInput, setUrlInput] = useState('');
  const [loadingUrl, setLoadingUrl] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;

    for (const file of Array.from(files)) {
      try {
        const text = await file.text();
        addDocument({ name: file.name, source: 'upload', content: text });
        toast({ title: 'Document adăugat', description: file.name });
      } catch {
        toast({ title: 'Eroare', description: `Nu s-a putut citi ${file.name}`, variant: 'destructive' });
      }
    }
    onDocumentsChange();
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleUrlFetch = async () => {
    if (!urlInput.trim()) return;
    setLoadingUrl(true);
    try {
      // Use a CORS proxy or direct fetch
      const res = await fetch(urlInput);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      // Strip HTML tags for plain text extraction
      const cleanText = text.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      const url = new URL(urlInput);
      addDocument({ name: url.hostname + url.pathname, source: 'url', content: cleanText });
      toast({ title: 'Conținut website încărcat', description: urlInput });
      setUrlInput('');
    } catch (e: any) {
      toast({
        title: 'Nu s-a putut accesa URL-ul',
        description: 'CORS poate bloca accesul direct. Încercați să descărcați pagina și să o încărcați manual.',
        variant: 'destructive',
      });
    }
    setLoadingUrl(false);
    onDocumentsChange();
  };

  const handleRemove = (id: string) => {
    removeDocument(id);
    onDocumentsChange();
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <h3 className="font-mono text-sm font-semibold text-foreground flex items-center gap-2">
          <FileText className="h-4 w-4 text-primary" />
          Documente ({documents.length})
        </h3>
      </div>

      {/* Upload */}
      <div className="space-y-2">
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept=".txt,.md,.html,.htm,.json,.csv,.xml,.yaml,.yml,.log,.py,.js,.ts,.tsx,.jsx,.css,.sql,.sh,.env,.cfg,.ini,.toml"
          onChange={handleFileUpload}
          className="hidden"
        />
        <input
          ref={folderInputRef}
          type="file"
          // @ts-ignore
          webkitdirectory=""
          directory=""
          multiple
          onChange={handleFileUpload}
          className="hidden"
        />
        <div className="flex gap-2">
          <Button
            variant="secondary"
            size="sm"
            className="flex-1 justify-start gap-2"
            onClick={() => fileInputRef.current?.click()}
          >
            <Upload className="h-3.5 w-3.5" /> Fișiere
          </Button>
          <Button
            variant="secondary"
            size="sm"
            className="flex-1 justify-start gap-2"
            onClick={() => folderInputRef.current?.click()}
          >
            <FolderOpen className="h-3.5 w-3.5" /> Folder
          </Button>
        </div>
      </div>

      {/* URL */}
      <div className="flex gap-2">
        <Input
          value={urlInput}
          onChange={(e) => setUrlInput(e.target.value)}
          placeholder="https://docs.example.com"
          className="h-8 text-xs font-mono bg-muted border-border"
          onKeyDown={(e) => e.key === 'Enter' && handleUrlFetch()}
        />
        <Button variant="secondary" size="sm" onClick={handleUrlFetch} disabled={loadingUrl}>
          {loadingUrl ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Globe className="h-3.5 w-3.5" />}
        </Button>
      </div>

      {/* Document List */}
      <div className="space-y-1 max-h-64 overflow-y-auto scrollbar-thin">
        {documents.length === 0 && (
          <p className="text-xs text-muted-foreground text-center py-4">
            Niciun document încărcat. Încărcați fișiere sau adăugați un URL pentru a începe.
          </p>
        )}
        {documents.map((doc) => (
          <div
            key={doc.id}
            className="flex items-center justify-between gap-2 rounded-md px-2.5 py-1.5 bg-muted/50 hover:bg-muted group transition-colors"
          >
            <div className="flex items-center gap-2 min-w-0">
              {doc.source === 'upload' ? (
                <FileText className="h-3.5 w-3.5 text-primary shrink-0" />
              ) : (
                <Link className="h-3.5 w-3.5 text-primary shrink-0" />
              )}
              <span className="text-xs truncate text-secondary-foreground">{doc.name}</span>
            </div>
            <Button
              variant="ghost"
              size="icon"
              className="h-5 w-5 opacity-0 group-hover:opacity-100 transition-opacity"
              onClick={() => handleRemove(doc.id)}
            >
              <X className="h-3 w-3" />
            </Button>
          </div>
        ))}
      </div>
    </div>
  );
}
