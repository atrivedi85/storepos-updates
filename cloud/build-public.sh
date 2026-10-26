#!/usr/bin/env bash
# Used by Cloudflare's "connect to GitHub" build (root directory: cloud) and by the GitHub workflow.
set -e
cd "$(dirname "$0")"
rm -rf public && mkdir -p public/lib
cp ../source/app/index.html ../source/app/web-shim.js ../source/app/android-shim.js ../source/app/package.json ../source/app/icon.png public/
cp ../source/app/lib/pdf.js ../source/app/lib/pdf.worker.js public/lib/
printf 'User-agent: *\nDisallow: /\n' > public/robots.txt
echo "web back office files ready: $(ls public | wc -l) files"
