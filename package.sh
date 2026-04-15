#!/bin/bash
# CleanFeed — Build Chrome Web Store ZIP
# On Windows (Git Bash): bash package.sh
# Uses PowerShell's Compress-Archive (works on all Windows 10/11)

set -e

VERSION=$(grep '"version"' manifest.json | head -1 | sed 's/.*: *"\([^"]*\)".*/\1/')
OUTFILE="CleanFeed-v${VERSION}.zip"

echo "Packaging CleanFeed v${VERSION}..."

rm -f "$OUTFILE"

powershell -Command "
  Compress-Archive -Path \
    'manifest.json', \
    'background.js', \
    'content.js', \
    'content-dom.js', \
    'storage.js', \
    'popup.html', \
    'popup.js', \
    'options.html', \
    'options.js', \
    'styles', \
    'icons', \
    'lib', \
    '_locales' \
  -DestinationPath '$OUTFILE' -Force
"

SIZE=$(powershell -Command "(Get-Item '$OUTFILE').Length / 1KB")
echo ""
echo "Created: $OUTFILE (${SIZE} KB)"
echo ""
echo "Next: upload to https://chrome.google.com/webstore/devconsole"
