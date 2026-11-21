(async()=>{ const app=window.app, sleep=m=>new Promise(r=>setTimeout(r,m)); const out=[];
await app.openPaths(["C:\\Users\\virus\\P editor\\samples\\signed.pdf"]); await sleep(1000);
const pv=app.view.pages[0], r=pv.el.getBoundingClientRect(), z=app.active.zoom;
app.editor.setTool('erase'); await sleep(100);
const ev=(t,x,y)=>new PointerEvent(t,{clientX:r.left+x*z,clientY:r.top+y*z,button:0,bubbles:true});
// erase box covers both signatures: page y from top = 792-250 .. 792-180 => 542..612
pv.capLayer.dispatchEvent(ev('pointerdown',80,540)); window.dispatchEvent(ev('pointermove',520,615)); window.dispatchEvent(ev('pointerup',520,615)); await sleep(300);
const o=app.active.objects[0]||[]; out.push('objects='+JSON.stringify(o.map(x=>({t:x.type,c:x.color,ra:x.removeAnnots,w:Math.round(x.w),h:Math.round(x.h)}))));
out.push('tool now='+app.editor.tool+' selected='+(app.editor.sel?'yes':'no'));
const {bytes,warnings}=await window.__dbg.buildPdf(app.active); out.push('warnings='+JSON.stringify(warnings));
await window.api.writeFile('C:\\Users\\virus\\P editor\\samples\\signed-out.pdf', bytes);
return out.join('\n'); })()
