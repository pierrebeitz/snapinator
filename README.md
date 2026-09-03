# snapmatic

Visual regression testing for Storybook, without the SaaS bill and without
running a service.

Chromatic has no self-hosted edition. What it actually sells is three separate
things — a deterministic screenshot runner, somewhere to put the pixels, and an
approve/deny UI with an audit trail. The first two are small. The third one you
already own: **git is the approval service.**

---

## The idea

```
snapshots.json                  storyId → sha256      ← the only thing in git
s3://bucket/img/<sha256>.png    every snapshot ever   ← immutable, deduped
s3://bucket/report/<run>/       before | after | diff ← a static HTML page
```

**Approve** = commit the new hash. **Deny** = don't merge.

A pull request that moves three snapshots shows up as three changed lines:

```diff
   "button--primary": "a3f1c8…",
-  "card--default": "9c2d04…",
+  "card--default": "71be5a…",
   "badge--success": "0ef7a2…",
```

Which means review, permissions, history, blame, revert and required approvers
are the ones you already have, working the way they already work.

### Why content-addressed

Naming a blob after its own hash is the trick the rest of the design rests on.

- An unchanged story hashes the same, so it uploads **zero bytes**. A 400-story
  suite where four things moved transfers four PNGs.
- Every branch's baselines coexist. There is no "current" pointer to race on,
  and no cleanup job.
- Objects are immutable, so `Cache-Control: max-age=31536000, immutable` is
  honest and you never invalidate a CDN.
- A manifest and a store can't drift into an inconsistent state. A hash either
  resolves or it doesn't.

---

## Try it, no AWS needed

```bash
yarn install
yarn playwright install chromium
yarn build-storybook

yarn snap:accept      # seed the baseline — writes snapshots.json
```

Now break something on purpose:

```bash
sed -i '' 's/#2b6cb0/#7c3aed/' src/components/Button.jsx
yarn build-storybook && yarn snap
```

Exit code 1, and the command prints the path to a report — `open` it:

```
3 snapshots moved
Report: .snapmatic/store/report/2026-09-03T17-35-17-289Z/index.html
```

Three, not one: `Card` renders a `Button`, so changing the button moves every
story downstream of it. That blast radius is the reason to look at a report
instead of trusting a changelog.

The default store is a local directory (`.snapmatic/store`), so all of that
runs offline. Point `SNAPMATIC_STORE` at a bucket and nothing else changes.

---

## Wiring it to S3

```bash
export SNAPMATIC_STORE="s3://my-bucket/visual"
node scripts/snap.mjs
```

The store shells out to the `aws` CLI, so it inherits whatever credentials the
environment already has — in CI that's an OIDC role, no long-lived keys. Two
repository variables and you're done:

| Variable | Example |
| --- | --- |
| `SNAPMATIC_STORE` | `s3://my-bucket/visual` |
| `SNAPMATIC_PUBLIC_URL` | `https://d1234.cloudfront.net/visual` |
| `AWS_ROLE_ARN` | `arn:aws:iam::…:role/github-actions` |
| `AWS_REGION` | `eu-central-1` |

The bucket needs `PutObject` and `GetObject` on that prefix. Nothing else.

---

## The approve flow

1. A pull request runs [`visual.yml`](.github/workflows/visual.yml) in a pinned
   Playwright container, publishes the report, and edits a single PR comment
   with the link.
2. A human opens the report and looks at the diffs.
3. They comment `/approve-visual`, or `/approve-visual card--default` to accept
   only some of them.
4. [`approve.yml`](.github/workflows/approve.yml) checks `author_association`,
   rewrites `snapshots.json`, and pushes to the branch.

Step 4 does **not** re-run the browser. The pixels are already in the store
under their content hash, so accepting is pure bookkeeping — it takes seconds,
and it cannot disagree with what the reviewer actually looked at.

The permission check is one line, because the question "may this person approve"
is the same question as "may this person write to the repo", and GitHub has
already answered it.

---

## Determinism

This is the part that decides whether any of it works. The diffing is easy;
making two runs produce the same bytes is not.

**Baselines are only ever produced inside `mcr.microsoft.com/playwright:<exact
version>`.** The container tag in `visual.yml` is pinned to the same version as
the `playwright` dependency in `package.json`. Bump one, bump the other.

Everything else is defensive:

- `src/reset.css` kills all animations and transitions, and hides the caret.
  A screenshot that lands mid-tween is the most common flaky diff there is.
- No `system-ui` anywhere. That font is a different face on every OS. Name real
  families that exist in the container.
- `snap.mjs` fixes the viewport, `deviceScaleFactor`, colour scheme, locale and
  timezone, and waits on `document.fonts.ready` before every shot.

Verify the whole chain before trusting it:

```bash
yarn snap:docker    # captures twice in the container, compares the manifests
```

If that isn't byte-identical, fix it before building anything on top.

---

## What this deliberately doesn't do

| Not here | Add it when |
| --- | --- |
| Parallel capture | The suite takes more than a couple of minutes. `snap.mjs` uses one page; give it N contexts. |
| Cross-browser / viewport matrix | You ship a bug that only Firefox or a phone shows. The manifest key becomes `storyId@firefox-390`. |
| Story interactions before the shot | A story needs a click first. Run its `play()` between `goto` and `screenshot`. |
| A hosted approve button | `/approve-visual` genuinely annoys you. Note that the moment you build one, you own "who may approve" — the thing GitHub was doing for free. |
| Perceptual diffing | Anti-aliasing noise survives the container. `pixelmatch`'s `threshold` is already the knob. |
| Cropping to the story's content | Shots frame `#storybook-root` at full width on purpose — a component that quietly becomes `100%` wide should show up as a diff, and a content-hugging crop would hide it. |

Roughly 400 lines of script, and three runtime dependencies: `playwright`,
`pixelmatch`, `pngjs`. Everything else in `package.json` is the demo Storybook
being tested, not the tool.
