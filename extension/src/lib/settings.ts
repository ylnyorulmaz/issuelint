import { checkApiUrl } from "./api-url.ts";

export interface Settings {
  apiUrl: string;
  apiKey: string;
  mockMode: boolean;
}

export const DEFAULT_SETTINGS: Settings = { apiUrl: "", apiKey: "", mockMode: true };

/**
 * API_URL and Mock mode live in chrome.storage.sync so they follow the user's Chrome profile.
 * API_KEY is kept in chrome.storage.local so the secret never leaves this device via Chrome Sync.
 */
export async function loadSettings(): Promise<Settings> {
  const [synced, local] = await Promise.all([
    chrome.storage.sync.get({ API_URL: DEFAULT_SETTINGS.apiUrl, MOCK_MODE: DEFAULT_SETTINGS.mockMode }),
    chrome.storage.local.get({ API_KEY: DEFAULT_SETTINGS.apiKey }),
  ]);
  return {
    apiUrl: typeof synced.API_URL === "string" ? synced.API_URL : "",
    mockMode: synced.MOCK_MODE !== false,
    apiKey: typeof local.API_KEY === "string" ? local.API_KEY : "",
  };
}

export async function saveSettings(next: Settings): Promise<void> {
  await Promise.all([
    chrome.storage.sync.set({ API_URL: next.apiUrl.trim(), MOCK_MODE: next.mockMode }),
    next.apiKey.trim()
      ? chrome.storage.local.set({ API_KEY: next.apiKey.trim() })
      : chrome.storage.local.remove("API_KEY"),
  ]);
}

export async function hasApiPermission(apiUrl: string): Promise<boolean> {
  const check = checkApiUrl(apiUrl);
  if (!check.ok) return false;
  return chrome.permissions.contains({ origins: [check.originPattern] });
}
