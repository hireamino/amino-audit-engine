#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
SKILLS_DIR="${SKILLS_DIR:-$ROOT/.cache/amino-skills}"
BASELINE_DIR="${BASELINE_DIR:-$ROOT/.cache/amino-audit-action}"
ENGINE="$ROOT/src/engine.mjs"
BASELINE_ENGINE="${BASELINE_ENGINE:-$BASELINE_DIR/src/engine.mjs}"
PUBLIC_LICENSE="${PUBLIC_LICENSE:-$BASELINE_DIR/LICENSE}"

if [ ! -f "$SKILLS_DIR/conformance/run.mjs" ]; then
  "$ROOT/scripts/fetch-pinned-skills.sh" "$SKILLS_DIR"
fi
if [ ! -f "$BASELINE_ENGINE" ]; then
  "$ROOT/scripts/fetch-source-baseline.sh" "$BASELINE_DIR"
fi

BASELINE_ENGINE="$BASELINE_ENGINE" ENGINE="$ENGINE" PUBLIC_LICENSE="$PUBLIC_LICENSE" \
  node "$ROOT/test/provenance.mjs"

for surface in web action; do
  SURFACE="$surface" ENGINE="$ENGINE" node "$SKILLS_DIR/conformance/run.mjs"
  SURFACE="$surface" ENGINE="$ENGINE" RUNNER="$SKILLS_DIR/conformance/run.mjs" \
    EXPECT_FETCH_CALLS=0 node "$ROOT/test/network-observe.mjs"
  SURFACE="$surface" ENGINE="$ENGINE" node "$SKILLS_DIR/conformance/canary.mjs"
done

SKILLS_DIR="$SKILLS_DIR" RUNNER="$SKILLS_DIR/conformance/run.mjs" ENGINE="$ENGINE" \
  node "$ROOT/test/network-observe-canary.mjs"

PARITY_PY="$SKILLS_DIR/amino-deliverability-audit/skills/amino-deliverability-audit/scripts/audit.py" \
  PARITY_JS="$ENGINE" node "$SKILLS_DIR/web-parity/inventory.mjs"

SKILLS_DIR="$SKILLS_DIR" BASELINE_ENGINE="$BASELINE_ENGINE" ENGINE="$ENGINE" \
  node "$ROOT/test/equivalence.mjs"
SKILLS_DIR="$SKILLS_DIR" BASELINE_ENGINE="$BASELINE_ENGINE" ENGINE="$ENGINE" \
  node "$ROOT/test/default-adapters.mjs"
SKILLS_DIR="$SKILLS_DIR" BASELINE_ENGINE="$BASELINE_ENGINE" ENGINE="$ENGINE" \
  node "$ROOT/test/cache-lifetime-canary.mjs"
SKILLS_DIR="$SKILLS_DIR" RUNNER="$SKILLS_DIR/conformance/run.mjs" ENGINE="$ENGINE" \
  node "$ROOT/test/observation-canary.mjs"
BASELINE_ENGINE="$BASELINE_ENGINE" ENGINE="$ENGINE" \
  node "$ROOT/test/default-adapter-observation-canary.mjs"
SKILLS_DIR="$SKILLS_DIR" BASELINE_ENGINE="$BASELINE_ENGINE" ENGINE="$ENGINE" \
  node "$ROOT/test/boundary-canary.mjs"
node "$ROOT/test/ssrf.mjs"
ENGINE="$ENGINE" node "$ROOT/test/purity.mjs"

echo "ALL CONTRACT 1.2 GATES PASS"
