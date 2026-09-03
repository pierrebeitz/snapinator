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

const STATIC = process.env.SNAPMATIC_STATIC || 'storybook-static';
const WORKERS = Number(process.env.SNAPMATIC_WORKERS || 4);
// Frozen clock and seeded randomness. A story that renders "2 minutes ago" or
// a uuid is a story that differs on every run, and one flaky story teaches a
// team to ignore the whole check.
const FREEZE = process.env.SNAPMATIC_FREEZE !== '0';
// How long the DOM must hold still before the shot counts as settled.
const SETTLE_MS = Number(process.env.SNAPMATIC_SETTLE_MS || 250);
// Stories known to disagree with themselves. Kept in a file rather than a
// code constant so the list is visible in review and shrinks under pressure.
const QUARANTINE = process.env.SNAPMATIC_QUARANTINE || '';
const MANIFEST = process.env.SNAPMATIC_MANIFEST || 'snapshots.json';
const WORK = '.snapmatic/run';
const VIEWPORT = { width: 1280, height: 720 };
const RUN_ID = process.env.SNAPMATIC_RUN_ID || new Date().toISOString().replace(/[:.]/g, '-');

const args = process.argv.slice(2);
const acceptArg = args.find((a) => a === '--accept' || a.startsWith('--accept='));
const acceptAll = acceptArg === '--accept';
const acceptOnly = acceptArg?.startsWith('--accept=') ? acceptArg.slice(9).split(',').filter(Boolean) : [];

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const failures = [];
const blobKey = (hash) => `img/${hash}.png`;

/* ---------------------------------------------------------------- serving */

// Storybook's built output expects to be served over http, not file://.
// Twenty lines beats a dependency.
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.map': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.svg': 'image/svg+xml', '.webp': 'image/webp',
  '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.ttf': 'font/ttf', '.otf': 'font/otf', '.txt': 'text/plain',
};

// Applied before any story script runs.
const DETERMINISM_SHIM = `
  // Kill motion at the source. Playwright's \`animations: 'disabled'\` finishes
  // CSS animations at screenshot time, which does nothing for a component that
  // animates by re-rendering — a toast sliding in, a dialog scaling up.
  const style = document.createElement('style');
  style.textContent = '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important;scroll-behavior:auto!important}';
  (document.head || document.documentElement).appendChild(style);

  const FIXED = new Date('2026-01-01T12:00:00Z').getTime();
  const RealDate = Date;
  globalThis.Date = class extends RealDate {
    constructor(...args) { super(...(args.length ? args : [FIXED])); }
    static now() { return FIXED; }
  };
  globalThis.Date.parse = RealDate.parse;
  globalThis.Date.UTC = RealDate.UTC;
  let seed = 0x2f6e2b1;
  Math.random = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
`;

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
  const shots = {};
  const queue = [...stories];
  const total = queue.length;
  let done = 0;

  // One page per worker, pulling from a shared queue. Sequential capture is
  // fine for a handful of stories and hopeless for a few hundred.
  const worker = async () => {
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
    if (FREEZE) await context.addInitScript(DETERMINISM_SHIM);
    const page = await context.newPage();

    for (let story; (story = queue.shift()); ) {
      const url = `http://127.0.0.1:${port}/iframe.html?viewMode=story&id=${encodeURIComponent(story.id)}`;
      const file = path.join(outDir, `${story.id}.png`);

      // One story must never take the run down with it, and it must never be
      // recorded as something it is not: if navigation fails, the previous
      // story is still loaded, and screenshotting here would hash *that* page
      // under *this* story's name — a baseline that is a picture of another
      // component, stable enough to stay green forever.
      try {
        await page.goto(url, { waitUntil: 'load' });
        await page.waitForFunction(() => {
          const root = document.querySelector('#storybook-root');
          return root && root.childElementCount > 0;
        }, null, { timeout: 15_000 });
        await page.evaluate(() => document.fonts.ready);

        // A fixed settle, not an adaptive one. Waiting for the DOM to hold
        // still sounds better and measured worse: a story whose data lands in
        // two bursts goes quiet in between, so the shot is taken at whichever
        // burst the machine happened to be between. A fixed pause always
        // captures the same moment in the story's life.
        await page.waitForTimeout(SETTLE_MS);

        // Render at the full viewport so layout is real, then crop to what the
        // story actually drew. Shooting the whole frame makes a button 2% of a
        // 1280x720 image, and in a three-column diff table that is a sliver
        // nobody can review.
        const clip = await page.evaluate((pad) => {
          const root = document.querySelector('#storybook-root');
          if (!root) return null;
          const rects = [...root.querySelectorAll('*')]
            .map((el) => el.getBoundingClientRect())
            .filter((r) => r.width > 0 && r.height > 0);
          if (!rects.length) return null;

          const left = Math.max(0, Math.min(...rects.map((r) => r.left)) - pad);
          const top = Math.max(0, Math.min(...rects.map((r) => r.top)) - pad);
          const right = Math.min(window.innerWidth, Math.max(...rects.map((r) => r.right)) + pad);
          const bottom = Math.min(window.innerHeight, Math.max(...rects.map((r) => r.bottom)) + pad);

          // A story drawn entirely below the fold yields an empty box, and
          // Playwright rejects a clip like that. Fall back to the frame.
          if (right - left < 1 || bottom - top < 1) return null;

          return {
            x: Math.floor(left),
            y: Math.floor(top),
            width: Math.max(1, Math.ceil(right - left)),
            height: Math.max(1, Math.ceil(bottom - top)),
          };
        }, 12);

        await page.screenshot({ path: file, animations: 'disabled', caret: 'hide', ...(clip ? { clip } : {}) });
        shots[story.id] = sha256(fs.readFileSync(file));
      } catch (error) {
        // Recorded, reported, and left out of the comparison entirely. A story
        // that did not render has no pixels to judge, and inventing some is how
        // a gate goes green over a blank page.
        failures.push({ id: story.id, reason: String(error.message ?? error).split('\n')[0] });
      }

      done += 1;
      if (total <= 20 || done % 25 === 0 || done === total) {
        process.stdout.write(`  ${done}/${total}\n`);
      }
    }

    await context.close();
  };

  await Promise.all(Array.from({ length: Math.min(WORKERS, total) }, worker));
  await browser.close();
  return shots;
}

/* ------------------------------------------------------------------- diff */

// Returns `{ hash, pixels }` for the diff image, or null when the store has no
// baseline to compare against (a failed upload, a rewritten history, a manually
// edited manifest). `pixels` is what actually moved on screen — the hash only
// says the bytes differ.
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
  const pixels = pixelmatch(
    pad(before, width, height).data,
    pad(after, width, height).data,
    diff.data,
    width,
    height,
    { threshold: 0.1, alpha: 0.2, diffColor: [255, 0, 128] },
  );

  const buf = PNG.sync.write(diff);
  const hash = sha256(buf);
  fs.writeFileSync(path.join(blobDir, `${hash}.png`), buf);
  return { hash, pixels };
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
const quarantined = new Set(QUARANTINE && fs.existsSync(QUARANTINE) ? JSON.parse(fs.readFileSync(QUARANTINE, 'utf8')) : []);
const stories = Object.values(index.entries)
  .filter((e) => e.type === 'story' && !quarantined.has(e.id))
  .sort((a, b) => a.id.localeCompare(b.id));
console.log(`Capturing ${stories.length} stories${quarantined.size ? ` (${quarantined.size} quarantined)` : ''}`);

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
const removed = Object.keys(baseline).filter((id) => !(id in shots) && !quarantined.has(id));

// Stage every image captured, not only the ones that moved. Sync skips what
// the store already holds, so the extra cost is a local copy — and it makes the
// store self-healing. Staging only the changes means a run whose upload failed
// leaves those baselines missing from the store forever: nothing re-uploads
// them, and every later diff for those stories shows a broken "before".
for (const [id, hash] of Object.entries(shots)) {
  fs.copyFileSync(path.join(shotDir, `${id}.png`), path.join(blobDir, `${hash}.png`));
}
let storeUnreadable = null;
for (const entry of changed) {
  let diff = null;
  try {
    diff = storeUnreadable ? null : renderDiff(store, entry.id, entry.was, path.join(shotDir, `${entry.id}.png`), blobDir);
  } catch (error) {
    // Say it once, not forty times, and stop asking.
    storeUnreadable ??= error.message;
    console.error(`\nCould not read baselines: ${error.message}`);
  }
  entry.diff = diff?.hash ?? null;
  entry.pixels = diff?.pixels ?? null;
}

// A story can re-encode to different bytes without a single pixel moving. The
// manifest records bytes, but the gate is about what people see, so drop those
// and leave the manifest alone — it keeps the first-seen bytes and the noise
// never surfaces again.
const unmoved = changed.filter((e) => e.pixels === 0);
for (const entry of unmoved) changed.splice(changed.indexOf(entry), 1);
if (unmoved.length) {
  console.log(`\n${unmoved.length} story(ies) changed bytes without moving a pixel; ignored.`);
}

// Biggest movement first: with a cap on how many get inlined, the ones worth
// looking at should not be decided alphabetically.
changed.sort((a, b) => (b.pixels ?? -1) - (a.pixels ?? -1));

// A report that references images stored somewhere else is a report that shows
// broken pictures the moment anyone downloads it. Copy everything it points at
// next to it, so the folder stands on its own wherever it ends up.
const reportImgDir = path.join(reportDir, 'img');
fs.mkdirSync(reportImgDir, { recursive: true });
for (const entry of [...added, ...changed]) {
  for (const hash of [entry.hash, entry.was, entry.diff].filter(Boolean)) {
    const dest = path.join(reportImgDir, `${hash}.png`);
    const staged = path.join(blobDir, `${hash}.png`);
    if (fs.existsSync(staged)) fs.copyFileSync(staged, dest);
    else store.fetch(blobKey(hash), dest); // a baseline, already in the store
  }
}

if (failures.length) {
  console.log(`\n${failures.length} story(ies) never rendered:`);
  for (const f of failures.slice(0, 10)) console.log(`  ${f.id} — ${f.reason}`);
  if (failures.length > 10) console.log(`  …and ${failures.length - 10} more`);
}

// Publish the images before anything claims they exist. A run that reports a
// diff and links to pictures that were never uploaded is worse than one that
// reports the diff plainly — it looks broken rather than informative.
let published = true;
try {
  store.publish(blobDir, 'img');
} catch (error) {
  published = false;
  console.error(`\nCould not publish images to ${store.describe()}: ${error.message}`);
}

const summary = { runId: RUN_ID, total: stories.length, added, changed, removed, failures, unmoved: unmoved.length, published };
fs.writeFileSync(path.join(reportDir, 'summary.json'), JSON.stringify(summary, null, 2));
fs.writeFileSync(path.join(reportDir, 'index.html'), renderReport(summary));

try {
  store.publish(reportDir, `report/${RUN_ID}`);
} catch {
  // Already reported above; the report is still in the run directory.
}

const accepted = acceptAll ? [...added, ...changed].map((e) => e.id) : acceptOnly;
if (accepted.length || (acceptAll && removed.length)) {
  const merged = { ...baseline };
  for (const id of accepted) merged[id] = shots[id];
  if (acceptAll) for (const id of removed) delete merged[id];
  fs.writeFileSync(MANIFEST, `${JSON.stringify(sortKeys(merged), null, 2)}\n`);
  console.log(`\nAccepted ${accepted.length} snapshot(s) into ${MANIFEST}`);
}
console.log(`\n${added.length} added · ${changed.length} changed · ${removed.length} removed`);
console.log(`Report: ${path.join(store.describe(), 'report', RUN_ID, 'index.html')}`);

// A story that would not render is a failure of the gate, not a footnote.
// Leaving it out of the exit code is how a run goes green over a blank page.
const dirty = added.length + changed.length + removed.length;
process.exit((dirty && !acceptAll) || failures.length ? 1 : 0);

function sortKeys(obj) {
  return Object.fromEntries(Object.entries(obj).sort(([a], [b]) => a.localeCompare(b)));
}
