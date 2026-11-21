/** Temporary private-preview convenience. Never bundle a real access code into the app. */
export const PREVIEW_ACCESS_STORAGE_KEY = 'issuelint.preview-access.v1';

export type PreviewAccessStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function browserStorage(): PreviewAccessStore | undefined {
  try { return typeof window === 'undefined' ? undefined : window.localStorage; }
  catch { return undefined; }
}

/** Save only a code manually entered on this device; no server secret is exposed. */
export function readRememberedPreviewCode(store: PreviewAccessStore | undefined = browserStorage()): string {
  try {
    const code = store?.getItem(PREVIEW_ACCESS_STORAGE_KEY) ?? '';
    return code.length <= 256 ? code : '';
  } catch { return ''; }
}

export function rememberPreviewCode(value: string, store: PreviewAccessStore | undefined = browserStorage()): void {
  try {
    const code = value.trim();
    if (!code || code.length > 256) store?.removeItem(PREVIEW_ACCESS_STORAGE_KEY);
    else store?.setItem(PREVIEW_ACCESS_STORAGE_KEY, code);
  } catch { /* Storage can be disabled: manual entry still works. */ }
}

export function forgetPreviewCode(store: PreviewAccessStore | undefined = browserStorage()): void {
  try { store?.removeItem(PREVIEW_ACCESS_STORAGE_KEY); }
  catch { /* Storage can be disabled. */ }
}
