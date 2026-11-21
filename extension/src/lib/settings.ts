export type BackendMode = "quick_scan" | "analyze_v2" | "custom";

export interface Settings {
  mode: BackendMode;
  /** Base URL of an IssueLint deployment (used by quick_scan / analyze_v2). */
  serverUrl: string;
  /** Full endpoint URL for the custom clip-JSON backend. */
  apiUrl: string;
  /** IssueLint preview access code, or the custom backend's Bearer key. */
  apiKey: string;
  mockMode: boolean;
}

export const DEFAULT_SERVER_URL = "https://issuelint.com";

export const DEFAULT_SETTINGS: Settings = {
  mode: "quick_scan",
  serverUrl: DEFAULT_SERVER_URL,
  apiUrl: "",
  apiKey: "",
  mockMode: true,
};

export const MODE_LABELS: Record<BackendMode, string> = {
  quick_scan: "IssueLint · Quick Scan",
  analyze_v2: "IssueLint · Analyze v2 (Decision)",
  custom: "Custom endpoint",
};

export function isIssueLintMode(mode: BackendMode): mode is "quick_scan" | "analyze_v2" {
  return mode === "quick_scan" || mode === "analyze_v2";
}

function parseMode(value: unknown, legacyApiUrl: string): BackendMode {
  if (value === "quick_scan" || value === "analyze_v2" || value === "custom") return value;
  // Installs from before modes existed had only a custom API_URL.
  return legacyApiUrl ? "custom" : DEFAULT_SETTINGS.mode;
}

/**
 * Non-secret settings live in chrome.storage.sync so they follow the Chrome profile.
 * The access code / API key is kept in chrome.storage.local so it never leaves this device via Chrome Sync.
 */
export async function loadSettings(): Promise<Settings> {
  const [synced, local] = await Promise.all([
    chrome.storage.sync.get({
      MODE: null,
      SERVER_URL: DEFAULT_SETTINGS.serverUrl,
      API_URL: DEFAULT_SETTINGS.apiUrl,
      MOCK_MODE: DEFAULT_SETTINGS.mockMode,
    }),
    chrome.storage.local.get({ API_KEY: DEFAULT_SETTINGS.apiKey }),
  ]);
  const apiUrl = typeof synced.API_URL === "string" ? synced.API_URL : "";
  return {
    mode: parseMode(synced.MODE, apiUrl),
    serverUrl: typeof synced.SERVER_URL === "string" && synced.SERVER_URL ? synced.SERVER_URL : DEFAULT_SERVER_URL,
    apiUrl,
    mockMode: synced.MOCK_MODE !== false,
    apiKey: typeof local.API_KEY === "string" ? local.API_KEY : "",
  };
}

export async function saveSettings(next: Settings): Promise<void> {
  await Promise.all([
    chrome.storage.sync.set({
      MODE: next.mode,
      SERVER_URL: next.serverUrl.trim(),
      API_URL: next.apiUrl.trim(),
      MOCK_MODE: next.mockMode,
    }),
    next.apiKey.trim()
      ? chrome.storage.local.set({ API_KEY: next.apiKey.trim() })
      : chrome.storage.local.remove("API_KEY"),
  ]);
}
