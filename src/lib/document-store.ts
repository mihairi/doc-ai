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

export function buildContextPrompt(docs: DocEntry[]): string {
  if (docs.length === 0) return '';
  
  const textDocs = docs.filter(d => d.type !== 'image');
  const imageDocs = docs.filter(d => d.type === 'image');
  
  let combined = textDocs.map(d => `--- Document: ${d.name} ---\n${d.content}`).join('\n\n');
  
  if (imageDocs.length > 0) {
    combined += '\n\n--- Imagini disponibile ---\n';
    combined += imageDocs.map(d => `[Imagine: ${d.name}]`).join('\n');
    combined += '\nImaginile sunt atașate ca date vizuale în mesaj. Analizează-le și răspunde pe baza conținutului lor.';
  }

  return `Ești un asistent de documentație. Trebuie să răspunzi EXCLUSIV pe baza documentației furnizate mai jos. Analizează cu atenție toate documentele și extrage orice informație relevantă, inclusiv text, date, tabele și descrieri de imagini.

REGULI IMPORTANTE:
1. Răspunde în limba în care este pusă întrebarea.
2. Dacă informația NU se găsește în documentele furnizate, răspunde în limba română: "Această informație nu există în documentele furnizate."
3. NU folosi cunoștințe externe. Răspunde DOAR din documentele de mai jos.
4. Oferă răspunsuri complete și detaliate, incluzând toate informațiile relevante găsite.
5. Dacă sunt imagini atașate, descrie ce vezi în ele și răspunde pe baza conținutului vizual.

Documentație:\n${combined}`;
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
