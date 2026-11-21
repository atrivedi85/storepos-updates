import { PDFDocument, StandardFonts, rgb, PDFName, PDFString } from 'pdf-lib';
import fs from 'node:fs';
const doc = await PDFDocument.create();
const f = await doc.embedFont(StandardFonts.TimesRomanItalic);
const p = doc.addPage([612, 792]);
p.drawText('Agreement. Please sign below.', { x: 72, y: 700, size: 16, font: await doc.embedFont(StandardFonts.Helvetica) });
p.drawLine({ start: { x: 72, y: 200 }, end: { x: 300, y: 200 }, thickness: 1 });
p.drawText('Old Signature', { x: 90, y: 210, size: 28, font: f, color: rgb(0, 0, 0.6) }); // baked into content
// a stamp/ink annotation signature as well
const ink = doc.context.register(doc.context.obj({ Type: 'Annot', Subtype: 'Ink', Rect: [320, 190, 500, 240], InkList: [[330, 200, 400, 235, 480, 195]], C: [0, 0, 0.8], BS: { W: 2 }, F: 4 }));
p.node.addAnnot(ink);
fs.writeFileSync('samples/signed.pdf', await doc.save());
console.log('made');
