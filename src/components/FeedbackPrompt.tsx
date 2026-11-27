import { createSignal, onCleanup, For, Show } from 'solid-js';
import { buildFeedbackPayload, MAX_FEEDBACK_NOTE, sendFeedback, type FeedbackRating } from '../feedback';

const choices: { value: FeedbackRating; label: string }[] = [
  { value: 'helpful', label: 'Helpful' },
  { value: 'meh', label: 'Meh' },
  { value: 'broken', label: 'Broken' },
];

/** Small, one-time card rendered only after the second successful lint. */
export function FeedbackPrompt(props: { sessionLintCount: number; onDone: () => void }) {
  const [rating, setRating] = createSignal<FeedbackRating | null>(null);
  const [note, setNote] = createSignal('');
  const [sending, setSending] = createSignal(false);
  const [thanks, setThanks] = createSignal(false);
  const [error, setError] = createSignal('');
  let dismissTimer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | undefined;
  onCleanup(() => { if (dismissTimer) clearTimeout(dismissTimer); controller?.abort(); });

  async function submit() {
    if (!rating() || sending() || thanks()) return;
    setError('');
    setSending(true);
    const active = new AbortController();
    controller = active;
    try {
      // Explicit allowlist: no ticket content, generated result, credentials or IP.
      const payload = buildFeedbackPayload(rating()!, note(), props.sessionLintCount);
      await sendFeedback(payload, active.signal);
      if (active.signal.aborted) return;
      setThanks(true);
      dismissTimer = setTimeout(() => props.onDone(), 1800);
    } catch {
      if (!active.signal.aborted) setError('Could not send. Try again or skip.');
    } finally {
      if (!active.signal.aborted) setSending(false);
    }
  }

  return <aside class="lint-feedback" aria-label="Feedback on IssueLint" data-clarity-mask="true">
    <Show when={!thanks()} fallback={<p class="lint-feedback-thanks" role="status">✓ Thanks for the feedback.</p>}>
      <div class="lint-feedback-header">
        <div>
          <h3>Was this lint useful?</h3>
          <p>A quick rating helps us improve IssueLint.</p>
        </div>
        <button class="lint-feedback-skip" type="button" onClick={props.onDone} aria-label="Skip feedback">Skip ×</button>
      </div>
      <div class="lint-feedback-options" role="group" aria-label="Rate your lint">
        <For each={choices}>{choice =>
          <button type="button" class="lint-feedback-choice"
            classList={{ selected: rating() === choice.value }}
            aria-pressed={rating() === choice.value} disabled={sending()}
            onClick={() => { setRating(choice.value); setError(''); }}>
            {choice.label}
          </button>
        }</For>
      </div>
      <label class="lint-feedback-note-label" for="lint-feedback-note">What was missing or broke? <span>(optional)</span></label>
      <input id="lint-feedback-note" class="lint-feedback-note" type="text" autocomplete="off"
        maxLength={MAX_FEEDBACK_NOTE} value={note()} disabled={sending()}
        placeholder="A short suggestion…" onInput={e => setNote(e.currentTarget.value)}/>
      <div class="lint-feedback-footer">
        <p>Only rating, note, lint count and time are sent. Don't include task text or personal data.</p>
        <button class="lint-feedback-send" type="button" disabled={!rating() || sending()}
          onClick={() => void submit()}>{sending() ? 'Sending…' : 'Send'}</button>
      </div>
      <Show when={error()}><p role="alert" class="lint-feedback-error">{error()}</p></Show>
    </Show>
  </aside>;
}
