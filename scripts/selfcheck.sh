#!/usr/bin/env bash
#
# Drive the whole loop against the real pipeline: seed a baseline as main,
# break a component, prove a pull request catches it, approve it, delete a
# story and approve that too.
#
# Runs against a throwaway store, so the real baseline is never touched. The
# pull request writes only to its own overlay: main's baseline is compared
# before and after every approval, and must never move.
set -euo pipefail
cd "$(dirname "$0")/.."

work=".snapinator/selfcheck"
export SNAPINATOR_STORE="${work}/store"
baseline="${SNAPINATOR_STORE}/baseline/main.json"
overlay="${SNAPINATOR_STORE}/baseline/pr-1.json"

restore() { git checkout -- src/components 2>/dev/null || true; }
trap restore EXIT

rm -rf "$work" && mkdir -p "$work"
git diff --quiet src/components || { echo "✗ src/components has uncommitted edits; commit or stash first."; exit 1; }

fail() { echo "✗ $1"; exit 1; }
# Neither `node -p` nor `console.log` is safe here: both pretty-print, and on a
# TTY that means ANSI colour codes wrapped around the value. Every one of these
# gets string-compared, so write the raw bytes.
emit() { node -e "process.stdout.write(String($1))"; }
count() { emit "require('./${work}/run.json').$1.length"; }
size() { emit "Object.keys(require('./$1')).length"; }
# What a pull request run actually compares against: main's baseline with the
# overlay laid over it, tombstones dropped.
effective() {
  node -e "
    const fs = require('fs');
    const load = (f) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : {});
    const m = { ...load('${baseline}'), ...load('${overlay}') };
    for (const [k, v] of Object.entries(m)) if (v === null) delete m[k];
    process.stdout.write(String(Object.keys(m).length));
  "
}
# A pull request run: it reads the overlay and never writes the baseline.
pr_snap() { SNAPINATOR_OVERLAY=baseline/pr-1.json node scripts/snap.mjs "$@"; }
pr_accept() { SNAPINATOR_OVERLAY=baseline/pr-1.json node scripts/accept.mjs "$@"; }

yarn build-storybook >/dev/null 2>&1

echo "1. main seeds the baseline"
node scripts/snap.mjs --accept >/dev/null
[[ $(size "$baseline") == 8 ]] || fail "expected 8 stories in the baseline"
main_before=$(cat "$baseline")

echo "2. a clean run is silent and exits 0"
pr_snap >/dev/null || fail "unchanged suite should exit 0"

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
pr_snap >/dev/null && fail "changed suite should exit 1"
cp .snapinator/run/report/summary.json "${work}/run.json"
[[ $(count changed) == 3 ]] || fail "expected 3 changed stories (button + the two cards that render it), got $(count changed)"
run=$(emit "require('./${work}/run.json').runId")

echo "5. approving writes the overlay, and nothing to main"
pr_accept "$run" >/dev/null
[[ $(size "$overlay") == 3 ]] || fail "expected 3 keys in the overlay, got $(size "$overlay")"
[[ "$(cat "$baseline")" == "$main_before" ]] || fail "approving on a pull request moved main's baseline"
pr_snap >/dev/null || fail "everything is approved; should exit 0"

echo "6. an unknown run is refused"
pr_accept not-a-run >/dev/null 2>&1 && fail "an unknown run should be refused"

echo "7. nothing was re-uploaded that already existed"
blobs=$(find "${SNAPINATOR_STORE}/img" -name '*.png' | wc -l | tr -d ' ')
[[ "$blobs" == 14 ]] || fail "expected 14 blobs (8 baseline + 3 changed + 3 diffs), got ${blobs}"

echo "8. every blob in the store is named after its own contents"
node -e "
  const fs = require('fs'), crypto = require('crypto');
  const dir = '${SNAPINATOR_STORE}/img';
  const bad = fs.readdirSync(dir).filter((f) => {
    const hash = crypto.createHash('sha256').update(fs.readFileSync(dir + '/' + f)).digest('hex');
    return hash + '.png' !== f;
  });
  if (bad.length) { console.error('name does not match contents: ' + bad.join(', ')); process.exit(1); }
" || fail "a blob is filed under the wrong hash — every comparison against it would be wrong"

echo "9. a deleted story is caught, and approving it leaves a tombstone"
node -e "
  const fs = require('fs'), file = 'src/components/Badge.stories.jsx';
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/^export const Warning.*\n/m, ''));
"
yarn build-storybook >/dev/null 2>&1
pr_snap >/dev/null && fail "a removed story should exit 1"
cp .snapinator/run/report/summary.json "${work}/run.json"
[[ $(count removed) == 1 ]] || fail "expected 1 removed story, got $(count removed)"
pr_accept "$(emit "require('./${work}/run.json').runId")" >/dev/null || fail "approving the removal should exit 0"
[[ $(emit "require('./${overlay}')['badge--warning']") == null ]] || fail "expected a null tombstone for badge--warning"
[[ $(effective) == 7 ]] || fail "the tombstone should leave 7 stories to compare, got $(effective)"
pr_snap >/dev/null || fail "the removal is approved; should exit 0"
[[ "$(cat "$baseline")" == "$main_before" ]] || fail "approving on a pull request moved main's baseline"

echo
echo "✓ All checks passed."
