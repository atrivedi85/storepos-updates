(()=>{ const out=[]; window.__out=out; return Promise.race([new Promise(r=>setTimeout(()=>r('TIMEOUT '+out.join(' | ')),20000)), (async()=>{
const app=window.app, sleep=m=>new Promise(r=>setTimeout(r,m));
await app.openPaths(["C:\\Users\\virus\\P editor\\samples\\sample.pdf"]); await sleep(800);
localStorage.removeItem('pdfstudio.signatures');
const jc=document.createElement('canvas'); jc.width=600;jc.height=200; const x=jc.getContext('2d'); x.fillStyle='#fff'; x.fillRect(0,0,600,200); x.strokeStyle='#123'; x.lineWidth=6; x.beginPath(); x.moveTo(50,150); x.bezierCurveTo(150,0,250,250,400,60); x.stroke();
const jblob=await new Promise(r=>jc.toBlob(r,'image/jpeg',0.9));
const pdfBytes=await window.api.readFile("C:\\Users\\virus\\P editor\\samples\\sample.pdf");
for (const [name,file] of [['jpg',new File([jblob],'sig.jpg',{type:'image/jpeg'})],['pdf',new File([pdfBytes],'sig.pdf',{type:'application/pdf'})]]) {
  const p=app.sign('signature'); await sleep(300);
  [...document.querySelectorAll('.tabs2 button')].find(b=>b.textContent==='Upload').click(); await sleep(100);
  const fi=document.querySelector('.modal input[type=file]'); const dt=new DataTransfer(); dt.items.add(file); fi.files=dt.files; fi.dispatchEvent(new Event('change')); await sleep(1200);
  const img=document.querySelector('.modal .typed-preview img');
  out.push(name+': preview='+(img?img.naturalWidth+'x'+img.naturalHeight:'none'));
  if(name==='jpg') window.__shot1=1;
  document.querySelector('.modal .footer .btn.primary').click(); await p; await sleep(200);
  out.push(' pending='+JSON.stringify(app.editor.pending&&{w:Math.round(app.editor.pending.w),h:Math.round(app.editor.pending.h)}));
  app.editor.setTool('select');
}
out.push('saved count='+JSON.parse(localStorage.getItem('pdfstudio.signatures')).length);
return out.join('\n');
})()])})()

