#!/usr/bin/env node
/*
 * Approve snapshots from a run that already happened.
 *
 *   node scripts/accept.mjs <runId>            accept everything that moved
 *   node scripts/accept.mjs <runId> a b c      accept these story ids only
 *
 * No browser, no Storybook build. The run already captured the pixels and
 * pushed them to the store under their content hash, so approving is pure
 * bookkeeping: copy hashes out of that run's summary into the manifest. It
 * finishes in seconds, and — more importantly — it cannot disagree with what
 * the reviewer actually looked at, the way a re-capture can.
 */
import fs from 'node:fs';
import path from 'node:path';
import { openStore } from './store.mjs';

const MANIFEST = process.env.SNAPINATOR_MANIFEST || 'snapshots.json';
const [runId, ...only] = process.argv.slice(2);

if (!runId) {
  console.error('usage: node scripts/accept.mjs <runId> [storyId...]');
  process.exit(2);
}

const store = openStore();
const summaryPath = path.join('.snapinator', 'accept', 'summary.json');
if (!store.fetch(`report/${runId}/summary.json`, summaryPath)) {
  console.error(`No run \`${runId}\` in ${store.describe()}.`);
  process.exit(2);
}

const { added, changed, removed } = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
const manifest = fs.existsSync(MANIFEST) ? JSON.parse(fs.readFileSync(MANIFEST, 'utf8')) : {};

const moved = [...added, ...changed];
const wanted = only.length ? moved.filter((e) => only.includes(e.id)) : moved;

const unknown = only.filter((id) => !moved.some((e) => e.id === id));
if (unknown.length) {
  console.error(`Not part of run ${runId}: ${unknown.join(', ')}`);
  process.exit(2);
}

for (const { id, hash } of wanted) manifest[id] = hash;
if (!only.length) for (const id of removed) delete manifest[id];

const sorted = Object.fromEntries(Object.entries(manifest).sort(([a], [b]) => a.localeCompare(b)));
fs.writeFileSync(MANIFEST, `${JSON.stringify(sorted, null, 2)}\n`);

const dropped = only.length ? 0 : removed.length;
console.log(`Accepted ${wanted.length} snapshot(s)${dropped ? `, dropped ${dropped}` : ''} from run ${runId}.`);
