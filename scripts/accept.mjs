#!/usr/bin/env node
/*
 * Approve everything a run reported.
 *
 *   node scripts/accept.mjs <runId>
 *
 * No browser, no Storybook build. The run already captured the pixels and
 * pushed them to the store under their content hash, so approving is pure
 * bookkeeping: copy hashes out of that run's summary into the pull request's
 * overlay. It finishes in seconds, and — more importantly — it cannot disagree
 * with what the reviewer actually looked at, the way a re-capture can.
 *
 * The overlay is the pull request's own, never main's baseline: a change
 * accepted on a branch must not move what every other branch compares against
 * until it merges.
 */
import fs from 'node:fs';
import path from 'node:path';
import { openStore } from './store.mjs';

const OVERLAY_KEY = process.env.SNAPINATOR_OVERLAY;
const runId = process.argv[2];

if (!runId || !OVERLAY_KEY) {
  console.error('usage: SNAPINATOR_OVERLAY=<key> node scripts/accept.mjs <runId>');
  process.exit(2);
}

const store = openStore();
const summaryPath = path.join('.snapinator', 'accept', 'summary.json');
if (!store.fetch(`report/${runId}/summary.json`, summaryPath)) {
  console.error(`No run \`${runId}\` in ${store.describe()}.`);
  process.exit(2);
}

const { added, changed, removed } = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
const overlay = store.readJson(OVERLAY_KEY, {});

for (const { id, hash } of [...added, ...changed]) overlay[id] = hash;
// `null`, not a deletion: the story is still in main's baseline, and dropping
// the key here would just let it be reported as removed all over again.
for (const id of removed) overlay[id] = null;

store.writeJson(OVERLAY_KEY, Object.fromEntries(Object.entries(overlay).sort(([a], [b]) => a.localeCompare(b))));

const moved = added.length + changed.length;
console.log(`Accepted ${moved} snapshot(s)${removed.length ? `, dropped ${removed.length}` : ''} from run ${runId}.`);
