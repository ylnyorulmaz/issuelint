/** Light/Dark appearance only. Legacy visual-theme settings remain archived, not applied. */
export type Appearance = 'light' | 'dark';
export const APPEARANCE_STORAGE_KEY = 'issuelint.appearance.v1';

export interface AppearanceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}
function browserStorage(): AppearanceStorage | undefined {
  try { return typeof window === 'undefined' ? undefined : window.localStorage; }
  catch { return undefined; }
}
function prefersDark(): boolean {
  try { return typeof window !== 'undefined' &&
    window.matchMedia?.('(prefers-color-scheme: dark)').matches === true; }
  catch { return false; }
}
/** Manual choice takes precedence; otherwise follow OS preference on first visit. */
export function readAppearance(
  storage: AppearanceStorage | undefined = browserStorage(),
  systemDark: boolean = prefersDark(),
): Appearance {
  try {
    const saved=storage?.getItem(APPEARANCE_STORAGE_KEY);
    if(saved==='dark'||saved==='light') return saved;
  } catch { /* private mode / blocked localStorage */ }
  return systemDark ? 'dark' : 'light';
}
export function saveAppearance(
  appearance: Appearance,
  storage: AppearanceStorage | undefined = browserStorage(),
): void {
  if(appearance!=='dark'&&appearance!=='light') return;
  try { storage?.setItem(APPEARANCE_STORAGE_KEY,appearance); }
  catch { /* private mode / blocked localStorage */ }
}
