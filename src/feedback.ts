/** Low-friction feedback: no task input/result is ever read or serialized here. */
export type FeedbackRating = 'helpful' | 'meh' | 'broken';
export type FeedbackPayload = {
  rating: FeedbackRating;
  note?: string;
  sessionLintCount: number;
  timestamp: string;
};
type StoragePort = Pick<Storage, 'getItem' | 'setItem'>;
export const LINT_TOTAL_KEY = 'issuelint.feedback.totalLints.v1';
export const FEEDBACK_SEEN_KEY = 'issuelint.feedback.promptShown.v1';
export const SESSION_LINTS_KEY = 'issuelint.feedback.sessionLints.v1';
export const MAX_FEEDBACK_NOTE = 240;
const MAX_SAFE_LINTS = 1_000_000;

function browserStorage(kind: 'localStorage' | 'sessionStorage'): StoragePort | null {
  try { return typeof window !== 'undefined' ? window[kind] : null; } catch { return null; }
}
function countFrom(value: string | null): number {
  if (!value || !/^\d{1,7}$/.test(value)) return 0;
  const count = Number(value);
  return Number.isSafeInteger(count) && count >= 0 ? Math.min(count, MAX_SAFE_LINTS) : 0;
}

/** Call exactly once when a lint successfully completes. Errors/cancellations never count.
 * localStorage persists the total and "shown once" flag between reloads;
 * sessionStorage holds the count for this tab's browsing session.
 * If persistent storage is unavailable, fail closed rather than nag on every visit.
 */
export function recordCompletedLint(
  local: StoragePort | null = browserStorage('localStorage'),
  session: StoragePort | null = browserStorage('sessionStorage'),
): { showPrompt: boolean; sessionLintCount: number } {
  try {
    if (!local) return { showPrompt: false, sessionLintCount: 0 };
    const total = Math.min(MAX_SAFE_LINTS, countFrom(local.getItem(LINT_TOTAL_KEY)) + 1);
    const sessionCount = Math.min(MAX_SAFE_LINTS, countFrom(session?.getItem(SESSION_LINTS_KEY) ?? null) + 1);
    local.setItem(LINT_TOTAL_KEY, String(total));
    session?.setItem(SESSION_LINTS_KEY, String(sessionCount));
    const showPrompt = total === 2 && local.getItem(FEEDBACK_SEEN_KEY) !== 'shown';
    if (showPrompt) local.setItem(FEEDBACK_SEEN_KEY, 'shown');
    return { showPrompt, sessionLintCount: sessionCount };
  } catch {
    return { showPrompt: false, sessionLintCount: 0 };
  }
}

/** Construct payload explicitly. No spreading, ticket fields, preview code, or IP. */
export function buildFeedbackPayload(
  rating: FeedbackRating, note: string, sessionLintCount: number, at = new Date(),
): FeedbackPayload {
  if (!['helpful', 'meh', 'broken'].includes(rating)) throw new Error('Choose a rating.');
  if (!Number.isSafeInteger(sessionLintCount) || sessionLintCount < 1 || sessionLintCount > MAX_SAFE_LINTS)
    throw new Error('Invalid lint count.');
  const trimmed = note.trim();
  if (trimmed.length > MAX_FEEDBACK_NOTE || /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(trimmed))
    throw new Error('Note must be 240 characters or fewer.');
  return {
    rating,
    ...(trimmed ? { note: trimmed } : {}),
    sessionLintCount,
    timestamp: at.toISOString(),
  };
}

export async function sendFeedback(payload: FeedbackPayload, signal?: AbortSignal): Promise<void> {
  const response = await fetch('/api/feedback', {
    method: 'POST', cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload), signal,
  });
  if (!response.ok) throw new Error('Feedback could not be sent.');
}
