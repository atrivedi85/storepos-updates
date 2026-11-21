import adminHtml from './admin.html';
import joinHtml from './join.html';
import appLoginHtml from './app-login.html';
import { handleApi, authenticate } from './api.js';
import { landingHtml } from './landing.js';
import appsSwitcher from './apps-switcher.txt';

// Serves the PdfStudio installer + update files from R2 at trivedipos.com/pdfstudio/
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/pdfstudio/api/')) {
      try { return await handleApi(request, env, url); }
      catch (err) { return new Response(JSON.stringify({ error: 'Server error.' }), { status: 500, headers: { 'content-type': 'application/json' } }); }
    }
    // Web editor: every file under /pdfstudio/app/ needs a signed-in session. Signed-out visitors get the login page.
    if (url.pathname === '/pdfstudio/app') return Response.redirect(url.origin + '/pdfstudio/app/', 301);
    if (url.pathname.startsWith('/pdfstudio/app/')) {
      if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method not allowed', { status: 405 });
      let signedIn = null;
      try { signedIn = await authenticate(request, env, url); } catch { /* treat as signed out */ }
      if (!signedIn) {
        if (url.pathname !== '/pdfstudio/app/') return new Response('Sign in required', { status: 401, headers: { 'cache-control': 'no-store' } });
        return new Response(request.method === 'HEAD' ? null : appLoginHtml, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY' } });
      }
      const assetUrl = new URL(request.url);
      assetUrl.pathname = url.pathname.slice('/pdfstudio/app'.length) || '/';
      const res = await env.ASSETS.fetch(new Request(assetUrl, request));
      const out = new Response(res.body, res);
      // Only the big, never-changing data (fonts, cmaps, wasm, pdf.js worker) is cached; code and styles always revalidate so releases show up at once.
      const stable = /\/app\/(cmaps|standard_fonts|wasm|iccs)\//.test(url.pathname) || url.pathname.endsWith('/pdf.worker.min.mjs');
      out.headers.set('cache-control', stable ? 'private, max-age=86400' : 'private, no-cache');
      out.headers.set('x-frame-options', 'DENY');
      return out;
    }
    // Shared "Apps" button script that any app on trivedipos.com can include: <script src="/pdfstudio/apps.js" defer>
    if (url.pathname === '/pdfstudio/apps.js' && (request.method === 'GET' || request.method === 'HEAD')) {
      return new Response(request.method === 'HEAD' ? null : appsSwitcher, { headers: { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'public, max-age=300', 'x-content-type-options': 'nosniff' } });
    }
    const page = { '/pdfstudio/admin': adminHtml, '/pdfstudio/join': joinHtml }[url.pathname.replace(/\/$/, '')];
    if (page && (request.method === 'GET' || request.method === 'HEAD')) {
      return new Response(request.method === 'HEAD' ? null : page, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer' } });
    }
    if (url.pathname === '/pdfstudio') return Response.redirect(url.origin + '/pdfstudio/', 301);
    if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method not allowed', { status: 405 });
    // Landing page: web version or Windows download (replaces the static index.html in R2)
    if (url.pathname === '/pdfstudio/' || url.pathname === '/pdfstudio/index.html') {
      const html = await landingHtml(env);
      return new Response(request.method === 'HEAD' ? null : html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' } });
    }
    let key =decodeURIComponent(url.pathname.replace(/^\/pdfstudio\//, ''));
    if (key === '') key = 'index.html';
    if (key.includes('..')) return new Response('Bad request', { status: 400 });
    const range = request.headers.get('range');
    const obj = await env.BUCKET.get(key, range ? { range: request.headers } : undefined);
    if (!obj) return new Response('Not found', { status: 404 });
    const h = new Headers();
    obj.writeHttpMetadata(h);
    h.set('etag', obj.httpEtag);
    h.set('accept-ranges', 'bytes');
    // update metadata must never be cached, otherwise clients miss new releases
    h.set('cache-control', key === 'latest.yml' || key === 'index.html' ? 'no-cache' : 'public, max-age=86400');
    if (key.endsWith('.exe')) h.set('content-disposition', `attachment; filename="${key}"`);
    let status = 200;
    if (range && obj.range) {
      status = 206;
      const { offset = 0, length = obj.size - offset } = obj.range;
      h.set('content-range', `bytes ${offset}-${offset + length - 1}/${obj.size}`);
    }
    return new Response(request.method === 'HEAD' ? null : obj.body, { status, headers: h });
  },
};
