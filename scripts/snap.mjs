#!/usr/bin/env node
/*
 * Screenshot every story, hash it, compare against the manifest.
 *
 *   node scripts/snap.mjs                 capture, diff, report; exit 1 on change
 *   node scripts/snap.mjs --accept        ...and rewrite snapshots.json
 *   node scripts/snap.mjs --accept=a,b    ...for these story ids only
 *
 * The manifest (snapshots.json) is the only thing that lives in git: one line
 * per story, `storyId -> sha256`. Pixels live in the store. "Approving" a
 * change is therefore a one-line commit, reviewed like any other.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { chromium } from 'playwright';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import { renderReport } from './report.mjs';
import { openStore } from './store.mjs';

const STATIC = 'storybook-static';
const MANIFEST = process.env.SNAPMATIC_MANIFEST || 'snapshots.json';
const WORK = '.snapmatic/run';
const VIEWPORT = { width: 1280, height: 720 };
const RUN_ID = process.env.SNAPMATIC_RUN_ID || new Date().toISOString().replace(/[:.]/g, '-');

const args = process.argv.slice(2);
const acceptArg = args.find((a) => a === '--accept' || a.startsWith('--accept='));
const acceptAll = acceptArg === '--accept';
const acceptOnly = acceptArg?.startsWith('--accept=') ? acceptArg.slice(9).split(',').filter(Boolean) : [];

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const blobKey = (hash) => `img/${hash}.png`;

/* ---------------------------------------------------------------- serving */

// Storybook's built output expects to be served over http, not file://.
// Twenty lines beats a dependency.
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };

function serve(root) {
  const base = path.resolve(root);
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html';
    const file = path.resolve(base, rel);
    if (!file.startsWith(base) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

/* ---------------------------------------------------------------- capture */

async function capture(port, stories, outDir) {
  const browser = await chromium.launch();
  // Every option here is a determinism knob. Drop one and you buy flaky diffs.
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 1,
    colorScheme: 'light',
    reducedMotion: 'reduce',
    forcedColors: 'none',
    locale: 'en-US',
    timezoneId: 'UTC',
  });
  const page = await context.newPage();
  const shots = {};

  for (const story of stories) {
    const url = `http://127.0.0.1:${port}/iframe.html?viewMode=story&id=${encodeURIComponent(story.id)}`;
    await page.goto(url, { waitUntil: 'load' });
    await page.waitForFunction(() => {
      const root = document.querySelector('#storybook-root');
      return root && root.childElementCount > 0;
    }, null, { timeout: 15_000 });
    await page.evaluate(() => document.fonts.ready);

    const file = path.join(outDir, `${story.id}.png`);
    // Shoot the story root, not the viewport: a button in a 1280x720 frame is
    // 2% component and 98% white, and a reviewer has to zoom to see anything.
    // A root with no box (an absolutely positioned story) falls back to the
    // frame, which is still deterministic — just emptier.
    const root = page.locator('#storybook-root');
    const box = await root.boundingBox();
    const target = box && box.width >= 1 && box.height >= 1 ? root : page;
    // ponytail: one page, one story at a time. Parallelise with N contexts
    // when the suite outgrows a couple of minutes.
    await target.screenshot({ path: file, animations: 'disabled', caret: 'hide' });
    shots[story.id] = sha256(fs.readFileSync(file));
    process.stdout.write(`  ${story.id}\n`);
  }

  await browser.close();
  return shots;
}

/* ------------------------------------------------------------------- diff */

// Returns the sha256 of the diff image, or null when the store has no baseline
// to compare against (a rewritten history, a manually edited manifest).
function renderDiff(store, storyId, baselineHash, shotPath, blobDir) {
  const baselinePath = path.join(WORK, 'baseline', `${storyId}.png`);
  if (!store.fetch(blobKey(baselineHash), baselinePath)) return null;

  const before = PNG.sync.read(fs.readFileSync(baselinePath));
  const after = PNG.sync.read(fs.readFileSync(shotPath));
  const width = Math.max(before.width, after.width);
  const height = Math.max(before.height, after.height);
  const diff = new PNG({ width, height });

  // Mismatched dimensions are a real change, not an error: pad both to the
  // union box so the diff shows where the layout grew.
  pixelmatch(pad(before, width, height).data, pad(after, width, height).data, diff.data, width, height, {
    threshold: 0.1,
    alpha: 0.2,
    diffColor: [255, 0, 128],
  });

  const buf = PNG.sync.write(diff);
  const hash = sha256(buf);
  fs.writeFileSync(path.join(blobDir, `${hash}.png`), buf);
  return hash;
}

function pad(png, width, height) {
  if (png.width === width && png.height === height) return png;
  const out = new PNG({ width, height, fill: true });
  PNG.bitblt(png, out, 0, 0, png.width, png.height, 0, 0);
  return out;
}

/* ------------------------------------------------------------------- main */

const read = (file, fallback) => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : fallback);

if (!fs.existsSync(path.join(STATIC, 'index.json'))) {
  console.error(`No ${STATIC}/index.json — run \`yarn build-storybook\` first.`);
  process.exit(2);
}

fs.rmSync(WORK, { recursive: true, force: true });
const shotDir = path.join(WORK, 'shots');
const blobDir = path.join(WORK, 'blobs');
const reportDir = path.join(WORK, 'report');
for (const d of [shotDir, blobDir, reportDir]) fs.mkdirSync(d, { recursive: true });

const index = read(path.join(STATIC, 'index.json'), { entries: {} });
const stories = Object.values(index.entries).filter((e) => e.type === 'story').sort((a, b) => a.id.localeCompare(b.id));
console.log(`Capturing ${stories.length} stories`);

const { server, port } = await serve(STATIC);
const shots = await capture(port, stories, shotDir);
server.close();

const baseline = read(MANIFEST, {});
const store = openStore();
console.log(`Store: ${store.describe()}`);

const changed = [];
const added = [];
for (const [id, hash] of Object.entries(shots)) {
  if (!(id in baseline)) added.push({ id, hash });
  else if (baseline[id] !== hash) changed.push({ id, hash, was: baseline[id] });
}
const removed = Object.keys(baseline).filter((id) => !(id in shots));

// Stage the blobs worth keeping: everything new, plus every diff.
for (const { id, hash } of [...added, ...changed]) {
  fs.copyFileSync(path.join(shotDir, `${id}.png`), path.join(blobDir, `${hash}.png`));
}
for (const entry of changed) {
  entry.diff = renderDiff(store, entry.id, entry.was, path.join(shotDir, `${entry.id}.png`), blobDir);
}

const summary = { runId: RUN_ID, total: stories.length, added, changed, removed };
fs.writeFileSync(path.join(reportDir, 'summary.json'), JSON.stringify(summary, null, 2));
fs.writeFileSync(path.join(reportDir, 'index.html'), renderReport(summary));

store.publish(blobDir, 'img');
store.publish(reportDir, `report/${RUN_ID}`);

const next = { ...baseline, ...shots };
for (const id of removed) delete next[id];

const accepted = acceptAll ? [...added, ...changed].map((e) => e.id) : acceptOnly;
if (accepted.length || (acceptAll && removed.length)) {
  const merged = { ...baseline };
  for (const id of accepted) merged[id] = shots[id];
  if (acceptAll) for (const id of removed) delete merged[id];
  fs.writeFileSync(MANIFEST, `${JSON.stringify(sortKeys(merged), null, 2)}\n`);
  console.log(`\nAccepted ${accepted.length} snapshot(s) into ${MANIFEST}`);
}
fs.writeFileSync(path.join(WORK, 'snapshots.next.json'), `${JSON.stringify(sortKeys(next), null, 2)}\n`);

console.log(`\n${added.length} added · ${changed.length} changed · ${removed.length} removed`);
console.log(`Report: ${path.join(store.describe(), 'report', RUN_ID, 'index.html')}`);

const dirty = added.length + changed.length + removed.length;
process.exit(dirty && !acceptAll ? 1 : 0);

function sortKeys(obj) {
  return Object.fromEntries(Object.entries(obj).sort(([a], [b]) => a.localeCompare(b)));
}
