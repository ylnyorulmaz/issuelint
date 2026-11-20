import { createSignal, onCleanup, onMount } from 'solid-js';

/** Review is one server request. Shown categories are not live backend steps. */
export function ReviewLoading(props: { onCancel: () => void }) {
  const [seconds, setSeconds] = createSignal(0);
  onMount(() => {
    const started = Date.now();
    const id = window.setInterval(() => setSeconds(Math.floor((Date.now() - started) / 1000)), 1000);
    onCleanup(() => window.clearInterval(id));
  });
  const formatted = () => Math.floor(seconds() / 60) + ':' + String(seconds() % 60).padStart(2, '0');
  return <div class="review-running" role="status" aria-label="AI task review in progress">
    <div class="review-running-head">
      <span class="review-spinner" aria-hidden="true"><span class="review-spinner-core"/></span>
      <div class="review-running-heading">
        <span class="kicker">AI REVIEW IN PROGRESS</span>
        <h2>Reviewing your task<span class="review-ellipsis" aria-hidden="true">...</span></h2>
      </div>
      <span class="review-running-timer" aria-hidden="true">{formatted()}</span>
    </div>
    <p class="review-running-copy">Reviewing your request against 11 quality checks to identify decisions needed before work begins.</p>
    <div class="review-running-checks" aria-label="Review focus areas">
      <span>01 <b>Clarity &amp; actionability</b></span>
      <span>02 <b>Scope &amp; behavior</b></span>
      <span>03 <b>Contradictions &amp; dependencies</b></span>
      <span>04 <b>Evidence &amp; suggested draft</b></span>
    </div>
    <div class="review-running-preview" aria-hidden="true">
      <div class="review-skeleton-head">
        <span class="review-skeleton-block review-skeleton-dot"/>
        <span class="review-skeleton-block review-skeleton-title"/>
      </div>
      <span class="review-skeleton-block review-skeleton-line"/>
      <span class="review-skeleton-block review-skeleton-line short"/>
      <div class="review-skeleton-separator"/>
      <div class="review-skeleton-head">
        <span class="review-skeleton-block review-skeleton-dot"/>
        <span class="review-skeleton-block review-skeleton-title medium"/>
      </div>
      <span class="review-skeleton-block review-skeleton-line medium"/>
      <span class="review-skeleton-block review-skeleton-line short"/>
    </div>
    <p class="review-running-note">These are review focus areas, not completed live stages. Results will replace these placeholders when the analysis finishes.</p>
    <button class="secondary-action review-running-cancel" type="button" onClick={props.onCancel}>Cancel review</button>
  </div>;
}
