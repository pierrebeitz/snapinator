/*
 * The review UI. A single static HTML file with no JS build step and no server:
 * it sits in the store next to the blobs and links to them with relative paths,
 * so the same file works on a local disk and behind CloudFront.
 */

// Every image the report needs sits in an `img/` folder beside it, so the page
// works from a bucket, a downloaded artifact, or a laptop with no network.
const img = (hash) => `img/${hash}.png`;

export function renderReport({ runId, total, skipped = 0, added, changed, removed, failures = [] }) {
  const dirty = added.length + changed.length + removed.length + failures.length;
  const ids = [...added, ...changed].map((e) => e.id);

  return `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>snapinator · ${runId}</title>
<style>
  :root { color-scheme: light dark; --bg:#fff; --fg:#1a1a1a; --muted:#5a6472; --line:#e2e8f0; --card:#fff; --accent:#2b6cb0; }
  @media (prefers-color-scheme: dark) { :root { --bg:#0f1319; --fg:#e6eaf0; --muted:#8b97a8; --line:#252c38; --card:#161b23; } }
  body { margin:0; background:var(--bg); color:var(--fg); font:14px/1.5 ui-sans-serif,system-ui,sans-serif; }
  header { padding:32px 32px 0; }
  h1 { margin:0 0 4px; font-size:20px; }
  .sub { color:var(--muted); }
  main { padding:24px 32px 64px; display:grid; gap:24px; }
  .story { border:1px solid var(--line); border-radius:12px; background:var(--card); overflow:hidden; }
  .story > h2 { margin:0; padding:14px 18px; font-size:14px; font-family:ui-monospace,monospace; border-bottom:1px solid var(--line); display:flex; gap:10px; align-items:center; }
  .tag { font:600 11px/1 ui-sans-serif,sans-serif; padding:4px 8px; border-radius:999px; text-transform:uppercase; letter-spacing:.04em; }
  .tag.changed { background:#feebc8; color:#7b341e; }
  .tag.added { background:#c6f6d5; color:#22543d; }
  .tag.removed { background:#fed7d7; color:#742a2a; }
  .px { font:400 12px/1 ui-sans-serif,sans-serif; color:var(--muted); margin-left:auto; }
  .frames { display:grid; grid-template-columns:repeat(auto-fit,minmax(280px,1fr)); gap:1px; background:var(--line); }
  figure { margin:0; background:var(--card); padding:14px; }
  figcaption { color:var(--muted); font-size:12px; margin-bottom:8px; }
  img { display:block; width:100%; border:1px solid var(--line); border-radius:6px; background:#fff; }
  .empty { padding:48px 32px; color:var(--muted); }
  code { font-family:ui-monospace,monospace; background:var(--line); padding:2px 6px; border-radius:4px; }
  .approve { margin:8px 32px 0; padding:16px 18px; border:1px solid var(--line); border-radius:12px; background:var(--card); }
  .approve p { margin:0 0 8px; color:var(--muted); }
  .approve code { display:block; padding:10px 12px; background:transparent; border:1px solid var(--line); overflow-x:auto; white-space:pre; }
</style>
<header>
  <h1>${dirty ? `${dirty} snapshot${dirty === 1 ? '' : 's'} moved` : 'No visual changes'}</h1>
  <p class="sub">${total} stories captured${skipped ? ` · ${skipped} unchanged and not re-photographed` : ''} · run <code>${runId}</code></p>
</header>
${dirty ? `<div class="approve">
  <p>Approve every change on the pull request by commenting:</p>
  <code>/approve-visual</code>
  <p style="margin:10px 0 0">Or name the ones you trust:</p>
  <code>/approve-visual ${ids.join(' ')}</code>
</div>` : ''}
<main>
${changed.map(changedCard).join('\n')}
${added.map(addedCard).join('\n')}
${removed.map(removedCard).join('\n')}
${failures.map(failedCard).join('\n')}
${dirty ? '' : '<p class="empty">Every story matched its baseline byte for byte.</p>'}
</main>
`;
}

const changedCard = ({ id, was, hash, diff, pixels }) => `<section class="story">
  <h2>${id}<span class="tag changed">changed</span>${
    typeof pixels === 'number' ? `<span class="px">${pixels.toLocaleString('en-US')} px moved</span>` : ''
  }</h2>
  <div class="frames">
    <figure><figcaption>baseline · ${was.slice(0, 12)}</figcaption><img src="${img(was)}" alt="baseline"></figure>
    <figure><figcaption>current · ${hash.slice(0, 12)}</figcaption><img src="${img(hash)}" alt="current"></figure>
    ${diff ? `<figure><figcaption>diff</figcaption><img src="${img(diff)}" alt="diff"></figure>`
           : `<figure><figcaption>diff</figcaption><p class="sub">The baseline image is not in the store, so there is nothing to compare against. Usually an upload that failed when this baseline was first taken.</p></figure>`}
  </div>
</section>`;

const addedCard = ({ id, hash }) => `<section class="story">
  <h2>${id}<span class="tag added">new</span></h2>
  <div class="frames">
    <figure><figcaption>current · ${hash.slice(0, 12)}</figcaption><img src="${img(hash)}" alt="current"></figure>
  </div>
</section>`;

const failedCard = ({ id, reason }) => `<section class="story">
  <h2>${id}<span class="tag removed">did not render</span></h2>
  <div class="frames"><figure><p class="sub">${reason}</p></figure></div>
</section>`;

const removedCard = (id) => `<section class="story">
  <h2>${id}<span class="tag removed">gone</span></h2>
  <div class="frames"><figure><p class="sub">This story no longer exists in the build.</p></figure></div>
</section>`;
