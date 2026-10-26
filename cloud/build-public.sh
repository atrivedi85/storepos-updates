#!/usr/bin/env bash
# Builds the website that ships with the Cloud Sync server (used by Cloudflare's Git build, root directory: cloud).
#   /       home page (cloud/site)
#   /pos/   Store POS back office (the POS screens + web-shim.js)
#   /v1/... Cloud Sync (the Worker itself)
set -e
cd "$(dirname "$0")"
rm -rf public && mkdir -p public/pos/lib
cp -r site/. public/
cp ../source/app/index.html ../source/app/web-shim.js ../source/app/android-shim.js ../source/app/package.json ../source/app/icon.png public/pos/
cp ../source/app/lib/pdf.js ../source/app/lib/pdf.worker.js public/pos/lib/
cp ../source/app/icon.png public/icon.png
printf 'User-agent: *\nAllow: /$\nDisallow: /pos/\nDisallow: /v1/\n' > public/robots.txt
echo "website ready: $(find public -type f | wc -l) files"
