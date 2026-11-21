/** In-flight reviews are bound to this page, not a background job. */
export function ReviewBrandAnimation() {
  return <span class="review-brand-animation" aria-hidden="true">
    <img class="review-brand-light" src="/brand/icon-light.webp" width="64" height="64" alt=""/>
    <img class="review-brand-dark" src="/brand/icon-dark.webp" width="64" height="64" alt=""/>
    <span class="review-brand-scan"/>
  </span>;
}
export function ReviewWaitGuidance() {
  return <div class="review-wait-guidance" aria-label="What you can do while waiting">
    <p><strong>Allow around 1–2 minutes</strong> depending on provider load. It can be faster or slower.</p>
    <p><span class="review-wait-yes" aria-hidden="true">✓</span> You can switch browser tabs or minimize this window. Keep the page open and your connection active.</p>
    <p><span class="review-wait-no" aria-hidden="true">✕</span> Don't refresh, close this tab, or navigate away. The request and result aren't saved for later recovery.</p>
  </div>;
}
