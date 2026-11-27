/** Strict allowlist for voluntary feedback. Never import or read task content. */
export type FeedbackEvent = {
  rating: 'helpful' | 'meh' | 'broken';
  note?: string;
  sessionLintCount: number;
  timestamp: string;
};
const FIELDS = new Set(['rating', 'note', 'sessionLintCount', 'timestamp']);
const RATINGS = new Set(['helpful', 'meh', 'broken']);
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** Unknown keys (including title, description, task, IP) are rejected, not ignored. */
export function parseFeedbackEvent(value: unknown): FeedbackEvent | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const entry = value as Record<string, unknown>;
  if (Object.keys(entry).some(key => !FIELDS.has(key)) ||
      typeof entry.rating !== 'string' || !RATINGS.has(entry.rating) ||
      !Number.isSafeInteger(entry.sessionLintCount) ||
      (entry.sessionLintCount as number) < 1 || (entry.sessionLintCount as number) > 1_000_000 ||
      typeof entry.timestamp !== 'string' || !TIMESTAMP.test(entry.timestamp)) return null;
  const date = Date.parse(entry.timestamp);
  if (!Number.isFinite(date) || new Date(date).toISOString() !== entry.timestamp) return null;
  // Reject malformed clocks while tolerating up to one day of local clock skew.
  if (Math.abs(Date.now() - date) > 24 * 60 * 60 * 1000) return null;
  if (entry.note !== undefined &&
      (typeof entry.note !== 'string' || entry.note.length > 240 ||
        /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(entry.note))) return null;
  const note = typeof entry.note === 'string' ? entry.note.trim() : '';
  return {
    rating: entry.rating as FeedbackEvent['rating'],
    ...(note ? {note} : {}),
    sessionLintCount: entry.sessionLintCount as number,
    timestamp: entry.timestamp,
  };
}
