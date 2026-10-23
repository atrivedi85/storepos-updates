#!/usr/bin/env python3
"""Make a small Store POS update file (.posupdate) from the app folder.
Usage: python3 build_update.py <app_dir> <out_dir> "release notes" [--with-data]"""
import sys, os, json, gzip, base64, hashlib
app, out, notes = sys.argv[1], sys.argv[2], sys.argv[3]
with_data = '--with-data' in sys.argv
ver = json.load(open(os.path.join(app, 'package.json')))['version']
names = ['package.json', 'main.js', 'preload.js', 'index.html', 'icon.png', 'icon.ico']
if with_data: names += ['first-run-data.json', 'first-run-history.jsonl.gz', 'first-run-history.jsonl.gz.count']
files = {}
for n in names:
    b = open(os.path.join(app, n), 'rb').read()
    files[n] = {'b64': base64.b64encode(b).decode(), 'sha256': hashlib.sha256(b).hexdigest()}
doc = {'format': 'storepos-update', 'version': ver, 'notes': notes, 'files': files}
path = os.path.join(out, f'StorePOS-Update-{ver}.posupdate')
raw = gzip.compress(json.dumps(doc).encode(), 9)
open(path, 'wb').write(raw)
man = {'version': ver, 'notes': notes, 'url': os.path.basename(path), 'sha256': hashlib.sha256(raw).hexdigest()}
json.dump(man, open(os.path.join(out, 'latest.json'), 'w'), indent=1)
print(path, len(raw), 'bytes')
