import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import fs from 'node:fs';
const doc = await PDFDocument.create();
const f = await doc.embedFont(StandardFonts.Helvetica);
const fb = await doc.embedFont(StandardFonts.HelveticaBold);
for (let i = 1; i <= 4; i++) {
  const p = doc.addPage([612, 792]);
  p.drawText(`Sample Document - Page ${i}`, { x: 72, y: 700, size: 24, font: fb, color: rgb(0.1, 0.2, 0.5) });
  p.drawText('The quick brown fox jumps over the lazy dog.', { x: 72, y: 660, size: 14, font: f });
  p.drawText('PdfStudio test paragraph with searchable text.', { x: 72, y: 636, size: 12, font: f });
  p.drawRectangle({ x: 72, y: 400, width: 200, height: 100, color: rgb(0.9, 0.95, 1), borderColor: rgb(0.2, 0.4, 0.8) });
}
const form = doc.getForm();
const pg = doc.getPage(0);
pg.drawText('Name:', { x: 72, y: 570, size: 12, font: f });
const tf = form.createTextField('name'); tf.addToPage(pg, { x: 120, y: 560, width: 200, height: 22 });
pg.drawText('Agree:', { x: 72, y: 530, size: 12, font: f });
const cb = form.createCheckBox('agree'); cb.addToPage(pg, { x: 120, y: 525, width: 18, height: 18 });
pg.drawText('Color:', { x: 72, y: 495, size: 12, font: f });
const dd = form.createDropdown('color'); dd.addOptions(['Red', 'Green', 'Blue']); dd.addToPage(pg, { x: 120, y: 488, width: 120, height: 22 });
fs.writeFileSync('samples/sample.pdf', await doc.save());
console.log('ok');
