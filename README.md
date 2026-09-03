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

## The path for someone who never opens a terminal

This is the case the whole thing is built around. A designer changes a colour
using GitHub's own web editor:

1. Open `src/components/Button.jsx` on github.com, click the pencil, change
   `#2b6cb0` to `#7c3aed`.
2. **Commit changes…** → *Create a new branch and start a pull request*.
3. Wait about two minutes. A comment appears on the pull request with
   **before, after, and a diff image, rendered inline** — no link to follow, no
   report to open, no tool to install. The captures are cropped to what the
   story actually drew, so a button reads as a button rather than a speck in an
   empty frame.
4. It shows three stories, not one, because `Card` renders `Button`. Seeing the
   blast radius is the entire point.
5. If it looks right: comment `/approve-visual`. A bot commits the new hashes to
   the branch. Merge.

Nothing was installed and nothing was run locally. The only thing that gates
approval is write access to the repository, which GitHub already tracks.

If it looks wrong, they change the hex again and push. The comment is edited in
place rather than appended, so the pull request never becomes a wall of stale
screenshots.

---

## Try it

```bash
yarn install
yarn playwright install chromium
yarn build-storybook
yarn snap
```

**Every one of the eight stories will differ.** That is not a bug — it is the
most important thing in this repository, and it is better learned by running it
than by reading about it. The committed baseline was produced inside the pinned
container; your laptop has different fonts and a different renderer, so it
cannot reproduce those bytes and never will. Baselines that a developer machine
can write are baselines that break for everyone else.

Do it properly instead:

```bash
yarn snap:docker     # captures twice in the pinned container, compares
```

That is the only capture path that is allowed to produce a baseline.

### Seeing a real change

```bash
sed -i '' 's/#2b6cb0/#7c3aed/' src/components/Button.jsx
```

Then run the loop against a throwaway manifest, so the committed one stays put:

```bash
yarn selfcheck
```

It seeds a baseline, recolours the button, proves the change is caught, approves
one story, approves the rest, and proves the suite goes quiet again — through
the real pipeline, not a mock.

Note what it asserts: **three** stories move, not one. `Card` renders a
`Button`, so recolouring the button moves every story downstream of it. That
blast radius is the reason to look at a report instead of trusting a changelog.

`snap.mjs` prints the path to each report — `open` it:

```
3 snapshots moved
Report: .snapmatic/selfcheck/store/report/2026-09-03T17-35-17-289Z/index.html
```

The default store is a local directory, so all of that runs offline. Point
`SNAPMATIC_STORE` at a bucket and nothing else changes.

## Where the images live

Inline images are the whole experience, and they set one hard requirement:
**the images must be readable without authentication.** GitHub renders a
comment's images through its own proxy, which fetches them anonymously — a URL
that needs a login renders as nothing. (Data URIs do not help: GitHub's
sanitiser strips `src` off them. Chromatic has the same constraint; they just
own the CDN.)

Two ways to satisfy it.

### GitHub Pages — no infrastructure

What this repository uses. The store is an orphan branch, `visual-store`,
served by Pages. Each run clones it for the baselines it needs to diff against,
pushes the new blobs back, and waits for Pages to serve them before the comment
links to them — GitHub's proxy caches a 404 as eagerly as it caches an image.

```bash
git switch --orphan visual-store && touch .nojekyll && git commit -am init && git push -u origin visual-store
gh api repos/OWNER/REPO/pages -X POST -f 'source[branch]=visual-store' -f 'source[path]=/'
gh variable set SNAPMATIC_PUBLIC_URL --body https://OWNER.github.io/REPO
```

Costs nothing, needs no cloud account, and works on any public repository. The
branch only grows by what actually changed, because the blobs are named after
their own hashes.

### S3 — for a private repository

Pages on a private repo is auth-gated, so the proxy cannot read it. Use a bucket
with public read on the prefix:

| Variable | Example |
| --- | --- |
| `SNAPMATIC_STORE` | `s3://my-bucket/visual` |
| `SNAPMATIC_PUBLIC_URL` | `https://d1234.cloudfront.net/visual` |
| `AWS_ROLE_ARN` | `arn:aws:iam::…:role/github-actions` |
| `AWS_REGION` | `eu-central-1` |

Setting `SNAPMATIC_STORE` switches both workflows to S3 and skips the branch
entirely. The store shells out to the `aws` CLI, so it inherits whatever
credentials the environment has — in CI an OIDC role, no long-lived keys.

Snapshots of UI components are usually not secret even when the code is, but
that is a judgement call worth making deliberately rather than by default.

---

## The approve flow

1. A pull request runs [`visual.yml`](.github/workflows/visual.yml) in a pinned
   Playwright container, publishes the images, and edits a single PR comment to
   show them inline.
2. A human looks at the pictures without leaving the pull request. (The comment
   also links a fuller report for runs too large to inline.)
3. They comment `/approve-visual`, or `/approve-visual card--default` to accept
   only some of them.
4. [`approve.yml`](.github/workflows/approve.yml) checks `author_association`,
   rewrites `snapshots.json`, and pushes to the branch.
5. It then marks the `Visual` check green on the commit it just made — because
   a push authenticated with `GITHUB_TOKEN` deliberately does not start a
   workflow, so that commit would otherwise sit at `action_required` and block
   the merge. Push with a PAT or a GitHub App token if you would rather have a
   real second run.

The comment is edited in place across pushes, so a story approved earlier stops
being flagged and only genuinely new movement shows up.

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
version>`.** The `playwright` dependency is pinned exactly — no caret. A range
lets the installed browser drift away from the container tag, and the only
symptom is a container that refuses to launch, days later, in someone else's
build. `yarn snap:docker` compares the two and fails loudly if they part ways.

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

---

## Does it actually work

Yes — [pull request #1](../../pull/1) is the real thing, not a mock-up. It
recolours a button, catches three moved stories, approves them by comment, then
catches a fourth change on a later push and approves that one too.

The detail worth pausing on: the committed baseline was captured in a container
on a Mac, and GitHub's Linux runner reproduced five of the eight stories **byte
for byte**. Only the three that genuinely changed came back different. That is
the property the whole design rests on, and it holds across machines, not just
across two runs on one machine.

A capture takes about a minute for eight stories.
