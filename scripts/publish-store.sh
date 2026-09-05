#!/bin/sh
#
# Commit whatever is in the store clone and push it to the store branch.
#
# Runs are concurrent and every clone is `--depth 1`, so the branch moves under
# this one routinely. Re-parenting onto the remote tip rather than merging into
# it keeps that conflict-free: blobs are content-addressed, so two runs adding
# the same name added the same bytes, and the baseline pointer has exactly one
# writer. A rejected push here is not cosmetic — it is main's baseline silently
# failing to move.
set -e

git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"

for attempt in 1 2 3; do
  git fetch -q origin visual-store
  git reset -q --soft FETCH_HEAD
  git add -A
  if git diff --cached --quiet; then
    echo "Nothing new to publish."
    exit 0
  fi
  git commit -qm "${MESSAGE}"
  if git push -q origin HEAD:visual-store; then
    echo "Published on attempt ${attempt}."
    exit 0
  fi
  echo "The store branch moved; rebuilding on its new tip."
done

echo "Could not publish the store after 3 attempts." >&2
exit 1
