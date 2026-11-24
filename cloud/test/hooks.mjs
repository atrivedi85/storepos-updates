// Lets the real Worker code (which imports Cloudflare-only modules) run in plain Node for tests.
import { register } from 'node:module';
register('data:text/javascript,' + encodeURIComponent(`
export async function resolve(spec, ctx, next) {
  if (spec === 'cloudflare:workers') return { url: new URL('./stubs.mjs', ${JSON.stringify(import.meta.url)}).href, shortCircuit: true };
  if (spec === 'cloudflare:sockets') return { url: new URL('./sockets-stub.mjs', ${JSON.stringify(import.meta.url)}).href, shortCircuit: true };
  return next(spec, ctx);
}`), import.meta.url);
