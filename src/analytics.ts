/**
 * Optional, strict opt-in website analytics.
 * Neither task text nor AI responses nor the private preview token are ever sent as events.
 * No third-party script or request is initiated before explicit visitor consent.
 */
export type AnalyticsConsent = 'accepted' | 'declined' | 'unset';
export type AnalyticsEvent = 'review_started' | 'review_completed' | 'review_failed' | 'example_loaded' | 'theme_changed';
export const CONSENT_STORAGE_KEY = 'issuelint.analytics-consent.v1';
const GA_ID = (import.meta.env?.VITE_GA4_MEASUREMENT_ID ?? '').trim();
const CLARITY_ID = (import.meta.env?.VITE_CLARITY_PROJECT_ID ?? '').trim();

export const analyticsConfigured = /^G-[A-Z0-9]{6,20}$/i.test(GA_ID) || /^[a-z0-9]{5,30}$/i.test(CLARITY_ID);
let loaded = false;

type SafeStorage = Pick<Storage, 'getItem' | 'setItem'>;
function storage(): SafeStorage | undefined {
  try { return window.localStorage; } catch { return undefined; }
}
export function readAnalyticsConsent(store: SafeStorage | undefined = storage()): AnalyticsConsent {
  try {
    const value = store?.getItem(CONSENT_STORAGE_KEY);
    return value === 'accepted' || value === 'declined' ? value : 'unset';
  } catch { return 'unset'; }
}
export function saveAnalyticsConsent(value: Exclude<AnalyticsConsent, 'unset'>, store: SafeStorage | undefined = storage()): void {
  try { store?.setItem(CONSENT_STORAGE_KEY, value); } catch { /* storage may be blocked */ }
}
function gtag(...args: unknown[]): void {
  const w = window as Window & { dataLayer?: unknown[] };
  w.dataLayer ??= [];
  w.dataLayer.push(args);
}
function loadScript(src: string): void {
  const script = document.createElement('script');
  script.async = true;
  script.src = src;
  script.referrerPolicy = 'strict-origin-when-cross-origin';
  document.head.appendChild(script);
}

export function enableAnalytics(): void {
  if (loaded || !analyticsConfigured || readAnalyticsConsent() !== 'accepted') return;
  loaded = true;
  if (/^G-[A-Z0-9]{6,20}$/i.test(GA_ID)) {
    // Basic consent mode: only initialize the tag AFTER opt-in.
    gtag('consent', 'default', {
      analytics_storage: 'denied', ad_storage: 'denied',
      ad_user_data: 'denied', ad_personalization: 'denied',
    });
    gtag('consent', 'update', { analytics_storage: 'granted' });
    gtag('js', new Date());
    gtag('config', GA_ID, {
      allow_google_signals: false,
      allow_ad_personalization_signals: false,
      send_page_view: true,
    });
    loadScript('https://www.googletagmanager.com/gtag/js?id=' + encodeURIComponent(GA_ID));
  }
  if (/^[a-z0-9]{5,30}$/i.test(CLARITY_ID)) {
    // Clarity recording is optional, and all form/result contents are masked in the DOM.
    const w = window as Window & { clarity?: (...args: unknown[]) => void };
    w.clarity = w.clarity || function (...args: unknown[]) {
      const fn = w.clarity as ((...args: unknown[]) => void) & { q?: unknown[][] };
      (fn.q ??= []).push(args);
    };
    loadScript('https://www.clarity.ms/tag/' + encodeURIComponent(CLARITY_ID));
    w.clarity('consentv2', {
      ad_Storage: 'denied',
      analytics_Storage: 'granted',
    });
  }
}

export function trackAnalyticsEvent(event: AnalyticsEvent): void {
  if (!loaded || readAnalyticsConsent() !== 'accepted') return;
  // Explicit event allowlist, no parameters or user data.
  gtag('event', event);
  const clarity = (window as Window & { clarity?: (name: string, event: string) => void }).clarity;
  clarity?.('event', event);
}
