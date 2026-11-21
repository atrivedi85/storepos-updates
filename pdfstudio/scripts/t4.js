window.app.openPaths(["C:\\Users\\virus\\P editor\\samples\\out.pdf"]).then(()=>new Promise(r=>setTimeout(()=>r(JSON.stringify(window.app.active.formFields.map(f=>[f.name,f.value]))),1500)))
