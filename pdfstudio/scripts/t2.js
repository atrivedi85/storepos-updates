(async()=>{
const app=window.app;
await app.openPaths(["C:\\Users\\virus\\P editor\\samples\\sample.pdf"]);
await new Promise(r=>setTimeout(r,1200));
const pv=app.view.pages[0]; const ed=app.editor;
const U=(p)=>Math.random().toString(36).slice(2);
ed.addObj(pv,{id:U(),type:'markup',kind:'highlight',color:'#ffe14d',rects:[{x:72,y:92,w:230,h:18}]},true);
ed.addObj(pv,{id:U(),type:'shape',shape:'rect',x:300,y:300,w:150,h:80,l:[0,0,1,1],stroke:'#e5384f',fill:'',width:3},true);
ed.addObj(pv,{id:U(),type:'shape',shape:'arrow',x:320,y:420,w:120,h:60,l:[0,1,1,0],stroke:'#2f6bff',fill:'',width:3},true);
ed.addObj(pv,{id:U(),type:'note',x:480,y:120,w:26,h:26,text:'Hello note',color:'#ffd84d'},true);
ed.addObj(pv,{id:U(),type:'text',x:72,y:280,w:200,h:20,text:'New added text',size:16,color:'#0a7a3a',font:'times',bold:true,italic:false},true);
// edit existing text run
const pt=await app.active.getText(0);
const run=pt.runs.find(r=>r.str.includes('quick'));
await ed.editExistingRun(pv,run);
const e=pv.objLayer.querySelector('[contenteditable=true]'); e.textContent='The REPLACED sentence here.'; e.blur();
// form value
app.active.push(); app.active.formValues['name']='Jane Roe'; app.active.formValues['agree']=true;
ed.refresh();
const {bytes,warnings}=await window.__dbg.buildPdf(app.active); await window.api.writeFile('C:\\\\Users\\\\virus\\\\P editor\\\\samples\\\\out.pdf', bytes);
return 'objs='+JSON.stringify(Object.keys(app.active.objects))+' warn='+JSON.stringify(warnings);
})()

