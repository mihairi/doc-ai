/**
 * Feedback store – persists user ratings (thumbs up/down) on assistant answers
 * on the companion Python server (.docbot-feedback.json).
 */

import { loadFileServerConfig } from './file-server';

export interface FeedbackEntry {
  id: string;
  question: string;
  answer: string;
  rating: 'good' | 'bad';
  comment?: string;
  createdAt: number;
}

export interface FeedbackPromptMessage {
  role: 'user' | 'assistant';
  content: string;
}

function getServerUrl(): string {
  const cfg = loadFileServerConfig();
  return cfg.url.replace(/\/+$/, '');
}

export async function saveFeedback(entry: FeedbackEntry): Promise<void> {
  const url = getServerUrl();
  const res = await fetch(`${url}/api/feedback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(entry),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Server error: ${res.status}`);
  }
}

export async function loadAllFeedback(): Promise<FeedbackEntry[]> {
  const url = getServerUrl();
  const res = await fetch(`${url}/api/feedback`, {
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`Server error: ${res.status}`);
  const data = await res.json();
  return (data.entries || []) as FeedbackEntry[];
}

export async function deleteFeedback(id: string): Promise<void> {
  const url = getServerUrl();
  const res = await fetch(`${url}/api/feedback/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Server error: ${res.status}`);
  }
}

export async function clearAllFeedback(): Promise<void> {
  const url = getServerUrl();
  const res = await fetch(`${url}/api/feedback/clear`, {
    method: 'DELETE',
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`Server error: ${res.status}`);
}

function compactText(value: string, maxChars: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxChars) return normalized;
  return normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd() + '…';
}

/**
 * Builds few-shot feedback messages injected immediately before the current user question.
 * Negative feedback is translated into explicit avoid/do rules, while positive feedback is
 * added as user/assistant example pairs. Entries are added one by one until the limit is hit.
 */
export async function buildFeedbackMessages(maxChars: number = 1500): Promise<FeedbackPromptMessage[]> {
  let all: FeedbackEntry[];
  try {
    all = await loadAllFeedback();
  } catch (err) {
    console.warn('[Feedback] Nu se poate încărca feedback-ul de pe server:', err);
    return [];
  }
  if (all.length === 0 || maxChars < 120) return [];

  all.sort((a, b) => b.createdAt - a.createdAt);

  const good = all.filter(f => f.rating === 'good').slice(0, 5);
  const bad = all.filter(f => f.rating === 'bad').slice(0, 5);

  const messages: FeedbackPromptMessage[] = [];
  let usedChars = 0;

  const tryAddPair = (userContent: string, assistantContent: string) => {
    const pairChars = userContent.length + assistantContent.length;
    if (usedChars + pairChars > maxChars) return false;
    messages.push(
      { role: 'user', content: userContent },
      { role: 'assistant', content: assistantContent }
    );
    usedChars += pairChars;
    return true;
  };

  for (const entry of bad) {
    const userContent = [
      '[FEEDBACK NEGATIV RECENT — APLICĂ LA RĂSPUNSUL URMĂTOR]',
      `Întrebare similară: ${compactText(entry.question, 180)}`,
      entry.comment
        ? `Corecție utilizator: ${compactText(entry.comment, 260)}`
        : 'Corecție utilizator: Evită tipul de răspuns marcat negativ și răspunde mai precis, strict pe cerință.',
    ].join('\n');

    const assistantContent = [
      'Am înțeles feedback-ul negativ.',
      'Voi evita tiparul de răspuns respins și voi respecta corecția utilizatorului pentru întrebări similare.',
      `Răspuns anterior de evitat: ${compactText(entry.answer, 220)}`,
    ].join('\n');

    if (!tryAddPair(userContent, assistantContent)) break;
  }

  for (const entry of good) {
    const userContent = [
      '[EXEMPLU DE ÎNTREBARE SIMILARĂ DIN FEEDBACK POZITIV]',
      compactText(entry.question, 220),
    ].join('\n');

    const assistantContent = [
      '[EXEMPLU DE RĂSPUNS BUN DE URMAT]',
      compactText(entry.answer, 420),
      entry.comment ? `Observație utilizator: ${compactText(entry.comment, 160)}` : '',
    ].filter(Boolean).join('\n');

    if (!tryAddPair(userContent, assistantContent)) break;
  }

  return messages;
}
