#!/usr/bin/env bash
# Fetch the immutable Action revision from which the canonical engine was extracted.
set -euo pipefail

DEST="${1:-.cache/amino-audit-action}"
REMOTE="${ACTION_REMOTE:-https://github.com/hireamino/amino-audit-action.git}"
SOURCE_SHA="ae04a363f76da800ac6d98a3647cf5bf5ab7e44a"

case "$DEST" in
  ""|/|"$HOME") echo "::error::unsafe destination: $DEST"; exit 1 ;;
esac
rm -rf "$DEST"
mkdir -p "$DEST"
git -C "$DEST" init -q
git -C "$DEST" remote add origin "$REMOTE"
git -C "$DEST" fetch -q --depth 1 origin "$SOURCE_SHA" || {
  echo "::error::could not fetch $SOURCE_SHA from $REMOTE"; exit 1;
}
git -C "$DEST" checkout -q FETCH_HEAD
got=$(git -C "$DEST" rev-parse HEAD)
[ "$got" = "$SOURCE_SHA" ] || { echo "::error::checked out $got, source is $SOURCE_SHA"; exit 1; }
echo "source baseline pinned at $got"
