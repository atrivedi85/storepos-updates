(async()=>{ const out=[]; const sleep=m=>new Promise(r=>setTimeout(r,m));
out.push('MID='+document.getElementById('lockMachine').textContent);
out.push('lock visible='+!document.getElementById('lock').classList.contains('hidden'));
try { await window.api.readFile('C:\\Users\\virus\\P editor\\samples\\sample.pdf'); out.push('READ ALLOWED (bad)'); } catch(e){ out.push('read blocked: '+String(e.message).slice(-40)); }
const r=await window.api.activate('PDFS-abc.def'); out.push('garbage key -> '+r.error);
return out.join('\n'); })()
