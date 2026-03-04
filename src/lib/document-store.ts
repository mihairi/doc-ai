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
  return `You are a documentation assistant. You MUST answer ONLY based on the following documentation. If the answer is not found in the documentation, say "I couldn't find this information in the loaded documentation." Do NOT use any outside knowledge.\n\nDocumentation:\n${combined}`;
}
