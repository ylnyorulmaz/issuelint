/** Pure validation for the configurable backend endpoint (no chrome.* usage, so it is unit-testable). */

export type ApiUrlCheck =
  | { ok: true; url: string; originPattern: string }
  | { ok: false; error: string };

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function checkApiUrl(raw: string): ApiUrlCheck {
  const value = raw.trim();
  if (!value) return { ok: false, error: "Enter the API endpoint URL." };
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, error: "That is not a valid URL." };
  }
  const local = LOCAL_HOSTS.has(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    return { ok: false, error: "Use https:// (plain http:// is allowed only for localhost)." };
  }
  if (url.username || url.password) {
    return { ok: false, error: "Do not put credentials in the URL; use the API key field." };
  }
  // Chrome match patterns ignore ports, so the pattern is scheme + host only.
  return { ok: true, url: url.toString(), originPattern: `${url.protocol}//${url.hostname}/*` };
}
