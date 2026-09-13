#!/usr/bin/env bash
# Fetch hireamino/amino-skills at the exact revision in .github/amino-skills.pin.
set -euo pipefail

PIN_FILE="${PIN_FILE:-.github/amino-skills.pin}"
DEST="${1:-.cache/amino-skills}"
REMOTE="${SKILLS_REMOTE:-https://github.com/hireamino/amino-skills.git}"

[ -f "$PIN_FILE" ] || { echo "::error::pin file not found: $PIN_FILE"; exit 1; }
pin=$(grep -v '^#' "$PIN_FILE" | tr -d '[:space:]')
[ -n "$pin" ] || { echo "::error::no revision in $PIN_FILE"; exit 1; }
case "$pin" in
  *[!0-9a-f]*) echo "::error::pin '$pin' is not lowercase hex"; exit 1 ;;
esac
[ "${#pin}" -eq 40 ] || { echo "::error::pin '$pin' must be a full 40-character SHA"; exit 1; }

case "$DEST" in
  ""|/|"$HOME") echo "::error::unsafe destination: $DEST"; exit 1 ;;
esac
rm -rf "$DEST"
mkdir -p "$DEST"
git -C "$DEST" init -q
git -C "$DEST" remote add origin "$REMOTE"
git -C "$DEST" fetch -q --depth 1 origin "$pin" || {
  echo "::error::could not fetch $pin from $REMOTE"; exit 1;
}
git -C "$DEST" checkout -q FETCH_HEAD
got=$(git -C "$DEST" rev-parse HEAD)
[ "$got" = "$pin" ] || { echo "::error::checked out $got, pin is $pin"; exit 1; }
echo "amino-skills pinned at $got"
