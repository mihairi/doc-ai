export interface DocEntry {
  id: string;
  name: string;
  source: 'upload' | 'url';
  content: string;
  addedAt: number;
}

const STORAGE_KEY = 'doc-entries';

export function loadDocuments(): DocEntry[] {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved ? JSON.parse(saved) : [];
  } catch {
    return [];
  }
}

export function saveDocuments(docs: DocEntry[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(docs));
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
  const combined = docs.map(d => `--- Document: ${d.name} ---\n${d.content}`).join('\n\n');
  return `Ești un asistent de documentație. Trebuie să răspunzi EXCLUSIV pe baza documentației furnizate mai jos. Analizează cu atenție toate documentele și extrage orice informație relevantă, inclusiv text, date, tabele și descrieri de imagini.

REGULI IMPORTANTE:
1. Răspunde în limba în care este pusă întrebarea.
2. Dacă informația NU se găsește în documentele furnizate, răspunde în limba română: "Această informație nu există în documentele furnizate."
3. NU folosi cunoștințe externe. Răspunde DOAR din documentele de mai jos.
4. Oferă răspunsuri complete și detaliate, incluzând toate informațiile relevante găsite.
5. Dacă documentul conține referințe la imagini sau fișiere media, menționează-le în răspuns.

Documentație:\n${combined}`;
}
