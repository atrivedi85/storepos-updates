window.app.openPaths(["C:\\Users\\virus\\P editor\\samples\\sample.pdf"]).then(()=>new Promise(r=>setTimeout(()=>r("opened "+window.app.tabs.length),1500)))
