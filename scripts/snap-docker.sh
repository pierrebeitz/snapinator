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

version=$(node -p "require('./package.json').devDependencies.playwright.replace('^','')")
image="mcr.microsoft.com/playwright:v${version}-noble"
work=".snapmatic/determinism"

[[ -f storybook-static/index.json ]] || yarn build-storybook

rm -rf "$work" && mkdir -p "$work"

capture() {
  docker run --rm \
    --user "$(id -u):$(id -g)" \
    -v "$PWD:/w" -w /w \
    -e HOME=/tmp \
    -e PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    -e SNAPMATIC_MANIFEST="${work}/$1.json" \
    -e SNAPMATIC_STORE="${work}/store" \
    -e SNAPMATIC_RUN_ID="$1" \
    "$image" node scripts/snap.mjs --accept >/dev/null
}

echo "Capturing twice in ${image}"
capture pass-a
capture pass-b

if diff -q "${work}/pass-a.json" "${work}/pass-b.json" >/dev/null; then
  echo "✓ Deterministic — $(node -p "Object.keys(require('./${work}/pass-a.json')).length") stories, identical bytes."
else
  echo "✗ Non-deterministic. These stories differ between two identical runs:"
  diff "${work}/pass-a.json" "${work}/pass-b.json" | grep -oE '"[^"]+":' | sort -u
  exit 1
fi
