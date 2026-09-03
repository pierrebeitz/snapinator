#!/usr/bin/env node
/*
 * Render the run as a pull-request comment.
 *
 *   node scripts/pr-comment.mjs <publicUrl> <runUrl>
 *
 * The images are inlined, not linked. Someone who changed a colour in the
 * GitHub web editor should see what they did to the product without installing
 * anything, leaving the tab, or knowing this tool exists.
 */
import fs from 'node:fs';

const MARKER = '<!-- snapmatic -->';
const SUMMARY = '.snapmatic/run/report/summary.json';
const INLINE_LIMIT = 8; // Past this the comment becomes a scroll wall; link out instead.

const [publicUrl = '', runUrl = ''] = process.argv.slice(2);
const img = (hash) => `${publicUrl}/img/${hash}.png`;

if (!fs.existsSync(SUMMARY)) {
  process.stdout.write(`${MARKER}
### The visual run did not finish

No report was produced. The [workflow log](${runUrl}) has the details.
`);
  process.exit(0);
}

const { runId, total, added, changed, removed } = JSON.parse(fs.readFileSync(SUMMARY, 'utf8'));
const moved = [...changed, ...added];
const report = `${publicUrl}/report/${runId}/index.html`;

if (!moved.length && !removed.length) {
  process.stdout.write(`${MARKER}
### No visual changes

All ${total} stories match their baseline, pixel for pixel.
`);
  process.exit(0);
}

const cell = (hash, label) =>
  hash ? `<img src="${img(hash)}" width="280" alt="${label}">` : '_none_';

const card = (entry) => {
  const isNew = !entry.was;
  const body = isNew
    ? ['| new |', '|---|', `| ${cell(entry.hash, 'new')} |`].join('\n')
    : [
        '| before | after | what moved |',
        '|---|---|---|',
        `| ${cell(entry.was, 'before')} | ${cell(entry.hash, 'after')} | ${cell(entry.diff, 'diff')} |`,
      ].join('\n');

  return `<details open>
<summary><code>${entry.id}</code>${isNew ? ' — new story' : ''}</summary>

${body}

</details>`;
};

const headline = [
  changed.length && `${changed.length} changed`,
  added.length && `${added.length} new`,
  removed.length && `${removed.length} removed`,
].filter(Boolean).join(' · ');

const shown = moved.slice(0, INLINE_LIMIT);
const rest = moved.length - shown.length;

process.stdout.write(`${MARKER}
### ${headline}

${shown.map(card).join('\n\n')}
${rest > 0 ? `\n_${rest} more not shown — [see the full report](${report})._\n` : ''}
${removed.length ? `\nGone from the build: ${removed.map((id) => `\`${id}\``).join(', ')}\n` : ''}
---

**Do these look right?** Comment \`/approve-visual\` and the baseline moves.
To accept only some of them, name them:

\`\`\`
/approve-visual ${moved.map((e) => e.id).join(' ')}
\`\`\`

<sub>${total} stories captured · [full report](${report}) · [run log](${runUrl})</sub>
`);
