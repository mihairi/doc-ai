/**
 * Feedback store – persists user ratings (thumbs up/down) on assistant answers
 * in IndexedDB so they can be injected into the system prompt as few-shot examples.
 */

export interface FeedbackEntry {
  id: string;
  question: string;
  answer: string;
  rating: 'good' | 'bad';
  comment?: string;
  createdAt: number;
}

const DB_NAME = 'docbot-feedback';
const DB_VERSION = 1;
const STORE_NAME = 'feedback';

function openFeedbackDB(): Promise<IDBDatabase> {
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

export async function saveFeedback(entry: FeedbackEntry): Promise<void> {
  const db = await openFeedbackDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(entry);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function loadAllFeedback(): Promise<FeedbackEntry[]> {
  const db = await openFeedbackDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).getAll();
    req.onsuccess = () => resolve(req.result as FeedbackEntry[]);
    req.onerror = () => reject(req.error);
  });
}

export async function deleteFeedback(id: string): Promise<void> {
  const db = await openFeedbackDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function clearAllFeedback(): Promise<void> {
  const db = await openFeedbackDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * Build a prompt section from stored feedback to guide the model.
 * Includes the most recent good and bad examples (max ~10 total).
 */
export async function buildFeedbackPrompt(): Promise<string> {
  const all = await loadAllFeedback();
  if (all.length === 0) return '';

  // Sort by newest first
  all.sort((a, b) => b.createdAt - a.createdAt);

  const good = all.filter(f => f.rating === 'good').slice(0, 5);
  const bad = all.filter(f => f.rating === 'bad').slice(0, 5);

  if (good.length === 0 && bad.length === 0) return '';

  let prompt = '\n\n--- FEEDBACK DIN CONVERSAȚII ANTERIOARE (folosește pentru a îmbunătăți calitatea răspunsurilor) ---\n';

  if (good.length > 0) {
    prompt += '\nExemple de răspunsuri BUNE (imită stilul și nivelul de detaliu):\n';
    good.forEach((f, i) => {
      prompt += `\n✅ Exemplu ${i + 1}:\nÎntrebare: ${f.question.slice(0, 200)}\nRăspuns bun: ${f.answer.slice(0, 500)}${f.comment ? `\nComentariu utilizator: ${f.comment.slice(0, 200)}` : ''}\n`;
    });
  }

  if (bad.length > 0) {
    prompt += '\nExemple de răspunsuri RELE (evită aceste tipuri de răspunsuri):\n';
    bad.forEach((f, i) => {
      prompt += `\n❌ Exemplu ${i + 1}:\nÎntrebare: ${f.question.slice(0, 200)}\nRăspuns de evitat: ${f.answer.slice(0, 500)}${f.comment ? `\nComentariu utilizator: ${f.comment.slice(0, 200)}` : ''}\n`;
    });
  }

  prompt += '\n--- SFÂRȘIT FEEDBACK ---\n';
  return prompt;
}
