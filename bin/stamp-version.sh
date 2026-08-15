#!/bin/sh
# Stamp a new build version into index.html and version.json.
#
# Run this whenever index.html or anything in cms/ changes, BEFORE committing.
# The two values must match in a commit: index.html carries the build it was
# served as, version.json carries the build the server currently has, and the
# check in index.html reloads the page when they disagree.
#
# This is not a build step — it rewrites one string in two files. There is
# still no bundler and nothing is compiled.
#
#   ./bin/stamp-version.sh
#
set -eu

cd "$(dirname "$0")/.."

STAMP=$(date -u +%Y%m%d%H%M%S)

if ! grep -q "var BUILD = '" index.html; then
  echo "error: could not find the BUILD line in index.html" >&2
  exit 1
fi

# Matches the placeholder on first run and any previous stamp after that.
perl -0pi -e "s/var BUILD = '[^']*';/var BUILD = '$STAMP';/" index.html
printf '{ "v": "%s" }\n' "$STAMP" > version.json

INDEX_BUILD=$(grep -o "var BUILD = '[^']*'" index.html | sed "s/var BUILD = '//; s/'//")
JSON_BUILD=$(sed -n 's/.*"v": *"\([^"]*\)".*/\1/p' version.json)

if [ "$INDEX_BUILD" != "$JSON_BUILD" ]; then
  echo "error: stamps disagree — index.html=$INDEX_BUILD version.json=$JSON_BUILD" >&2
  exit 1
fi

echo "stamped $STAMP"
