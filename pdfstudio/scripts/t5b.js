(async()=>{
const app=window.app; const sleep=(m)=>new Promise(r=>setTimeout(r,m));
await app.openPaths(["C:\\Users\\virus\\P editor\\samples\\sample.pdf"]);
await sleep(800);
const log=[];
const st=async(l)=>{ const t=app.active; const txt=[]; for(let i=0;i<t.pages.length;i++){ const x=await t.getText(i); txt.push((x.text.match(/Page (\d)/)||['','-'])[1]+'/r'+t.pages[i].rotation);} log.push(l+': '+txt.join(' ')+' past='+t.past.length+' busy='+app.busy); };
await st('init');
await app.insertBlankAfter(0); await st('blank');
await app.reorder([4],0); await st('reorder');
await app.rotate([1],90); await st('rotate');
await app.undo(); await st('undo1');
await app.undo(); await st('undo2');
return log.join('\n');
})()
