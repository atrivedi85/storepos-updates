import * as esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';

const out = 'dist';
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(`${out}/main`, { recursive: true });
fs.mkdirSync(`${out}/renderer`, { recursive: true });

await esbuild.build({
  entryPoints: ['src/main/main.ts'], outfile: `${out}/main/main.js`,
  bundle: true, platform: 'node', target: 'node22', external: ['electron', 'electron-updater'], sourcemap: true,
});
await esbuild.build({
  entryPoints: ['src/main/preload.ts'], outfile: `${out}/main/preload.js`,
  bundle: true, platform: 'node', target: 'node22', external: ['electron'], format: 'cjs',
});
await esbuild.build({
  entryPoints: ['src/renderer/app.ts'], outfile: `${out}/renderer/app.js`,
  bundle: true, platform: 'browser', target: 'chrome130', format: 'esm', sourcemap: true,
  loader: { '.svg': 'text' },
});

fs.copyFileSync('src/renderer/index.html', `${out}/renderer/index.html`);
fs.copyFileSync('src/renderer/styles.css', `${out}/renderer/styles.css`);
const pj = 'node_modules/pdfjs-dist';
fs.copyFileSync(`${pj}/build/pdf.worker.min.mjs`, `${out}/renderer/pdf.worker.min.mjs`);
for (const d of ['cmaps', 'standard_fonts', 'wasm', 'iccs']) {
  if (fs.existsSync(`${pj}/${d}`)) fs.cpSync(`${pj}/${d}`, `${out}/renderer/${d}`, { recursive: true });
}
// ---- web build: same editor in a browser, served (behind login) by the Worker at /pdfstudio/app/ ----
const web = 'dist-web/app';
fs.rmSync('dist-web', { recursive: true, force: true });
fs.mkdirSync(web, { recursive: true });
await esbuild.build({
  entryPoints: ['src/web/entry.ts'], outfile: `${web}/app.js`,
  bundle: true, platform: 'browser', target: 'chrome130', format: 'esm', sourcemap: false, minify: true,
  loader: { '.svg': 'text' },
});
fs.copyFileSync('src/renderer/index.html', `${web}/index.html`);
fs.copyFileSync('src/renderer/styles.css', `${web}/styles.css`);
fs.copyFileSync(`${pj}/build/pdf.worker.min.mjs`, `${web}/pdf.worker.min.mjs`);
for (const d of ['cmaps', 'standard_fonts', 'wasm', 'iccs']) {
  if (fs.existsSync(`${pj}/${d}`)) fs.cpSync(`${pj}/${d}`, `${web}/${d}`, { recursive: true });
}
// public signing page (people sent a document to sign; no account): served by the Worker at /pdfstudio/s/<token>
fs.mkdirSync(`${web}/signer`, { recursive: true });
await esbuild.build({
  entryPoints: ['src/signer/signer.ts'], outfile: `${web}/signer/signer.js`,
  bundle: true, platform: 'browser', target: ['chrome110', 'safari16', 'firefox115'], format: 'esm', sourcemap: false, minify: true,
  loader: { '.svg': 'text' },
});
fs.copyFileSync('src/signer/index.html', `${web}/signer/index.html`);
fs.copyFileSync('src/signer/signer.css', `${web}/signer/signer.css`);
fs.writeFileSync(`${web}/version.json`, JSON.stringify({ version: JSON.parse(fs.readFileSync('package.json', 'utf8')).version }));
console.log('build ok');
