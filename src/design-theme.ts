/** Visual themes are presentation-only. Never persist task text or preview access. */
export type DesignTheme = 'constructivist' | 'neobrutalist';
export const DEFAULT_DESIGN_THEME: DesignTheme = 'constructivist';
export const DESIGN_THEME_STORAGE_KEY = 'issuelint.design-theme.v1';

export interface DesignThemeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function normalizeDesignTheme(value: unknown): DesignTheme {
  return value === 'neobrutalist' ? 'neobrutalist' : DEFAULT_DESIGN_THEME;
}

function browserStorage(): DesignThemeStorage | undefined {
  try { return typeof window !== 'undefined' ? window.localStorage : undefined; }
  catch { return undefined; }
}

export function readDesignTheme(storage: DesignThemeStorage | undefined = browserStorage()): DesignTheme {
  if (!storage) return DEFAULT_DESIGN_THEME;
  try { return normalizeDesignTheme(storage.getItem(DESIGN_THEME_STORAGE_KEY)); }
  catch { return DEFAULT_DESIGN_THEME; }
}

export function saveDesignTheme(theme: DesignTheme, storage: DesignThemeStorage | undefined = browserStorage()): void {
  if (!storage) return;
  try { storage.setItem(DESIGN_THEME_STORAGE_KEY, theme); }
  catch { /* restricted storage must not break a review */ }
}
