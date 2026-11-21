(async()=>{
const app=window.app;
await app.openPaths(["C:\\Users\\virus\\P editor\\samples\\sample.pdf"]);
const p=await app.active.getPage(0);
const a=await p.getAnnotations();
return JSON.stringify(a.map(x=>({s:x.subtype,ft:x.fieldType,fn:x.fieldName,r:x.rect,cb:x.checkBox,combo:x.combo})));
})()
