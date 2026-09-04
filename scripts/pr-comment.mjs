#!/usr/bin/env node
/*
 * Render the run as a pull-request comment, and post it.
 *
 *   node scripts/pr-comment.mjs 42     post (or edit) the comment on PR 42
 *   node scripts/pr-comment.mjs        print the markdown and exit
 *
 * The images are inlined, not linked. Someone who changed a colour in GitHub's
 * web editor should see what they did to the product without installing
 * anything, leaving the tab, or knowing this tool exists.
 *
 * The Playwright container ships neither `gh` nor `jq`, and node has had
 * `fetch` for years, so this posts itself rather than handing markdown to a
 * shell script.
 */
import fs from 'node:fs';

// The marker both identifies the comment to edit and carries the run id, so
// the approve workflow can find the run without parsing a URL that may not be
// there. Anything downstream matches on the prefix, never the whole line.
const MARKER = '<!-- snapinator';
const SUMMARY = '.snapinator/run/report/summary.json';
const INLINE_LIMIT = 8; // Past this the comment is a scroll wall; link out instead.

const pr = process.argv[2];
const publicUrl = process.env.SNAPINATOR_PUBLIC_URL ?? '';
const runUrl = process.env.RUN_URL ?? '';

const img = (hash) => `${publicUrl}/img/${hash}.png`;
// No width attribute: the crops are already tight, so GitHub shows them at
// natural size and only scales down when a cell is too narrow.
const cell = (hash, label) => (hash ? `<img src="${img(hash)}" alt="${label}">` : '_missing from the store_');
const px = (n) => (typeof n === 'number' ? ` · ${n.toLocaleString('en-US')} px moved` : '');

const summary = fs.existsSync(SUMMARY) ? JSON.parse(fs.readFileSync(SUMMARY, 'utf8')) : null;

// Without a public URL there is nowhere to point an <img>. Same when a publish
// failed: those URLs resolve to nothing, and a wall of broken images reads as a
// broken tool rather than a real finding.
const noImages = !publicUrl || summary?.published === false;

function body() {
  if (!summary) {
    return `### The visual run did not finish

No report was produced. The [workflow log](${runUrl}) has the details.`;
  }

  const { runId, total, optedOut = 0, quarantined = 0, added, changed, removed, failures = [] } = summary;
  const moved = [...changed, ...added];

  if (!moved.length && !removed.length && !failures.length) {
    return `### No visual changes

All ${total} compared stories match their baseline, pixel for pixel.${excluded(optedOut, quarantined)}`;
  }

  const report = `${publicUrl}/report/${runId}/index.html`;
  const headline = [
    changed.length && `${changed.length} changed`,
    added.length && `${added.length} new`,
    removed.length && `${removed.length} removed`,
    failures.length && `${failures.length} did not render`,
  ].filter(Boolean).join(' · ');

  const shown = moved.slice(0, INLINE_LIMIT);
  const rest = moved.length - shown.length;

  const gallery = noImages
    ? `${moved.map((e) => `- \`${e.id}\`${e.was ? px(e.pixels) : ' — new story'}`).join('\n')}

> The images are in the **report** artifact on [the run](${runUrl}). Set the
> \`SNAPINATOR_PUBLIC_URL\` repository variable to a bucket or CDN and they show
> up inline here instead.`
    : shown.map(card).join('\n\n');

  return [
    `### ${headline}`,
    '',
    gallery,
    rest > 0 && !noImages ? `\n_${rest} more not shown — [see the full report](${report})._` : null,
    removed.length ? `\nGone from the build: ${removed.map((id) => `\`${id}\``).join(', ')}` : null,
    failures.length
      ? `\n**Did not render** — these have no pixels to judge, so nothing is protecting them:\n${
          failures.map((f) => `- \`${f.id}\` — ${f.reason}`).join('\n')
        }`
      : null,
    '',
    '---',
    '',
    '**Do these look right?** Comment `/approve-visual` and the baseline moves.',
    'To accept only some of them, name them:',
    '',
    '```',
    `/approve-visual ${moved.map((e) => e.id).join(' ')}`,
    '```',
    '',
    `<sub>${total} stories compared${excludedShort(optedOut, quarantined)} · ${noImages ? '' : `[full report](${report}) · `}[run log](${runUrl})</sub>`,
  ].filter((line) => line !== null).join('\n');
}

// Never let the summary imply coverage the run did not have.
function excluded(optedOut, quarantined) {
  const parts = [
    optedOut && `${optedOut} opted out with \`disableSnapshot\``,
    quarantined && `${quarantined} quarantined as unstable`,
  ].filter(Boolean);
  return parts.length ? `\n\nNot compared: ${parts.join(', ')}.` : '';
}

const excludedShort = (optedOut, quarantined) => {
  const n = optedOut + quarantined;
  return n ? `, ${n} not compared` : '';
};

function card(entry) {
  const isNew = !entry.was;
  const table = isNew
    ? ['| new |', '|---|', `| ${cell(entry.hash, 'new')} |`]
    : [
        '| before | after | what moved |',
        '|---|---|---|',
        `| ${cell(entry.was, 'before')} | ${cell(entry.hash, 'after')} | ${cell(entry.diff, 'diff')} |`,
      ];

  return `<details open>
<summary><code>${entry.id}</code>${isNew ? ' — new story' : px(entry.pixels)}</summary>

${table.join('\n')}

</details>`;
}

/* ------------------------------------------------------------------ posting */

const text = `${MARKER} run=${summary?.runId ?? 'none'} -->\n${body()}\n`;

if (!pr) {
  process.stdout.write(text);
  process.exit(0);
}

const repo = process.env.GITHUB_REPOSITORY;
const token = process.env.GITHUB_TOKEN;
const api = (path, init) =>
  fetch(`${process.env.GITHUB_API_URL ?? 'https://api.github.com'}${path}`, {
    ...init,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      ...init?.headers,
    },
  });

// One comment per pull request, edited in place — a run that moves eight
// stories should not produce eight notifications. That promise inverts on a
// busy pull request unless every page is read: miss the comment and each run
// posts a new one.
async function findExistingComment() {
  let found = null;
  for (let page = 1; page <= 20; page += 1) {
    const res = await api(`/repos/${repo}/issues/${pr}/comments?per_page=100&page=${page}`);
    if (!res.ok) throw new Error(`Listing comments failed: ${res.status} ${await res.text()}`);
    const batch = await res.json();
    // `last`, not `first`: the approve workflow reads the run id from the last
    // marker comment, and editing a different one than it reads means
    // approving a stale run's hashes.
    const match = batch.filter((c) => c.body?.startsWith(MARKER)).pop();
    if (match) found = match;
    if (batch.length < 100) break;
  }
  return found;
}

const existing = await findExistingComment();

const res = existing
  ? await api(`/repos/${repo}/issues/comments/${existing.id}`, { method: 'PATCH', body: JSON.stringify({ body: text }) })
  : await api(`/repos/${repo}/issues/${pr}/comments`, { method: 'POST', body: JSON.stringify({ body: text }) });

if (!res.ok) throw new Error(`Posting the comment failed: ${res.status} ${await res.text()}`);
console.log(`${existing ? 'Updated' : 'Posted'} the visual review comment on #${pr}.`);
