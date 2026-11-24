// Landing page for trivedipos.com/pdfstudio/ : choose the web version or the Windows download.
// The download button reads latest.yml from R2, so it always points at the newest installer.
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function latestInstaller(env) {
  try {
    const obj = await env.BUCKET.get('latest.yml');
    if (!obj) return null;
    const yml = await obj.text();
    const version = (yml.match(/^version:\s*(\S+)/m) || [])[1];
    const file = (yml.match(/^path:\s*(\S+)/m) || [])[1];
    const size = Number((yml.match(/^\s*size:\s*(\d+)/m) || [])[1]) || 0;
    if (!version || !file || /[\\/]|\.\./.test(file)) return null;
    return { version, file, mb: size ? Math.round(size / 1048576) : 0 };
  } catch { return null; }
}

export async function landingHtml(env) {
  const dl = await latestInstaller(env);
  const download = dl
    ? `<a class="b alt" href="${esc(encodeURIComponent(dl.file))}">Download for Windows</a><small>Version ${esc(dl.version)}${dl.mb ? `, ${dl.mb} MB` : ''} &middot; Windows 10/11, 64-bit</small>`
    : `<span class="b off">Download unavailable</span><small>Please try again later.</small>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>PdfStudio</title>
<style>
:root{--bg:#171a26;--card:#1f2335;--line:#333a57;--fg:#e6e9f5;--mut:#98a0c0}
@media (prefers-color-scheme:light){:root{--bg:#f3f4fa;--card:#fff;--line:#d9dcec;--fg:#1f2430;--mut:#5b6280}}
*{box-sizing:border-box}body{font-family:Segoe UI,system-ui,sans-serif;background:var(--bg);color:var(--fg);margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:16px}
.w{max-width:820px;width:100%;text-align:center}h1{margin:10px 0 4px;font-size:30px}.lead{color:var(--mut);margin:0 0 26px;line-height:1.5}
.g{display:grid;grid-template-columns:1fr 1fr;gap:16px}@media(max-width:640px){.g{grid-template-columns:1fr}}
.c{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:26px 22px;display:flex;flex-direction:column;align-items:center;gap:8px}
.c h2{margin:0;font-size:19px}.c p{color:var(--mut);line-height:1.5;margin:0 0 8px;flex:1}
a.b,.b{display:inline-block;padding:12px 26px;border-radius:10px;background:linear-gradient(135deg,#7c5cff,#5b7cff);color:#fff;text-decoration:none;font-weight:600}
a.b.alt{background:linear-gradient(135deg,#19a89a,#1f8fd0)}.b.off{background:var(--line);color:var(--mut)}
small{color:var(--mut)}.foot{margin-top:22px;color:var(--mut);font-size:13px;line-height:1.6}
</style></head><body><main class="w">
<svg viewBox="0 0 64 64" width="64" height="64"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#7c5cff"/><stop offset="1" stop-color="#19c3b1"/></linearGradient></defs><rect width="64" height="64" rx="15" fill="url(#g)"/><path d="M19 12h17l11 11v29a3 3 0 0 1-3 3H19a3 3 0 0 1-3-3V15a3 3 0 0 1 3-3z" fill="#fff" fill-opacity=".95"/><path d="M36 12l11 11H39a3 3 0 0 1-3-3z" fill="#c9bfff"/><path d="M24 46V29h8.5a5.2 5.2 0 0 1 0 10.4H24" fill="none" stroke="#5b3df0" stroke-width="3.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
<h1>PdfStudio</h1><p class="lead">View, annotate, edit, sign and organize PDFs. Use it in your browser or install it on your PC.</p>
<div class="g">
<section class="c"><h2>Use in your browser</h2><p>Nothing to install. Sign in and start editing on any computer. Your cloud files are always there.</p><a class="b" href="/pdfstudio/app/">Open web version</a><small>Chrome or Edge recommended</small></section>
<section class="c"><h2>Windows desktop app</h2><p>Works offline, with local files and your cloud library syncing when you're online.</p>${download}</section>
</div>
<p class="foot"><a href="/" style="color:inherit">&larr; Back to all apps</a></p>
<p class="foot">PdfStudio uses your Ledger Desk account. Sign in with your Ledger Desk username and password. Need an account? Ask the owner.</p>
</main><script src="/pdfstudio/apps.js" defer></script><script src="/account-bar.js" defer></script></body></html>`;
}
