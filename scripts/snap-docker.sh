#!/usr/bin/env bash
#
# Prove the capture is deterministic before trusting anything built on it.
#
# Captures the whole suite twice inside the pinned container and compares the
# resulting hashes. Any difference here — a font, an animation, a cursor blink,
# a timestamp rendered into a story — would otherwise show up later as a diff
# nobody can explain.
set -euo pipefail
cd "$(dirname "$0")/.."

# The *resolved* version, not the range in package.json: a caret would let the
# installed browser drift away from the container tag, and the mismatch only
# shows up as a container that cannot launch.
version=$(node -e "process.stdout.write(require('playwright/package.json').version)")
image="mcr.microsoft.com/playwright:v${version}-noble"
work=".snapinator/determinism"

# CI pins the same tag as a literal string, which nothing can resolve for it.
# Catch the drift here, once, instead of in a red build.
pinned=$(grep -oE 'mcr\.microsoft\.com/playwright:v[0-9.]+-noble' .github/workflows/visual.yml | head -1)
if [[ "$pinned" != "$image" ]]; then
  echo "✗ visual.yml pins ${pinned}, but playwright resolves to ${version}."
  echo "  Update the container tag to ${image}."
  exit 1
fi

[[ -f "${SNAPINATOR_STATIC:-storybook-static}/index.json" ]] || yarn build-storybook

capture() {
  docker run --rm \
    --user "$(id -u):$(id -g)" \
    -v "$PWD:/w" -w /w \
    -e HOME=/tmp \
    -e PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    -e SNAPINATOR_MANIFEST="$1" \
    -e SNAPINATOR_STORE="$2" \
    -e SNAPINATOR_RUN_ID="$3" \
    -e SNAPINATOR_STATIC="${SNAPINATOR_STATIC:-storybook-static}" \
    -e SNAPINATOR_WORKERS="${SNAPINATOR_WORKERS:-4}" \
    -e SNAPINATOR_FREEZE="${SNAPINATOR_FREEZE:-1}" \
    "$image" node scripts/snap.mjs "${4:-}"
}

# `accept` is the only sanctioned way to write a baseline: one pass, in the
# container, straight into the committed manifest.
if [[ "${1:-}" == "accept" ]]; then
  capture "${SNAPINATOR_MANIFEST:-snapshots.json}" "${SNAPINATOR_STORE:-.snapinator/store}" "seed-$(date +%s)" --accept
  exit
fi

rm -rf "$work" && mkdir -p "$work"

echo "Capturing twice in ${image}"
capture "${work}/pass-a.json" "${work}/store" pass-a --accept >/dev/null
capture "${work}/pass-b.json" "${work}/store" pass-b --accept >/dev/null

if diff -q "${work}/pass-a.json" "${work}/pass-b.json" >/dev/null; then
  echo "✓ Deterministic — $(node -e "process.stdout.write(String(Object.keys(require('./${work}/pass-a.json')).length))") stories, identical bytes."
else
  echo "✗ Non-deterministic. These stories differ between two identical runs:"
  diff "${work}/pass-a.json" "${work}/pass-b.json" | grep -oE '"[^"]+":' | sort -u
  exit 1
fi
