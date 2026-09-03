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
const MARKER = '<!-- snapmatic';
const SUMMARY = '.snapmatic/run/report/summary.json';
const INLINE_LIMIT = 8; // Past this the comment is a scroll wall; link out instead.

const pr = process.argv[2];
const publicUrl = process.env.SNAPMATIC_PUBLIC_URL ?? '';
const runUrl = process.env.RUN_URL ?? '';

// Without a public URL there is nowhere to point an <img>, so name what to
// configure rather than posting two dozen broken images.
const noImages = !publicUrl;
const img = (hash) => `${publicUrl}/img/${hash}.png`;
const cell = (hash, label) => (hash ? `<img src="${img(hash)}" width="280" alt="${label}">` : '_none_');

const summary = fs.existsSync(SUMMARY) ? JSON.parse(fs.readFileSync(SUMMARY, 'utf8')) : null;

function body() {
  if (!summary) {
    return `### The visual run did not finish

No report was produced. The [workflow log](${runUrl}) has the details.`;
  }

  const { runId, total, added, changed, removed } = summary;
  const moved = [...changed, ...added];

  if (!moved.length && !removed.length) {
    return `### No visual changes

All ${total} stories match their baseline, pixel for pixel.`;
  }

  const report = `${publicUrl}/report/${runId}/index.html`;
  const headline = [
    changed.length && `${changed.length} changed`,
    added.length && `${added.length} new`,
    removed.length && `${removed.length} removed`,
  ].filter(Boolean).join(' · ');

  const shown = moved.slice(0, INLINE_LIMIT);
  const rest = moved.length - shown.length;

  const gallery = noImages
    ? `${moved.map((e) => `- \`${e.id}\`${e.was ? '' : ' — new story'}`).join('\n')}

> The images are in the **report** artifact on [the run](${runUrl}). Set the
> \`SNAPMATIC_PUBLIC_URL\` repository variable to a bucket or CDN and they show
> up inline here instead.`
    : shown.map(card).join('\n\n');

  return [
    `### ${headline}`,
    '',
    gallery,
    rest > 0 && !noImages ? `\n_${rest} more not shown — [see the full report](${report})._` : null,
    removed.length ? `\nGone from the build: ${removed.map((id) => `\`${id}\``).join(', ')}` : null,
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
    `<sub>${total} stories captured · ${noImages ? '' : `[full report](${report}) · `}[run log](${runUrl})</sub>`,
  ].filter((line) => line !== null).join('\n');
}

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
<summary><code>${entry.id}</code>${isNew ? ' — new story' : ''}</summary>

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

const list = await api(`/repos/${repo}/issues/${pr}/comments?per_page=100`);
if (!list.ok) throw new Error(`Listing comments failed: ${list.status} ${await list.text()}`);

// One comment per pull request, edited in place — a run that moves eight
// stories should not produce eight notifications.
const existing = (await list.json()).find((c) => c.body?.startsWith(MARKER));

const res = existing
  ? await api(`/repos/${repo}/issues/comments/${existing.id}`, { method: 'PATCH', body: JSON.stringify({ body: text }) })
  : await api(`/repos/${repo}/issues/${pr}/comments`, { method: 'POST', body: JSON.stringify({ body: text }) });

if (!res.ok) throw new Error(`Posting the comment failed: ${res.status} ${await res.text()}`);
console.log(`${existing ? 'Updated' : 'Posted'} the visual review comment on #${pr}.`);
