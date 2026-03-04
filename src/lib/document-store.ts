export type DocType = 'text' | 'image' | 'pdf';

export interface DocEntry {
  id: string;
  name: string;
  source: 'upload' | 'url';
  type: DocType;
  content: string; // text content or base64 data URL for images
  addedAt: number;
}

const STORAGE_KEY = 'doc-entries';

export function loadDocuments(): DocEntry[] {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (!saved) return [];
    const docs = JSON.parse(saved) as DocEntry[];
    // Migrate old entries without type
    return docs.map(d => ({ ...d, type: d.type || 'text' }));
  } catch {
    return [];
  }
}

export function saveDocuments(docs: DocEntry[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(docs));
  } catch (e: any) {
    if (e?.name === 'QuotaExceededError') {
      throw new Error('STORAGE_FULL');
    }
    throw e;
  }
}

export function addDocument(doc: Omit<DocEntry, 'id' | 'addedAt'>): DocEntry {
  const entry: DocEntry = {
    ...doc,
    id: crypto.randomUUID(),
    addedAt: Date.now(),
  };
  const docs = loadDocuments();
  docs.push(entry);
  saveDocuments(docs);
  return entry;
}

export function removeDocument(id: string) {
  const docs = loadDocuments().filter(d => d.id !== id);
  saveDocuments(docs);
}

function normalize(text: string): string[] {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 2);
}

function scoreDoc(content: string, queryTokens: string[]): number {
  if (queryTokens.length === 0) return 0;
  const haystack = content.toLowerCase();
  let score = 0;
  for (const token of queryTokens) {
    if (haystack.includes(token)) score += 1;
  }
  return score;
}

export function buildContextPrompt(docs: DocEntry[], question?: string): string {
  if (docs.length === 0) return '';

  const textDocs = docs.filter(d => d.type !== 'image');
  const imageDocs = docs.filter(d => d.type === 'image');
  const queryTokens = normalize(question || '');

  const rankedTextDocs = [...textDocs]
    .map(doc => ({ doc, score: scoreDoc(doc.content, queryTokens) }))
    .sort((a, b) => b.score - a.score);

  const selectedTextDocs = rankedTextDocs.some(x => x.score > 0)
    ? rankedTextDocs.filter(x => x.score > 0).slice(0, 8).map(x => x.doc)
    : rankedTextDocs.slice(0, 4).map(x => x.doc);

  const MAX_DOC_CHARS = 3000;
  const MAX_TOTAL_CHARS = 18000;
  let totalChars = 0;

  const textSections: string[] = [];
  for (const d of selectedTextDocs) {
    const snippet = d.content.slice(0, MAX_DOC_CHARS);
    if (totalChars + snippet.length > MAX_TOTAL_CHARS) break;
    totalChars += snippet.length;
    textSections.push(`--- Document: ${d.name} ---\n${snippet}`);
  }

  let combined = textSections.join('\n\n');

  if (imageDocs.length > 0) {
    combined += '\n\n--- Imagini disponibile ---\n';
    combined += imageDocs.map(d => `[Imagine: ${d.name}]`).join('\n');
    combined += '\nImaginile sunt atașate ca date vizuale în mesaj. Analizează-le și răspunde pe baza conținutului lor.';
  }

  return `Ești un asistent de documentație. Răspunde EXCLUSIV pe baza fragmentelor de documentație furnizate mai jos.

REGULI IMPORTANTE:
1. Răspunde în limba în care este pusă întrebarea.
2. Dacă informația NU se găsește în documentele furnizate, răspunde în limba română: "Această informație nu există în documentele furnizate."
3. NU folosi cunoștințe externe.
4. Dacă informația există în documente, oferă răspuns concret și complet.
5. Dacă sunt imagini atașate, descrie ce vezi în ele și folosește conținutul vizual în răspuns.

Documentație:
${combined}`;
}

/** Get base64 image data for sending to vision-capable LLMs */
export function getImageEntries(docs: DocEntry[]): { name: string; base64: string; mimeType: string }[] {
  return docs
    .filter(d => d.type === 'image')
    .map(d => {
      // content is a data URL like "data:image/png;base64,..."
      const match = d.content.match(/^data:(image\/[^;]+);base64,(.+)$/);
      if (match) {
        return { name: d.name, mimeType: match[1], base64: match[2] };
      }
      return { name: d.name, mimeType: 'image/png', base64: d.content };
    });
}
