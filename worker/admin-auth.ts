/** Separate admin authentication. No passwords or session secrets are ever sent to the client.
 * Login requires the Cloudflare Workers rate-limit binding; missing configuration fails closed.
 */
export interface AdminEnv {
  ADMIN_USERNAME?: string;
  ADMIN_PASSWORD_HASH?: string; // pbkdf2-sha256$600000$base64url(salt)$base64url(32-byte derived key)
  ADMIN_SESSION_SECRET?: string; // base64url(32+ random bytes)
  ADMIN_LOGIN_RATE_LIMIT?: { limit(input: { key: string }): Promise<{ success: boolean }> };
}
const COOKIE = "__Host-issuelint_admin";
const MAX_AGE_SECONDS = 8 * 60 * 60;
const UTF8 = new TextEncoder();
const HASH_RE = /^pbkdf2-sha256\$(\d+)\$([A-Za-z0-9_-]{16,})\$([A-Za-z0-9_-]{40,})$/;

function decode64(s: string): Uint8Array {
  const raw = atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "="));
  return Uint8Array.from(raw, c => c.charCodeAt(0));
}
function encode64(b: Uint8Array): string {
  let result = "";
  for (const byte of b) result += String.fromCharCode(byte);
  return btoa(result).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
function hashConfig(secret: string | undefined): { iterations: number; salt: Uint8Array; expected: Uint8Array } | null {
  const match = HASH_RE.exec(secret ?? "");
  if (!match) return null;
  const iterations = Number(match[1]);
  if (iterations < 600_000 || iterations > 1_500_000) return null;
  try {
    const salt = decode64(match[2]);
    const expected = decode64(match[3]);
    return salt.length >= 16 && salt.length <= 32 && expected.length === 32 ? { iterations, salt, expected } : null;
  } catch { return null; }
}
export function adminConfigured(env: AdminEnv): boolean {
  if (!env.ADMIN_USERNAME || env.ADMIN_USERNAME.trim() !== env.ADMIN_USERNAME ||
      !/^[a-zA-Z][\w.-]{2,79}$/.test(env.ADMIN_USERNAME) ||
      !hashConfig(env.ADMIN_PASSWORD_HASH) || !env.ADMIN_LOGIN_RATE_LIMIT) return false;
  try { return decode64(env.ADMIN_SESSION_SECRET ?? "").length >= 32; }
  catch { return false; }
}
function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
export async function checkPassword(username: string, password: string, env: AdminEnv): Promise<boolean> {
  const parsed = hashConfig(env.ADMIN_PASSWORD_HASH);
  if (!parsed || !env.ADMIN_USERNAME || password.length > 256 || !password.length || username.length > 80) return false;
  // Always derive the password even if the username is wrong to avoid an easy username oracle.
  const key = await crypto.subtle.importKey("raw", UTF8.encode(password), "PBKDF2", false, ["deriveBits"]);
  const derived = new Uint8Array(await crypto.subtle.deriveBits({
    name: "PBKDF2", hash: "SHA-256", salt: new Uint8Array(parsed.salt), iterations: parsed.iterations
  }, key, 256));
  const a = new Uint8Array(await crypto.subtle.digest("SHA-256", UTF8.encode(username)));
  const b = new Uint8Array(await crypto.subtle.digest("SHA-256", UTF8.encode(env.ADMIN_USERNAME)));
  return equalBytes(a, b) && equalBytes(derived, parsed.expected);
}
async function hmacKey(env: AdminEnv): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", new Uint8Array(decode64(env.ADMIN_SESSION_SECRET!)), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}
function cookieValue(request: Request): string {
  const pairs = (request.headers.get("Cookie") ?? "").split(";").map(x => x.trim());
  const pair = pairs.find(x => x.startsWith(COOKIE + "="));
  return pair ? pair.slice(COOKIE.length + 1) : "";
}
export async function adminSession(request: Request, env: AdminEnv): Promise<boolean> {
  if (!adminConfigured(env)) return false;
  const value = cookieValue(request);
  const match = /^(v1\.\d{10,12}\.[A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})$/.exec(value);
  if (!match) return false;
  const expiry = Number(match[1].split(".")[1]);
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isSafeInteger(expiry) || expiry < now || expiry > now + MAX_AGE_SECONDS) return false;
  try {
    return await crypto.subtle.verify("HMAC", await hmacKey(env), new Uint8Array(decode64(match[2])), UTF8.encode(match[1]));
  } catch { return false; }
}
export async function issueAdminSession(env: AdminEnv): Promise<string> {
  const expiry = Math.floor(Date.now() / 1000) + MAX_AGE_SECONDS;
  const nonce = encode64(crypto.getRandomValues(new Uint8Array(16)));
  const payload = `v1.${expiry}.${nonce}`;
  const signature = encode64(new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(env), UTF8.encode(payload))));
  return `${COOKIE}=${payload}.${signature}; Path=/; Max-Age=${MAX_AGE_SECONDS}; HttpOnly; Secure; SameSite=Strict`;
}
export const clearAdminSession = `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`;

export function sameOriginPost(request: Request): boolean {
  if (request.method !== "POST") return false;
  const url = new URL(request.url);
  const origin = request.headers.get("Origin");
  if (!origin || origin !== url.origin) return false;
  const site = request.headers.get("Sec-Fetch-Site");
  return !site || site === "same-origin";
}
export const ADMIN_RESPONSE_HEADERS: Record<string, string> = {
  "Cache-Control": "no-store, private",
  "X-Robots-Tag": "noindex, nofollow, noarchive",
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Resource-Policy": "same-origin",
};
export function adminPage(html: string, status = 200): Response {
  return new Response(html, {
    status,
    headers: { ...ADMIN_RESPONSE_HEADERS, "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": "default-src 'none'; img-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'" }
  });
}
export const loginPage = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<meta name="robots" content="noindex,nofollow,noarchive"/><title>Admin Sign In | IssueLint</title>
<link rel="icon" href="/brand/favicon.png"/><link rel="stylesheet" href="/admin-login.css"/></head>
<body><main class="login-wrap"><div class="login-card">
<a href="/" class="login-brand"><img src="/brand/logo-light.webp" alt="IssueLint" width="180" height="35"/></a>
<p class="login-kicker">INTERNAL ACCESS / ISSUE/LINT</p><h1>Admin sign in</h1>
<p class="login-description">Sign in to the private evaluation station.</p>
<form id="admin-login" method="post" action="/api/admin/login">
<label for="username">Username</label><input id="username" name="username" type="text" autocomplete="username" minlength="3" maxlength="80" required/>
<label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required/>
<p id="login-message" class="login-message" role="alert" aria-live="polite"></p>
<button id="login-submit" type="submit">Sign in</button>
</form><a class="login-back" href="/">← Back to IssueLint</a></div></main>
<script src="/admin-login.js" defer></script></body></html>`;
export const unconfiguredPage = `<!doctype html><html lang="en"><head><meta name="robots" content="noindex,nofollow,noarchive"/><title>Admin unavailable | IssueLint</title></head><body><main><h1>Admin unavailable</h1><p>Administrator credentials or rate limiting are not configured on this deployment.</p></main></body></html>`;
