#!/usr/bin/env node
/*
 * Establish a baseline for a suite that has never had one.
 *
 *   node scripts/bootstrap.mjs
 *
 * Captures twice. The first pass accepts everything; the second compares
 * against it and whatever comes back changed is a story that disagrees with
 * itself. Those go to the quarantine file and out of the baseline.
 *
 * The second pass is a plain comparison run on purpose, so it judges by pixels
 * moved exactly as the gate does. An earlier version compared file hashes
 * directly and quarantined forty stories that were byte-different and
 * pixel-identical — measuring the encoder rather than the suite.
 *
 * Quarantining is not forgiveness. A story on that list is a story whose
 * appearance nothing is protecting, and the list is committed precisely so it
 * shows up in review and shrinks.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const BASELINES = process.env.SNAPINATOR_MANIFEST || 'snapshots.json';
const QUARANTINE = process.env.SNAPINATOR_QUARANTINE || 'quarantine.json';
const SUMMARY = '.snapinator/run/report/summary.json';

// Resolved next to this file, not relative to the working directory: this
// script gets vendored into other repositories under whatever directory name
// they choose, and a hard-coded path there fails as a plain exit 1 — which the
// tolerated-exit-code below would then read as "stories moved".
const SNAP = fileURLToPath(new URL('snap.mjs', import.meta.url));

const snap = (args, { tolerateChanges = false } = {}) => {
  try {
    execFileSync('node', [SNAP, ...args], { stdio: 'inherit' });
  } catch (error) {
    // A comparison run exits 1 when anything moved; that is the signal, not a
    // failure. Nothing else earns that leniency.
    if (!(tolerateChanges && error.status === 1)) throw error;
  }
};

// Start clean: a stale quarantine would hide the very stories this is measuring.
fs.writeFileSync(QUARANTINE, '[]\n');
fs.rmSync(BASELINES, { force: true });

console.log('Pass 1 of 2 — accepting everything');
snap(['--accept']);
if (!fs.existsSync(BASELINES)) throw new Error(`Pass 1 wrote no manifest at ${BASELINES}.`);

console.log('\nPass 2 of 2 — comparing against it');
snap([], { tolerateChanges: true });
if (!fs.existsSync(SUMMARY)) throw new Error(`Pass 2 wrote no summary at ${SUMMARY}.`);

const summary = JSON.parse(fs.readFileSync(SUMMARY, 'utf8'));
const unstable = [...summary.changed.map((c) => c.id), ...summary.failures.map((f) => f.id)].sort();

const baseline = JSON.parse(fs.readFileSync(BASELINES, 'utf8'));
for (const id of unstable) delete baseline[id];

fs.writeFileSync(BASELINES, `${JSON.stringify(baseline, null, 2)}\n`);
fs.writeFileSync(QUARANTINE, `${JSON.stringify(unstable, null, 2)}\n`);

const captured = Object.keys(baseline).length + unstable.length;
console.log(`\n${captured} stories captured`);
console.log(`${Object.keys(baseline).length} agreed with themselves and are now the baseline`);
console.log(
  unstable.length
    ? `${unstable.length} did not (${((100 * unstable.length) / captured).toFixed(1)}%) and are quarantined in ${QUARANTINE}`
    : 'none disagreed with themselves',
);
