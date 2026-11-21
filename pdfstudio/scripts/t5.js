(async()=>{
const app=window.app; const sleep=(m)=>new Promise(r=>setTimeout(r,m));
await app.openPaths(["C:\\Users\\virus\\P editor\\samples\\sample.pdf"]);
await sleep(800);
const log=[];
await app.insertBlankAfter(0); log.push('blank:'+app.active.pages.length);
await app.reorder([4],0); log.push('reorder first text:'+(await app.active.getText(0)).text.slice(0,25)+'|');
await app.rotate([1],90); log.push('rot:'+JSON.stringify(app.active.pages[1]));
await app.undo(); log.push('undo rot:'+JSON.stringify(app.active.pages[1]));
await app.undo(); await app.undo(); log.push('undo2 pages:'+app.active.pages.length);
await app.undo(true); await app.undo(true); await app.undo(true);
log.push('redo3 pages:'+app.active.pages.length+' rot1:'+app.active.pages[1].rotation);
// image on rotated page 1
const c=document.createElement('canvas'); c.width=80;c.height=40; const x=c.getContext('2d'); x.fillStyle='#19c3b1'; x.fillRect(0,0,80,40); x.fillStyle='#fff'; x.font='20px sans-serif'; x.fillText('IMG',10,28);
const blob=await new Promise(r=>c.toBlob(r,'image/png')); const bytes=new Uint8Array(await blob.arrayBuffer());
const a=await app.makeAsset(bytes);
await app.activate(app.active); await sleep(400);
const ed=app.editor; const pv=app.view.pages[1]; const U=()=>Math.random().toString(36).slice(2);
ed.addObj(pv,{id:U(),type:'image',x:50,y:50,w:160,h:80,asset:a.id},true);
ed.addObj(pv,{id:U(),type:'text',x:50,y:150,w:100,h:20,text:'Rotated page text',size:18,color:'#c00',font:'helv',bold:false,italic:false},true);
ed.addObj(pv,{id:U(),type:'field',kind:'text',name:'newfield',x:50,y:200,w:150,h:24,options:[],fontSize:12,multiline:false},true);
ed.addObj(pv,{id:U(),type:'field',kind:'dropdown',name:'dd1',x:50,y:240,w:150,h:24,options:['A','B'],fontSize:12,multiline:false},true);
ed.addObj(pv,{id:U(),type:'field',kind:'check',name:'cb1',x:50,y:280,w:18,h:18,options:[],fontSize:12,multiline:false},true);
const {bytes:out,warnings}=await window.__dbg.buildPdf(app.active); await window.api.writeFile('C:\\Users\\virus\\P editor\\samples\\out2.pdf', out);
log.push('warn:'+JSON.stringify(warnings));
return log.join('\n');
})()
