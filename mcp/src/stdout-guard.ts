/**
 * Imported first by index.ts. stdout carries JSON-RPC only, so route console.log/info/debug to stderr
 * before any other module (including dependencies) is evaluated.
 */
const toStderr = (...args: unknown[]) => console.error(...args);
console.log = toStderr;
console.info = toStderr;
console.debug = toStderr;
export {};
