/**
 * Builds a single-module Cloudflare Worker from the same Vite outputs deployed
 * by `cf`. Useful when direct Static Assets upload is unavailable.
 *
 * Temporary delivery format: inline HTML/CSS/JS in one Worker response.
 * Prefer native Workers Static Assets when uploading via cf becomes available.
 */
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const base = resolve('.cloudflare/output/v1/workers/default');
const read = relative => readFileSync(resolve(base, relative), 'utf8');
let html = read('assets/index.html');
const scriptMatch = html.match(/<script[^>]+src="(\/assets\/[^"]+\.js)"[^>]*><\/script>/);
const styleMatch = html.match(/<link[^>]+href="(\/assets\/[^"]+\.css)"[^>]*>/);
if (!scriptMatch || !styleMatch) throw new Error('Vite asset template changed; inline build refused');
const js = read('assets' + scriptMatch[1]).replace(/<\/script/gi, '<\\/script');
const css = read('assets' + styleMatch[1]).replace(/<\/style/gi, '<\\/style');
html = html.replace(scriptMatch[0], '<script type="module">' + js + '</script>')
  .replace(styleMatch[0], '<style>' + css + '</style>');
if (html.includes('src="/assets/') || html.includes('href="/assets/')) {
  throw new Error('Unresolved asset URLs: refusing to deploy a broken page');
}
let worker = read('bundle/index.js').replace(/export\s*\{\s*workerEntry as default\s*\};/, '');
if (worker.includes('workerEntry as default')) throw new Error('Vite Worker export changed');
worker = worker.replace(/\/\/# sourceMappingURL=.*$/gm, '');
worker += '\nconst SITE_HTML=' + JSON.stringify(html) + ';\n';
worker += `export default {
  async fetch(request,env,ctx){
    const pathname=new URL(request.url).pathname;
    if(pathname.startsWith('/api/')) return workerEntry.fetch(request,env,ctx);
    if((request.method==='GET'||request.method==='HEAD')&&(pathname==='/'||pathname==='/index.html')){
      return new Response(request.method==='HEAD'?null:SITE_HTML,{headers:{
        'Content-Type':'text/html; charset=utf-8',
        'Cache-Control':'public, max-age=300',
        'X-Content-Type-Options':'nosniff'
      }});
    }
    return new Response('Not Found',{status:404});
  }
};\n`;
mkdirSync('deploy-inline', { recursive: true });
writeFileSync('deploy-inline/index.js', worker);
console.log('Standalone Worker written: deploy-inline/index.js (' + worker.length + ' characters)');
