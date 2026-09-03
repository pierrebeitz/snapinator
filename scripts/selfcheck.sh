#!/usr/bin/env bash
#
# Drive the whole loop against the real pipeline: seed a baseline, break a
# component, prove the change is caught, approve part of it, approve the rest,
# prove the suite goes quiet again.
#
# Runs against a throwaway manifest and store, so the committed baseline is
# never touched.
set -euo pipefail
cd "$(dirname "$0")/.."

work=".snapinator/selfcheck"
export SNAPINATOR_MANIFEST="${work}/manifest.json"
export SNAPINATOR_STORE="${work}/store"

restore() { git checkout -- src/components/Button.jsx 2>/dev/null || true; }
trap restore EXIT

rm -rf "$work" && mkdir -p "$work"
git diff --quiet src/components/Button.jsx || { echo "✗ Button.jsx has uncommitted edits; commit or stash first."; exit 1; }

fail() { echo "✗ $1"; exit 1; }
# Neither `node -p` nor `console.log` is safe here: both pretty-print, and on a
# TTY that means ANSI colour codes wrapped around the value. Every one of these
# gets string-compared, so write the raw bytes.
emit() { node -e "process.stdout.write(String($1))"; }
count() { emit "require('./${work}/run.json').$1.length"; }
manifest_size() { emit "Object.keys(require('./${SNAPINATOR_MANIFEST}')).length"; }

yarn build-storybook >/dev/null 2>&1

echo "1. seed the baseline"
node scripts/snap.mjs --accept >/dev/null
[[ $(manifest_size) == 8 ]] || fail "expected 8 stories in the manifest"

echo "2. a clean run is silent and exits 0"
node scripts/snap.mjs >/dev/null || fail "unchanged suite should exit 0"

echo "3. recolour the button"
# Swap for a colour that is definitely not the current one. Hard-coding the
# "from" value made this silently pass on any branch that had already changed it.
node -e "
  const fs = require('fs'), file = 'src/components/Button.jsx';
  const src = fs.readFileSync(file, 'utf8');
  const [, current] = src.match(/primary: \{ background: '(#[0-9a-f]{6})'/);
  const next = current === '#7c3aed' ? '#2f855a' : '#7c3aed';
  fs.writeFileSync(file, src.replace(current, next));
"
yarn build-storybook >/dev/null 2>&1

echo "4. the change is caught, and so is its blast radius"
node scripts/snap.mjs >/dev/null && fail "changed suite should exit 1"
cp .snapinator/run/report/summary.json "${work}/run.json"
[[ $(count changed) == 3 ]] || fail "expected 3 changed stories (button + the two cards that render it), got $(count changed)"
run=$(emit "require('./${work}/run.json').runId")

echo "5. approving one story moves exactly one hash"
node scripts/accept.mjs "$run" button--primary >/dev/null
node scripts/snap.mjs >/dev/null && fail "two stories are still unreviewed; should exit 1"

echo "6. an unknown story id is refused"
node scripts/accept.mjs "$run" not--a--story >/dev/null 2>&1 && fail "unknown story id should be refused"

echo "7. approving the rest makes the suite quiet again"
node scripts/accept.mjs "$run" >/dev/null
node scripts/snap.mjs >/dev/null || fail "everything is approved; should exit 0"

echo "8. nothing was re-uploaded that already existed"
blobs=$(find "${SNAPINATOR_STORE}/img" -name '*.png' | wc -l | tr -d ' ')
[[ "$blobs" == 14 ]] || fail "expected 14 blobs (8 baseline + 3 changed + 3 diffs), got ${blobs}"

echo
echo "✓ All checks passed."
