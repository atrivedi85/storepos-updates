// Collects everything you need to upload to https://trivedipos.com/pdfstudio/ into the "upload" folder.
import fs from 'node:fs';
const v = JSON.parse(fs.readFileSync('package.json', 'utf8')).version;
const setup = `PdfStudio-Setup-${v}.exe`;
for (const f of [setup, `${setup}.blockmap`, 'latest.yml']) {
  if (!fs.existsSync(`release/${f}`)) { console.error(`Missing release/${f} - run "npm run dist" first.`); process.exit(1); }
}
fs.rmSync('upload', { recursive: true, force: true });
fs.mkdirSync('upload', { recursive: true });
for (const f of [setup, `${setup}.blockmap`, 'latest.yml']) fs.copyFileSync(`release/${f}`, `upload/${f}`);
const mb = (fs.statSync(`release/${setup}`).size / 1048576).toFixed(0);
// The /pdfstudio/ page (web version + download buttons) is now served by the Worker (worker/landing.js)
// and reads latest.yml, so no index.html needs uploading any more.
console.log(`Ready (${mb} MB installer): upload everything in the "upload" folder to the pdfstudio-downloads R2 bucket, latest.yml last.`);
