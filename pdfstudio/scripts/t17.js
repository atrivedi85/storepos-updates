(async()=>{ const app=window.app, sleep=m=>new Promise(r=>setTimeout(r,m)); const out=[];
await app.openPaths(["C:\\Users\\virus\\P editor\\samples\\sample.pdf"]); await sleep(900);
const c=document.createElement('canvas'); c.width=200;c.height=70; const x=c.getContext('2d'); x.strokeStyle='#123'; x.lineWidth=5; x.beginPath(); x.moveTo(10,50); x.bezierCurveTo(60,0,100,90,190,20); x.stroke();
const blob=await new Promise(r=>c.toBlob(r)); const a=await app.makeAsset(new Uint8Array(await blob.arrayBuffer()));
app.startPlacing(a,170,false); await sleep(100);
const pv=app.view.pages[0], r=pv.el.getBoundingClientRect(), z=app.active.zoom;
const ev=(t,px,py,tgt)=>new PointerEvent(t,{clientX:r.left+px*z,clientY:r.top+py*z,button:0,bubbles:true});
pv.capLayer.dispatchEvent(ev('pointerdown',300,400)); window.dispatchEvent(ev('pointerup',300,400)); await sleep(300);
const o=()=>app.active.objects[0].find(q=>q.type==='image');
out.push('after place: tool='+app.editor.tool+' selected='+(app.editor.sel?.id===o().id)+' handles='+pv.objLayer.querySelectorAll('.handle').length+' x,y,w='+[o().x,o().y,o().w].map(Math.round));
const el=pv.objLayer.querySelector('.obj.image'); const b=el.getBoundingClientRect();
const mv=(t,cx,cy)=>new PointerEvent(t,{clientX:cx,clientY:cy,button:0,bubbles:true});
el.dispatchEvent(mv('pointerdown',b.left+30,b.top+20)); window.dispatchEvent(mv('pointermove',b.left+30+100,b.top+20+60)); window.dispatchEvent(mv('pointerup',b.left+130,b.top+80)); await sleep(300);
out.push('after drag: x,y='+[o().x,o().y].map(Math.round));
const h=pv.objLayer.querySelector('.handle[data-h=se]'); const hb=h.getBoundingClientRect();
h.dispatchEvent(mv('pointerdown',hb.left+5,hb.top+5)); window.dispatchEvent(mv('pointermove',hb.left+5+60*z,hb.top+5+20*z)); window.dispatchEvent(mv('pointerup',hb.left+5+60*z,hb.top+5+20*z)); await sleep(300);
out.push('after resize: w,h='+[o().w,o().h].map(Math.round));
return out.join('\n'); })()
