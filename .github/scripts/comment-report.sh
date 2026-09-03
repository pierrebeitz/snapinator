#!/usr/bin/env bash
# Post (or update) the single visual-review comment on a pull request.
set -euo pipefail

pr="$1"
marker="<!-- snapmatic -->"
body=$(node scripts/pr-comment.mjs "${REPORT_BASE}" "${RUN_URL}")

# One comment per pull request, edited in place — a run that moves eight
# stories should not produce eight notifications.
existing=$(gh api "repos/${GITHUB_REPOSITORY}/issues/${pr}/comments" \
  --jq "map(select(.body | startswith(\"${marker}\"))) | .[0].id // empty")

if [[ -n "${existing}" ]]; then
  gh api --method PATCH "repos/${GITHUB_REPOSITORY}/issues/comments/${existing}" -f body="${body}"
else
  gh api --method POST "repos/${GITHUB_REPOSITORY}/issues/${pr}/comments" -f body="${body}"
fi
