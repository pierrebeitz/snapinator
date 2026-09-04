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

const STATIC = process.env.SNAPINATOR_STATIC || 'storybook-static';
const WORKERS = Number(process.env.SNAPINATOR_WORKERS || 4);
// Frozen clock and seeded randomness. A story that renders "2 minutes ago" or
// a uuid is a story that differs on every run, and one flaky story teaches a
// team to ignore the whole check.
const FREEZE = process.env.SNAPINATOR_FREEZE !== '0';
// How long the DOM must hold still before the shot counts as settled.
const SETTLE_MS = Number(process.env.SNAPINATOR_SETTLE_MS || 250);
// Above this many changes, a second capture is not confirming a suspicion — it
// is capturing the suite again, and the changes are real.
const RETRY_LIMIT = Number(process.env.SNAPINATOR_RETRY_LIMIT || 40);
// Stories known to disagree with themselves. Kept in a file rather than a
// code constant so the list is visible in review and shrinks under pressure.
const QUARANTINE = process.env.SNAPINATOR_QUARANTINE || '';
const MANIFEST = process.env.SNAPINATOR_MANIFEST || 'snapshots.json';
const WORK = '.snapinator/run';
const VIEWPORT = { width: 1280, height: 720 };
const RUN_ID = process.env.SNAPINATOR_RUN_ID || new Date().toISOString().replace(/[:.]/g, '-');

const args = process.argv.slice(2);
const acceptArg = args.find((a) => a === '--accept' || a.startsWith('--accept='));
const acceptAll = acceptArg === '--accept';
const acceptOnly = acceptArg?.startsWith('--accept=') ? acceptArg.slice(9).split(',').filter(Boolean) : [];

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
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
    // Every branch here is guarded because an uncaught throw in a request
    // handler kills the process mid-capture — five minutes of work and no
    // report, over one malformed percent-escape in an asset URL.
    try {
      const raw = req.url.split('?')[0];
      let rel;
      try {
        rel = decodeURIComponent(raw).replace(/^\/+/, '') || 'index.html';
      } catch {
        res.writeHead(400).end('bad request');
        return;
      }

      const file = path.resolve(base, rel);
      // `path.relative`, not a string prefix: `startsWith(base)` also admits a
      // sibling directory whose name merely begins with it.
      const inside = path.relative(base, file);
      if (inside.startsWith('..') || path.isAbsolute(inside)) {
        res.writeHead(403).end('forbidden');
        return;
      }
      if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.writeHead(404).end('not found');
        return;
      }

      res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' });
      const stream = fs.createReadStream(file);
      stream.on('error', () => res.destroy());
      stream.pipe(res);
    } catch {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  });
  server.on('clientError', (_error, socket) => socket.destroy());
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

/* --------------------------------------------------------------- opt-outs */

// Stories the suite itself declares un-snapshottable, via Chromatic's
// `disableSnapshot` parameter. Storybook's index.json carries no parameters, so
// the only place to read them is the running preview — which resolves all of
// them in well under a second, without rendering anything.
//
// Reading the declaration beats rediscovering it: these are the animated and
// mid-flight stories a team has already ruled out, and a tool that quarantines
// them by observation is both slower and less honest about why.
async function readOptOuts(port, ids) {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${port}/iframe.html?viewMode=story&id=${encodeURIComponent(ids[0])}`, { waitUntil: 'load' });
    await page.waitForFunction(() => !!window.__STORYBOOK_PREVIEW__?.storyStore, null, { timeout: 15_000 });

    return await page.evaluate(async (storyIds) => {
      const store = window.__STORYBOOK_PREVIEW__.storyStore;
      const out = [];
      for (const id of storyIds) {
        try {
          const story = await store.loadStory({ storyId: id });
          if (story?.parameters?.chromatic?.disableSnapshot) out.push(id);
        } catch {
          // A story that will not load is the capture's problem to report.
        }
      }
      return out;
    }, ids);
  } catch (error) {
    // Returning an empty list here would silently capture every story the suite
    // deliberately excludes, report them all as new, and let one blanket
    // approval write them into the baseline permanently. A degradation that
    // large should stop the run, not widen it.
    throw new Error(`Could not read story parameters: ${error.message}`);
  } finally {
    await browser.close();
  }
}

/* ---------------------------------------------------------------- capture */

// Returns its own failures rather than appending to a shared list: the
// confirmation pass calls this too, and a hiccup during a retry would otherwise
// mark a story that captured perfectly well as "did not render" — reported in
// the comment alongside its own before/after images, and forcing exit 1.
async function capture(port, stories, outDir, { workers = WORKERS, settleMs = SETTLE_MS } = {}) {
  const browser = await chromium.launch();
  const shots = {};
  const failures = [];
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
        // Wait for Storybook to finish rendering the story, play function and
        // all. This suite has 87 of them across 25 files — they open cards,
        // type sentences, click Save and await an error — and a story caught
        // mid-interaction is a different picture every time. One of them
        // rendered 260px of content on one run and 708px on another purely
        // because the shot landed on either side of a click.
        //
        // `finished` is the terminal phase; `errored` and `aborted` are the
        // other two, and waiting past them would just burn the timeout.
        await page
          .waitForFunction(
            () => {
              const phase = window.__STORYBOOK_PREVIEW__?.currentRender?.phase;
              return phase === undefined || ['finished', 'errored', 'aborted'].includes(phase);
            },
            null,
            { timeout: 20_000 },
          )
          .catch(() => {
            // A story that never finishes still gets captured; the settle below
            // is what it falls back to. Better a picture than a dropped story.
          });

        // The render phase covers the play function and the render; it does
        // not cover requests still in flight. Every story in the remaining
        // unstable tail was a data-driven page — dashboards, dialogs, settings
        // — which is what a mock still resolving looks like from outside.
        //
        // Bounded and forgiving: a story that keeps a connection open would
        // never go idle, and waiting forever on it would be worse than
        // capturing it slightly early.
        await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});

        await page.evaluate(() => document.fonts.ready);

        // A fixed settle, not an adaptive one. Waiting for the DOM to hold
        // still sounds better and measured worse: a story whose data lands in
        // two bursts goes quiet in between, so the shot is taken at whichever
        // burst the machine happened to be between. A fixed pause always
        // captures the same moment in the story's life.
        await page.waitForTimeout(settleMs);

        // Capture the whole document, then crop to what the story drew.
        //
        // Both halves matter. A clip alone is silently truncated at the
        // viewport, so a story taller than 720px was only ever compared down
        // to the fold — one story here is 1256px tall and 43% of it was
        // uncovered. And `fullPage` alone frames a button in 1280px of empty
        // white, which is unreadable in a three-column diff table.
        //
        // The box is measured in document coordinates, so it can extend past
        // the fold; `fullPage` is what lets the clip follow it down there.
        const clip = await page.evaluate((pad) => {
          const root = document.querySelector('#storybook-root');
          if (!root) return null;

          // Measured over the whole body, not just the story root. Radix mounts
          // popovers, tooltips, dropdowns and dialogs through a portal into
          // `document.body`, so a box drawn around `#storybook-root` alone
          // frames the trigger button and crops away the thing the story exists
          // to show. `ui-popover--overview` renders `<Popover defaultOpen>` and
          // its baseline was two buttons and nothing else.
          const rects = [...document.body.querySelectorAll('*')]
            .map((el) => el.getBoundingClientRect())
            .filter((r) => r.width > 0 && r.height > 0);
          if (!rects.length) return null;

          const doc = document.documentElement;
          const { scrollX, scrollY } = window;
          const left = Math.max(0, Math.min(...rects.map((r) => r.left + scrollX)) - pad);
          const top = Math.max(0, Math.min(...rects.map((r) => r.top + scrollY)) - pad);
          const right = Math.min(doc.scrollWidth, Math.max(...rects.map((r) => r.right + scrollX)) + pad);
          const bottom = Math.min(doc.scrollHeight, Math.max(...rects.map((r) => r.bottom + scrollY)) + pad);

          // A story that drew nothing measurable leaves an empty box, and
          // Playwright rejects a clip like that. Fall back to the whole page.
          if (right - left < 1 || bottom - top < 1) return null;

          return {
            x: Math.floor(left),
            y: Math.floor(top),
            width: Math.max(1, Math.ceil(right - left)),
            height: Math.max(1, Math.ceil(bottom - top)),
          };
        }, 12);

        await page.screenshot({ path: file, fullPage: true, animations: 'disabled', caret: 'hide', ...(clip ? { clip } : {}) });
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

  await Promise.all(Array.from({ length: Math.min(workers, total) }, worker));
  await browser.close();
  return { shots, failures };
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

const { server, port } = await serve(STATIC);

const optedOut = new Set(stories.length ? await readOptOuts(port, stories.map((s) => s.id)) : []);
const toCapture = stories.filter((s) => !optedOut.has(s.id));
if (optedOut.size) console.log(`${optedOut.size} opted out with chromatic.disableSnapshot`);

console.log(`Capturing ${toCapture.length} stories${quarantined.size ? `, ${quarantined.size} quarantined` : ''}`);
const { shots, failures } = await capture(port, toCapture, shotDir);

const baseline = read(MANIFEST, {});
const store = openStore();
console.log(`Store: ${store.describe()}`);

const changed = [];
const added = [];
for (const [id, hash] of Object.entries(shots)) {
  if (!(id in baseline)) added.push({ id, hash });
  else if (baseline[id] !== hash) changed.push({ id, hash, was: baseline[id] });
}
// A story that failed to render is absent from `shots`, which would otherwise
// classify it as removed — and approving a run deletes removed stories from the
// manifest. One timeout would silently drop a story's baseline, and the next
// approve would re-baseline whatever it happened to render.
const failedIds = new Set(failures.map((f) => f.id));
const removed = Object.keys(baseline).filter(
  (id) => !(id in shots) && !quarantined.has(id) && !optedOut.has(id) && !failedIds.has(id),
);

// Where each story's final image lives on disk. Only a confirmed blip moves.
const source = Object.fromEntries(Object.keys(shots).map((id) => [id, path.join(shotDir, `${id}.png`)]));

// A story that disagrees under load and agrees when asked again was never
// disagreeing about anything. Capture the handful that moved a second time,
// alone and with a longer pause, and keep only the ones that still differ.
//
// This is the difference between a gate people trust and one they mute: a
// four-core runner with four workers gives each story less CPU than a laptop
// does, and the stories that lose that race are not the stories that changed.
if (changed.length && changed.length <= RETRY_LIMIT) {
  console.log(`\nConfirming ${changed.length} change(s) with a second capture`);
  const retryDir = path.join(WORK, 'retry');
  fs.mkdirSync(retryDir, { recursive: true });

  // One worker, twice the pause: the retry exists to remove contention, so it
  // must not run under the conditions that caused the disagreement.
  const { shots: again } = await capture(
    port,
    changed.map((e) => toCapture.find((s) => s.id === e.id)).filter(Boolean),
    retryDir,
    { workers: 1, settleMs: SETTLE_MS * 2 },
  );

  const blips = changed.filter((e) => again[e.id] === e.was);
  for (const blip of blips) {
    changed.splice(changed.indexOf(blip), 1);
    shots[blip.id] = blip.was; // it matches the baseline; leave the manifest alone
    // And stage the retry's image, not the first capture's. They hash
    // differently by definition, so copying the first one under the baseline's
    // name would file the wrong pixels under that hash and quietly corrupt
    // every future comparison against it.
    source[blip.id] = path.join(retryDir, `${blip.id}.png`);
  }
  if (blips.length) {
    console.log(`${blips.length} did not reproduce and were dropped: ${blips.map((b) => b.id).join(', ')}`);
  }
}

server.close();

// Stage every image captured, not only the ones that moved. Sync skips what
// the store already holds, so the extra cost is a local copy — and it makes the
// store self-healing. Staging only the changes means a run whose upload failed
// leaves those baselines missing from the store forever: nothing re-uploads
// them, and every later diff for those stories shows a broken "before".
//
// After confirmation, so a change that did not reproduce leaves no orphan.
for (const [id, hash] of Object.entries(shots)) {
  if (fs.existsSync(source[id])) fs.copyFileSync(source[id], path.join(blobDir, `${hash}.png`));
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

// `total` is what was actually compared. Counting the opted-out and the
// quarantined in it would let the comment claim coverage the run never had —
// the one thing a gate must never do.
const summary = {
  runId: RUN_ID,
  total: toCapture.length,
  optedOut: optedOut.size,
  quarantined: quarantined.size,
  added,
  changed,
  removed,
  failures,
  unmoved: unmoved.length,
  published,
};
fs.writeFileSync(path.join(reportDir, 'summary.json'), JSON.stringify(summary, null, 2));
fs.writeFileSync(path.join(reportDir, 'index.html'), renderReport(summary));

try {
  store.publish(reportDir, `report/${RUN_ID}`);
} catch {
  // Already reported above; the report is still in the run directory.
}

const accepted = acceptAll ? [...added, ...changed].map((e) => e.id) : acceptOnly;
if (accepted.length || (acceptAll && removed.length)) {
  const unknown = accepted.filter((id) => !(id in shots));
  if (unknown.length) {
    console.error(`Not captured in this run: ${unknown.join(', ')}`);
    process.exit(2);
  }
  const merged = { ...baseline };
  for (const id of accepted) merged[id] = shots[id];
  if (acceptAll) for (const id of removed) delete merged[id];
  fs.writeFileSync(MANIFEST, `${JSON.stringify(sortKeys(merged), null, 2)}\n`);
  console.log(`\nAccepted ${accepted.length} snapshot(s) into ${MANIFEST}`);
}
console.log(`\n${added.length} added · ${changed.length} changed · ${removed.length} removed`);
const reportAt = store.describe().replace(/\/$/, '');
console.log(`Report: ${reportAt}/report/${RUN_ID}/index.html`);

// A story that would not render is a failure of the gate, not a footnote.
// Leaving it out of the exit code is how a run goes green over a blank page.
const dirty = added.length + changed.length + removed.length;
process.exit((dirty && !acceptAll) || failures.length ? 1 : 0);

function sortKeys(obj) {
  return Object.fromEntries(Object.entries(obj).sort(([a], [b]) => a.localeCompare(b)));
}
