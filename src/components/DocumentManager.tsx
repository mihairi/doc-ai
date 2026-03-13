import { useState, useRef } from 'react';
import { FileText, Link, Upload, X, Globe, Loader2, FolderOpen, Image, FileType, RefreshCw, Trash2, Database } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { DocEntry, DocType, addDocument, addDocuments, removeDocument, clearAllDocuments, getDocumentCount } from '@/lib/document-store';
import { extractPdfText } from '@/lib/pdf-utils';
import { useToast } from '@/hooks/use-toast';

interface DocumentManagerProps {
  documents: DocEntry[];
  onDocumentsChange: () => void;
}

const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.html', '.htm', '.json', '.csv', '.xml', '.yaml', '.yml',
  '.log', '.py', '.js', '.ts', '.tsx', '.jsx', '.css', '.sql', '.sh', '.env',
  '.cfg', '.ini', '.toml', '.rst', '.rtf', '.tex', '.org', '.adoc', '.wiki',
  '.bat', '.cmd', '.ps1', '.rb', '.php', '.java', '.c', '.cpp', '.h', '.hpp',
  '.go', '.rs', '.swift', '.kt', '.scala', '.r', '.m', '.pl', '.lua',
  '.dockerfile', '.makefile', '.gitignore', '.editorconfig', '.prettierrc',
  '.eslintrc', '.babelrc', '.svelte', '.vue', '.sass', '.scss', '.less',
]);

const IMAGE_EXTENSIONS = new Set([
  '.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.svg',
]);

const PDF_EXTENSIONS = new Set(['.pdf']);

function getFileType(filename: string): DocType | null {
  const lower = filename.toLowerCase();
  const ext = '.' + lower.split('.').pop();
  
  if (IMAGE_EXTENSIONS.has(ext)) return 'image';
  if (PDF_EXTENSIONS.has(ext)) return 'pdf';
  if (TEXT_EXTENSIONS.has(ext)) return 'text';
  
  if (['dockerfile', 'makefile', 'readme', 'license', 'changelog', 'contributing'].some(n => lower.endsWith(n))) {
    return 'text';
  }
  
  return null;
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export function DocumentManager({ documents, onDocumentsChange }: DocumentManagerProps) {
  const [urlInput, setUrlInput] = useState('');
  const [loadingUrl, setLoadingUrl] = useState(false);
  const [loadingFiles, setLoadingFiles] = useState(false);
  const [indexing, setIndexing] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    setLoadingFiles(true);
    let added = 0;
    let skipped = 0;
    let errors: string[] = [];

    const BATCH_SIZE = 20;
    const fileArray = Array.from(files);
    
    for (let batchStart = 0; batchStart < fileArray.length; batchStart += BATCH_SIZE) {
      const batch = fileArray.slice(batchStart, batchStart + BATCH_SIZE);
      const docsToAdd: Omit<DocEntry, 'id' | 'addedAt'>[] = [];

      for (const file of batch) {
        const fileType = getFileType(file.name);
        
        if (!fileType) {
          skipped++;
          continue;
        }

        try {
          const name = file.webkitRelativePath || file.name;

          if (fileType === 'image') {
            if (file.size > 2 * 1024 * 1024) {
              errors.push(`${file.name} (prea mare, max 2MB)`);
              continue;
            }
            const base64 = await fileToBase64(file);
            docsToAdd.push({ name, source: 'upload', type: 'image', content: base64 });
          } else if (fileType === 'pdf') {
            if (file.size > 10 * 1024 * 1024) {
              errors.push(`${file.name} (prea mare, max 10MB)`);
              continue;
            }
            const text = await extractPdfText(file);
            if (!text.trim()) {
              errors.push(`${file.name} (PDF fără text - posibil scanat)`);
              continue;
            }
            docsToAdd.push({ name, source: 'upload', type: 'pdf', content: text });
          } else {
            const text = await file.text();
            if (!text.trim() || (text.match(/\0/g)?.length || 0) > 10) {
              skipped++;
              continue;
            }
            docsToAdd.push({ name, source: 'upload', type: 'text', content: text });
          }
        } catch (err) {
          console.error(`Error processing ${file.name}:`, err);
          errors.push(file.name);
        }
      }

      if (docsToAdd.length > 0) {
        const batchAdded = await addDocuments(docsToAdd);
        added += batchAdded;
      }
    }

    if (added > 0) {
      const desc = [
        skipped > 0 ? `${skipped} ignorate` : '',
        errors.length > 0 ? `${errors.length} erori` : '',
      ].filter(Boolean).join(', ');
      toast({ title: `${added} document${added > 1 ? 'e' : ''} adăugat${added > 1 ? 'e' : ''}`, description: desc || undefined });
    } else {
      const desc = errors.length > 0 ? errors.join(', ') : `${skipped} fișiere incompatibile`;
      toast({ title: 'Niciun document adăugat', description: desc, variant: 'destructive' });
    }

    onDocumentsChange();
    setLoadingFiles(false);
    if (fileInputRef.current) fileInputRef.current.value = '';
    if (folderInputRef.current) folderInputRef.current.value = '';
  };

  const handleUrlFetch = async () => {
    const url = urlInput.trim();
    if (!url) return;

    try {
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        toast({
          title: 'Protocol invalid',
          description: 'Doar URL-uri HTTP/HTTPS sunt acceptate.',
          variant: 'destructive',
        });
        return;
      }
      const blockedHosts = ['localhost', '127.0.0.1', '0.0.0.0', '[::1]'];
      const hostname = parsed.hostname.toLowerCase();
      const isPrivateIP = /^(10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|192\.168\.\d+\.\d+|169\.254\.\d+\.\d+)$/.test(hostname);
      if (blockedHosts.includes(hostname) || isPrivateIP) {
        toast({
          title: 'URL blocat',
          description: 'Accesul la adrese locale sau de rețea internă nu este permis.',
          variant: 'destructive',
        });
        return;
      }
    } catch {
      toast({
        title: 'URL invalid',
        description: 'Introduceți un URL valid (ex: https://example.com).',
        variant: 'destructive',
      });
      return;
    }

    setLoadingUrl(true);
    
    const stripHtml = (html: string) =>
      html
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    const tryDirectFetch = async (): Promise<string> => {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.text();
    };

    const proxyFetchers = [
      async (): Promise<string> => {
        const res = await fetch(`https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`);
        if (!res.ok) throw new Error(`AllOrigins ${res.status}`);
        return res.text();
      },
      async (): Promise<string> => {
        const res = await fetch(`https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}`);
        if (!res.ok) throw new Error(`CodeTabs ${res.status}`);
        return res.text();
      },
      async (): Promise<string> => {
        const res = await fetch(`https://corsproxy.io/?${encodeURIComponent(url)}`);
        if (!res.ok) throw new Error(`CorsProxy.io ${res.status}`);
        return res.text();
      },
    ];

    try {
      let rawHtml: string | null = null;
      
      // Try direct fetch first
      try {
        rawHtml = await tryDirectFetch();
      } catch {
        // Direct fetch blocked by CORS — try proxies
      }

      // Try each proxy until one works
      if (!rawHtml) {
        for (const proxyFetch of proxyFetchers) {
          try {
            rawHtml = await proxyFetch();
            if (rawHtml) break;
          } catch (err) {
            console.warn('Proxy failed:', err);
          }
        }
      }

      if (!rawHtml) {
        throw new Error('All fetch methods failed');
      }
      
      const cleanText = stripHtml(rawHtml);
      if (!cleanText || cleanText.length < 20) {
        toast({
          title: 'Conținut insuficient',
          description: 'Pagina nu conține text util. Poate fi o aplicație SPA. Salvați pagina (Ctrl+S) și încărcați fișierul.',
          variant: 'destructive',
        });
      } else {
        const parsedUrl = new URL(url);
        await addDocument({ name: parsedUrl.hostname + parsedUrl.pathname, source: 'url', type: 'text', content: cleanText });
        toast({ title: 'Conținut website încărcat', description: url });
        setUrlInput('');
      }
    } catch {
      toast({
        title: 'Nu s-a putut accesa URL-ul',
        description: 'Serverul nu permite accesul. Salvați pagina (Ctrl+S) și încărcați-o cu butonul "Fișiere" sau "Folder".',
        variant: 'destructive',
      });
    }
    setLoadingUrl(false);
    onDocumentsChange();
  };

  const handleRemove = async (id: string) => {
    await removeDocument(id);
    onDocumentsChange();
  };

  const handleReindex = async () => {
    setIndexing(true);
    onDocumentsChange();
    const count = await getDocumentCount();
    toast({ title: 'Indexare completă', description: `${count} documente locale disponibile.` });
    setIndexing(false);
  };

  const handleClearAll = async () => {
    if (!confirm('Sigur doriți să ștergeți TOATE documentele locale? Această acțiune nu poate fi anulată.')) return;
    await clearAllDocuments();
    onDocumentsChange();
    toast({ title: 'Toate documentele locale au fost șterse' });
  };

  const getDocIcon = (doc: DocEntry) => {
    if (doc.type === 'image') return <Image className="h-3.5 w-3.5 text-primary shrink-0" />;
    if (doc.type === 'pdf') return <FileType className="h-3.5 w-3.5 text-primary shrink-0" />;
    if (doc.source === 'url') return <Link className="h-3.5 w-3.5 text-primary shrink-0" />;
    return <FileText className="h-3.5 w-3.5 text-primary shrink-0" />;
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="font-mono text-sm font-semibold text-foreground flex items-center gap-2">
          <FileText className="h-4 w-4 text-primary" />
          Documente locale ({documents.length})
        </h3>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={handleReindex}
            disabled={indexing}
            title="Re-indexare documente locale"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${indexing ? 'animate-spin' : ''}`} />
          </Button>
          {documents.length > 0 && (
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-destructive hover:text-destructive"
              onClick={handleClearAll}
              title="Șterge toate documentele locale"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      </div>

      {/* Storage info */}
      <div className="flex items-center gap-2 text-[10px] text-muted-foreground font-mono px-1">
        <Database className="h-3 w-3" />
        <span>IndexedDB local · LlamaIndex Server pentru foldere</span>
      </div>

      {/* Upload */}
      <div className="space-y-2">
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept=".txt,.md,.html,.htm,.json,.csv,.xml,.yaml,.yml,.log,.py,.js,.ts,.tsx,.jsx,.css,.sql,.sh,.env,.cfg,.ini,.toml,.pdf,.jpg,.jpeg,.png,.gif,.bmp,.webp,.svg,.rst,.rtf,.tex,.rb,.php,.java,.c,.cpp,.h,.go,.rs,.swift,.kt,.scala,.r,.pl,.lua,.vue,.svelte,.sass,.scss,.less"
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
            disabled={loadingFiles}
          >
            {loadingFiles ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />} Fișiere
          </Button>
          <Button
            variant="secondary"
            size="sm"
            className="flex-1 justify-start gap-2"
            onClick={() => folderInputRef.current?.click()}
            disabled={loadingFiles}
          >
            {loadingFiles ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FolderOpen className="h-3.5 w-3.5" />} Folder
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
      <div className="space-y-1 max-h-[50vh] overflow-y-auto scrollbar-thin">
        {documents.length === 0 && (
          <p className="text-xs text-muted-foreground text-center py-4">
            Niciun document local. Folosiți LlamaIndex Server pentru foldere de pe server.
          </p>
        )}
        {documents.map((doc) => (
          <div
            key={doc.id}
            className="flex items-center justify-between gap-2 rounded-md px-2.5 py-1.5 bg-muted/50 hover:bg-muted group transition-colors"
          >
            <div className="flex items-center gap-2 min-w-0">
              {getDocIcon(doc)}
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
