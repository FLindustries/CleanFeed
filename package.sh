#!/bin/bash
# CleanFeed — Build Chrome Web Store ZIP
# On Windows (Git Bash): bash package.sh
# Uses Python's zipfile: entry names use forward slashes ("styles/content.css")
# as the zip format requires. PowerShell's Compress-Archive wrote backslashes.

set -e
cd "$(dirname "$0")"

VERSION=$(grep '"version"' manifest.json | head -1 | sed 's/.*: *"\([^"]*\)".*/\1/')
OUTFILE="CleanFeed-v${VERSION}.zip"

# Only these files and folders ship (never tests/, docs/, research/, ...)
FILES=(
  'manifest.json'
  'background.js'
  'features.js'
  'content.js'
  'content-dom.js'
  'storage.js'
  'popup.html'
  'popup.js'
  'options.html'
  'options.js'
  'strict-client.js'
  'styles'
  'icons'
  'lib'
  '_locales'
)

PYTHON=""
for cmd in python3 python py; do
  if "$cmd" -I -c "import zipfile" >/dev/null 2>&1; then PYTHON="$cmd"; break; fi
done
if [ -z "$PYTHON" ]; then
  echo "Python 3 not found: it is needed to build the zip."
  exit 1
fi

echo "Packaging CleanFeed v${VERSION}..."

rm -f "$OUTFILE"

# Folders are added recursively in sorted order, skipping OS junk files.
# Prints "<entries> files, <size> KB" (the size with a dot decimal).
SUMMARY=$("$PYTHON" -I -c '
import os, sys, zipfile
out, paths = sys.argv[1], sys.argv[2:]
junk = {"thumbs.db", "desktop.ini"}
files = []
for p in paths:
    if os.path.isfile(p):
        files.append(p)
    elif os.path.isdir(p):
        for root, dirs, names in os.walk(p):
            dirs[:] = sorted(d for d in dirs if not d.startswith("."))
            files += [os.path.join(root, n) for n in sorted(names)
                      if not n.startswith(".") and n.lower() not in junk]
    else:
        sys.exit("Missing file or folder: " + p)
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
    for f in files:
        z.write(f, "/".join(os.path.normpath(f).split(os.sep)))
print("%d files, %.1f KB" % (len(files), os.path.getsize(out) / 1024.0))
' "$OUTFILE" "${FILES[@]}")

echo ""
echo "Created: $OUTFILE (${SUMMARY})"
echo ""
echo "Next: upload to https://chrome.google.com/webstore/devconsole"
