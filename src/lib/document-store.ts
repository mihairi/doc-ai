export type DocType = 'text' | 'image' | 'pdf';

export interface DocEntry {
  id: string;
  name: string;
  source: 'upload' | 'url';
  type: DocType;
  content: string;
  addedAt: number;
}

const DB_NAME = 'docbot-db';
const DB_VERSION = 1;
const STORE_NAME = 'documents';

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function loadDocuments(): Promise<DocEntry[]> {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.getAll();
      req.onsuccess = () => {
        const docs = (req.result as DocEntry[]).map(d => ({ ...d, type: d.type || 'text' as DocType }));
        docs.sort((a, b) => a.addedAt - b.addedAt);
        resolve(docs);
      };
      req.onerror = () => reject(req.error);
    });
  } catch {
    return [];
  }
}

export async function addDocument(doc: Omit<DocEntry, 'id' | 'addedAt'>): Promise<DocEntry> {
  const entry: DocEntry = {
    ...doc,
    id: crypto.randomUUID(),
    addedAt: Date.now(),
  };
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const req = store.add(entry);
    req.onsuccess = () => resolve(entry);
    req.onerror = () => reject(req.error);
  });
}

export async function addDocuments(docs: Omit<DocEntry, 'id' | 'addedAt'>[]): Promise<number> {
  if (docs.length === 0) return 0;
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    let added = 0;
    for (const doc of docs) {
      const entry: DocEntry = { ...doc, id: crypto.randomUUID(), addedAt: Date.now() + added };
      const req = store.add(entry);
      req.onsuccess = () => { added++; };
    }
    tx.oncomplete = () => resolve(added);
    tx.onerror = () => reject(tx.error);
  });
}

export async function removeDocument(id: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const req = store.delete(id);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

export async function clearAllDocuments(): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const req = store.clear();
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

export async function getDocumentCount(): Promise<number> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const req = store.count();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// --- Migration from localStorage ---
const OLD_STORAGE_KEY = 'doc-entries';

export async function migrateFromLocalStorage(): Promise<number> {
  try {
    const saved = localStorage.getItem(OLD_STORAGE_KEY);
    if (!saved) return 0;
    const oldDocs = JSON.parse(saved) as DocEntry[];
    if (!oldDocs.length) return 0;
    
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      let migrated = 0;
      for (const doc of oldDocs) {
        const entry = { ...doc, type: doc.type || 'text' as DocType };
        const req = store.put(entry);
        req.onsuccess = () => { migrated++; };
      }
      tx.oncomplete = () => {
        localStorage.removeItem(OLD_STORAGE_KEY);
        resolve(migrated);
      };
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    return 0;
  }
}

// --- Retrieval / context building (unchanged logic, sync on provided docs) ---

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

  const MAX_DOC_CHARS = 2000;
  const MAX_TOTAL_CHARS = 6000;
  let totalChars = 0;

  const textSections: string[] = [];
  for (const d of selectedTextDocs) {
    const snippet = d.content.slice(0, MAX_DOC_CHARS);
    if (totalChars + snippet.length > MAX_TOTAL_CHARS) break;
    totalChars += snippet.length;
    const sourceInfo = d.source === 'url' ? `(sursă: ${d.name})` : `(document local: ${d.name})`;
    textSections.push(`--- Document: ${d.name} ${sourceInfo} ---\n${snippet}`);
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
6. La finalul fiecărui răspuns, adaugă o secțiune **📄 Surse:** care listează documentele/paginile folosite. Pentru fiecare sursă include:
   - Numele documentului sau titlul paginii web
   - Secțiunea relevantă (dacă este identificabilă din conținut)
   - Numărul paginii (dacă este disponibil în metadate)
   - Link funcțional (dacă sursa este un URL, folosește format Markdown: [titlu](url))
   - Pentru documente locale fără URL, menționează doar numele fișierului

Documentație:
${combined}`;
}

/** Get base64 image data for sending to vision-capable LLMs */
export function getImageEntries(docs: DocEntry[]): { name: string; base64: string; mimeType: string }[] {
  return docs
    .filter(d => d.type === 'image')
    .map(d => {
      const match = d.content.match(/^data:(image\/[^;]+);base64,(.+)$/);
      if (match) {
        return { name: d.name, mimeType: match[1], base64: match[2] };
      }
      return { name: d.name, mimeType: 'image/png', base64: d.content };
    });
}
