#!/usr/bin/env bash
# Post (or update) the single visual-review comment on a pull request.
set -euo pipefail

pr="$1"
summary=".snapmatic/run/report/summary.json"
marker="<!-- snapmatic -->"

if [[ "${CLEAN}" == "true" ]]; then
  body="${marker}
**No visual changes.** Every story matched its baseline."
else
  read -r added changed removed < <(
    node -e 'const s=require("./'"${summary}"'");console.log(s.added.length,s.changed.length,s.removed.length)'
  )
  ids=$(node -e 'const s=require("./'"${summary}"'");console.log([...s.added,...s.changed].map(e=>e.id).join(" "))')
  body="${marker}
**${changed} changed · ${added} new · ${removed} removed**

[Review the diff](${REPORT_BASE}/report/${RUN_ID}/index.html)

Approve everything with \`/approve-visual\`, or name the ones you trust:
\`\`\`
/approve-visual ${ids}
\`\`\`"
fi

# One comment per PR, edited in place — a 40-story run should not produce 40
# notifications.
existing=$(gh api "repos/${GITHUB_REPOSITORY}/issues/${pr}/comments" \
  --jq "map(select(.body | startswith(\"${marker}\"))) | .[0].id // empty")

if [[ -n "${existing}" ]]; then
  gh api --method PATCH "repos/${GITHUB_REPOSITORY}/issues/comments/${existing}" -f body="${body}"
else
  gh api --method POST "repos/${GITHUB_REPOSITORY}/issues/${pr}/comments" -f body="${body}"
fi
