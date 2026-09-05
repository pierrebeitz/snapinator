# snapinator

Visual regression testing for Storybook, without the SaaS bill and without
running a service.

Chromatic has no self-hosted edition. What it actually sells is three separate
things — a deterministic screenshot runner, somewhere to put the pixels, and an
approve/deny UI with an audit trail. The first two are small. The third one you
already own: **a pull request comment and a commit status are the approval
service.**

---

## The idea

```
s3://bucket/baseline/main.json  storyId → sha256      ← what main looks like
s3://bucket/baseline/pr-42.json storyId → sha256      ← what #42 accepted
s3://bucket/img/<sha256>.png    every snapshot ever   ← immutable, deduped
s3://bucket/report/<run>/       before | after | diff ← a static HTML page
```

Main captures with `--accept`, so `baseline/main.json` is always what main
actually looks like — never a manifest someone forgot to update. A pull request
compares against that, and `/approve-visual` writes what it saw into its own
overlay. Merging is what makes an approval everyone else's baseline.

**Approve** = overwrite one pointer. **Deny** = don't merge.

The verdict is the `Visual` commit status, not the job that produced it: a job
has two colours and "someone needs to look at this" is neither.

| | |
|---|---|
| 🟡 pending | stories moved and nobody has accepted them |
| 🟢 success | nothing moved, or `/approve-visual` accepted what did |
| 🔴 failure | a story never rendered, or the capture died |

Which means review, permissions and required approvers are the ones you already
have, working the way they already work — and approving costs one write instead
of a commit and a second full capture.

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

Then run the loop against a throwaway store, so the real baseline stays put:

```bash
yarn selfcheck
```

It seeds a baseline as main, recolours the button, proves a pull request catches
it, approves it, deletes a story and approves that too — through the real
pipeline, not a mock. It also asserts the properties the moving parts exist for:
approving on a pull request never moves main's baseline, an accepted removal
leaves a tombstone the next run reads as "gone, and that is fine", a settled
suite photographs nothing at all, and a component reached only through
`React.lazy` still re-photographs the stories that render it.

Note what it asserts: **three** stories move, not one. `Card` renders a
`Button`, so recolouring the button moves every story downstream of it. That
blast radius is the reason to look at a report instead of trusting a changelog.

`snap.mjs` prints the path to each report — `open` it:

```
3 snapshots moved
Report: .snapinator/selfcheck/store/report/2026-09-03T17-35-17-289Z/index.html
```

The default store is a local directory, so all of that runs offline. Point
`SNAPINATOR_STORE` at a bucket and nothing else changes.

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
gh variable set SNAPINATOR_PUBLIC_URL --body https://OWNER.github.io/REPO
```

Costs nothing, needs no cloud account, and works on any public repository. The
branch only grows by what actually changed, because the blobs are named after
their own hashes.

### S3 — for a private repository

Pages on a private repo is auth-gated, so the proxy cannot read it. Use a bucket
with public read on the prefix:

| Variable | Example |
| --- | --- |
| `SNAPINATOR_STORE` | `s3://my-bucket/visual` |
| `SNAPINATOR_PUBLIC_URL` | `https://d1234.cloudfront.net/visual` |
| `AWS_ROLE_ARN` | `arn:aws:iam::…:role/github-actions` |
| `AWS_REGION` | `eu-central-1` |

Setting `SNAPINATOR_STORE` switches both workflows to S3 and skips the branch
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
3. Until someone accepts, the `Visual` status on that commit is yellow. Add it
   to the ruleset and yellow blocks the merge.
4. They comment `/approve-visual`. All of it or none of it: with no second
   capture to correct a wrong guess, a partial approval would have to settle the
   check green over the stories nobody named.
5. [`approve.yml`](.github/workflows/approve.yml) checks `author_association`,
   writes the pull request's overlay, and turns the status green on the head
   commit.

The comment is edited in place across pushes, so a story approved earlier stops
being flagged and only genuinely new movement shows up.

Step 5 does **not** re-run the browser, and does not push a commit. The pixels
are already in the store under their content hash, so accepting is one
overwritten pointer — it takes seconds, and it cannot disagree with what the
reviewer actually looked at.

The permission check is one line, because the question "may this person approve"
is the same question as "may this person write to the repo", and GitHub has
already answered it.

---

## Not photographing what cannot have moved

The capture is nearly all of the wall clock, and most pull requests never go
near most of the suite. A story whose inputs have not moved since a run that
photographed it cannot look different, so that run's answer still stands.

Each run records what it proved — `fingerprint -> the hash it photographed` —
and a later run skips any story whose fingerprint still matches a recording that
agrees with the current baseline. Both halves carry weight: the fingerprint says
the build and the browser are the same, the recorded hash says that pair produced
*this* baseline. Neither alone is enough.

The fingerprint comes from the bundler's own output. Storybook splits the suite
into content-hashed chunks and writes the graph into their import statements, so
a story's fingerprint is the contents of its own chunk closure plus the preview
runtime that `iframe.html` names — with the content hashes stripped out of every
name, because a name moves whenever anything it merely points at moves. There is
no externals list and no globs, so nothing can fall behind the code.

Three rules keep it from ever skipping something that did move:

- **Only main records proofs, and a run that records one takes the photograph.**
  A branch recording its own build would offer every other branch a verdict on a
  tree nobody merged; a run that skipped on its own proof would re-record it and
  preserve drift no fingerprint can see — a font, a container rebuild — forever.
- **Outside the entry's closure, every reference is followed, lazy ones
  included.** A component reached through `React.lazy` decides the pixel exactly
  as much as one reached directly. (The entry is the exception: its lazy map
  names the whole suite.)
- **A split build that parses no import edges is a failure, not a flat graph.**
  Every closure would silently collapse to the story's own chunk, and the skip
  would start certifying stale screenshots. It refuses instead.

Whatever the fingerprint cannot see has to be in the salt: the browser version,
the viewport, the settle, and `snap.mjs` itself — the frozen clock and the
animation kill never reach the build output.

Stylesheets, fonts and images are shared by every fingerprint rather than traced,
because their graph is not in their contents. A font that moves re-photographs
the suite, which is the honest answer for a font.

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
yarn snap:docker    # captures twice in the container, compares the baselines
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
