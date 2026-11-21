(async()=>{
const app=window.app, sleep=m=>new Promise(r=>setTimeout(r,m));
await app.openPaths(["C:\\Users\\virus\\P editor\\samples\\sample.pdf"]); await sleep(800);
const out=[];
for (const [kind,txt] of [['signature','Jane Roe'],['initials','JR']]) {
  const p=app.sign(kind); await sleep(300);
  [...document.querySelectorAll('.tabs2 button')].find(b=>b.textContent==='Type').click(); await sleep(100);
  const i=document.querySelector('.modal input[type=text]'); i.value=txt; i.dispatchEvent(new Event('input'));
  document.querySelector('.modal .btn.primary').click(); await p; await sleep(200);
  out.push(kind+': tool='+app.editor.tool+' repeat='+app.editor.pending?.repeat+' w='+Math.round(app.editor.pending.w));
  // place two copies
  const pv=app.view.pages[0], r=pv.el.getBoundingClientRect();
  for (const dx of [100,300]) { const ev=(t)=>new PointerEvent(t,{clientX:r.left+dx,clientY:r.top+(kind==='initials'?500:300),button:0,bubbles:true});
    pv.capLayer.dispatchEvent(ev('pointerdown')); window.dispatchEvent(ev('pointerup')); await sleep(100); }
  out.push('images='+app.active.objects[0].filter(o=>o.type==='image').length+' still placing='+(app.editor.tool==='place'));
  app.editor.setTool('select');
}
out.push('saved sigs='+localStorage.getItem('pdfstudio.signatures').length+' initials='+localStorage.getItem('pdfstudio.initials').length);
return out.join('\n');
})()
