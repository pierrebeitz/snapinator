#!/usr/bin/env node
/*
 * One hash per story, over everything that decides what it looks like.
 *
 *   node visual/fingerprint.mjs <storybook-static>   print every story's hash
 *
 * A story whose fingerprint has not moved since a run that photographed it
 * cannot look different, so that run's hash still stands and the story does not
 * need photographing again. That is the whole of the skip in snap.mjs.
 *
 * The bundler has already worked out what each story loads: it splits the suite
 * into content-hashed chunks and writes the graph into their import statements.
 * Walking it needs no configuration and cannot fall behind the code — which is
 * the whole difference from a list of globs.
 *
 * Outside the entry's own closure every reference counts, lazy ones included: a
 * component reached through `React.lazy` decides the pixel exactly as much as
 * one reached directly, and skipping a story because its lazy half was invisible
 * is the one mistake this file must never make. The entry is the exception —
 * its lazy map names every story in the suite, so following it would put the
 * whole suite in everybody's closure.
 *
 * Everything is hashed with the content hashes stripped out of the names it
 * carries — its own included. A file's name moves whenever anything it points
 * at moves, and leaving that in spreads every change to everything that merely
 * mentions the file: the entry names every story in the suite, and
 * `iframe.html` names the entry.
 *
 * The salt carries what does the rendering rather than what is being rendered:
 * the browser, the viewport, the pause. A container bump moves every
 * fingerprint, which is the point, because that drift is exactly what a skipped
 * story would otherwise hide.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Rewritten on every build and loaded by nothing the capture photographs, so
// including them would move every fingerprint on every run and skip nothing.
// `build-info.json` carries the commit and the wall clock; `.storybook/main.ts`
// pins the copy that stories actually import, for the same reason.
//
// Everything else in the output is byte-identical between two builds of the
// same source — but only with react-docgen off, whose extracted enum members
// come out in the type checker's order. See `.storybook/main.ts`.
const IGNORED = new Set(["manifests", "project.json", "build-info.json"]);

// `from"./x.js"` and a bare `import"./x.js"`. Used for the entry's closure,
// where the lazy references are the suite's own story map.
const STATIC_IMPORT = /(?:^|[;}\s])(?:import|from)\s*"\.\/([\w.\-]+\.js)"/g;
// Every relative reference a chunk makes, however it makes it: `import(...)`,
// a preload array, a static import. Used everywhere except the entry closure.
const ANY_IMPORT = /"\.\/([\w.\-]+\.js)"/g;

const sha256 = (data) => createHash("sha256").update(data).digest("hex");

// Rolldown names a file after what is inside it, so a file's name moves
// whenever anything it merely points at moves. Stripping the hash out of both
// the name and the text leaves what actually changed.
const TEXT = /\.(html|css|json|js|map|svg|txt)$/;
const unhash = (text) => text.replace(/([\w.\-]+)-[\w-]{8}(\.\w+)/g, "$1$2");
const identify = (staticDir, file) => {
  const bytes = fs.readFileSync(path.join(staticDir, file));
  return `${unhash(file)}\0${sha256(TEXT.test(file) ? unhash(bytes.toString("utf8")) : bytes)}`;
};

const listFiles = (dir, rel = "") =>
  fs
    .readdirSync(path.join(dir, rel), { withFileTypes: true })
    .filter((e) => !IGNORED.has(rel ? `${rel}/${e.name}` : e.name))
    .flatMap((e) =>
      e.isDirectory()
        ? listFiles(dir, rel ? `${rel}/${e.name}` : e.name)
        : [rel ? `${rel}/${e.name}` : e.name]
    )
    .sort();

function readBuild(staticDir) {
  const files = listFiles(staticDir);
  const js = files.filter((f) => /^assets\/[^/]+\.js$/.test(f));

  const chunks = new Map();
  for (const file of js) {
    const source = fs.readFileSync(path.join(staticDir, file), "utf8");
    chunks.set(path.basename(file), {
      imports: [...source.matchAll(STATIC_IMPORT)].map((m) => m[1]),
      all: [...new Set([...source.matchAll(ANY_IMPORT)].map((m) => m[1]))],
      hash: sha256(unhash(source)),
    });
  }

  // A split build with no edges is a parse failure, not a flat graph. Every
  // closure would collapse to the story's own chunk, a change to any component
  // it renders would move no fingerprint, and the skip would certify a stale
  // screenshot in silence. Refuse rather than answer.
  const edges = [...chunks.values()].reduce((n, c) => n + c.imports.length, 0);
  if (chunks.size > 1 && edges === 0) {
    throw new Error(
      `No imports parsed from ${chunks.size} chunks — the bundler's output format moved`
    );
  }

  // One bucket for everything that is not a chunk — the stylesheets, the fonts,
  // the images, `iframe.html` itself. Their graph is not in their contents, so
  // they are shared by every fingerprint rather than traced: a font that moves
  // re-photographs the suite, which is the honest answer for a font.
  const rest = sha256(
    files
      .filter((f) => !js.includes(f))
      .map((f) => identify(staticDir, f))
      .join("\n")
  );

  // The preview runtime every story loads, named by `iframe.html` rather than
  // guessed: the entry chunk's own contents name every story in the suite.
  const html = fs.readFileSync(path.join(staticDir, "iframe.html"), "utf8");
  const entry = [...html.matchAll(/assets\/([\w.\-]+\.js)/g)].map((m) => m[1]);

  return { chunks, rest, shared: closure(chunks, entry) };
}

// `shared` is the entry's own closure, and the chunks in it are followed
// statically: the entry lazily names every story in the suite. Everything
// outside it is followed through every reference it makes.
function closure(chunks, roots, shared) {
  const seen = new Set(roots);
  const queue = [...roots];
  for (let file; (file = queue.pop()); ) {
    const chunk = chunks.get(file);
    const edges = !shared || shared.has(file) ? chunk?.imports : chunk?.all;
    for (const next of edges ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return seen;
}

// Two story files can share a basename — `QSpinner.stories.tsx` exists in both
// the extension and the desktop package — and the built name keeps no trace of
// which is which. An ambiguous story falls back to the whole build below, which
// costs it a photograph it may not have needed and never skips one it did.
function chunkIndex(chunks) {
  const byName = new Map();
  for (const file of chunks.keys()) {
    const name = file.replace(/-[\w-]{8}\.js$/, "");
    byName.set(name, byName.has(name) ? null : file);
  }
  return byName;
}

export function fingerprints(staticDir, stories, salt) {
  const { chunks, rest, shared } = readBuild(staticDir);
  const byName = chunkIndex(chunks);
  // Content hashes, sorted as hashes: a filename carries the hash of what is
  // inside it, so ordering by name makes the digest move whenever two chunks
  // sharing a name prefix swap places. A chunk that was only renamed is the
  // same code, and this says so.
  const hashOf = (files) =>
    [...files]
      .map((f) => chunks.get(f)?.hash ?? unhash(f))
      .sort()
      .join("\n");
  const whole = hashOf(chunks.keys());

  return new Map(
    stories.map((story) => {
      const name = path.basename(story.importPath).replace(/\.\w+$/, "");
      const chunk = byName.get(name);
      const reached = chunk ? hashOf(closure(chunks, [chunk, ...shared], shared)) : whole;
      // The id is in the hash because stories share a file, and so a closure:
      // one fingerprint per story is what lets the cache be a flat map.
      return [story.id, sha256(`${salt}\0${story.id}\0${rest}\0${reached}`)];
    })
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2] ?? "storybook-static";
  const index = JSON.parse(fs.readFileSync(path.join(dir, "index.json"), "utf8"));
  const stories = Object.values(index.entries).filter((e) => e.type === "story");
  for (const [id, fp] of fingerprints(dir, stories, "")) console.log(`${fp}  ${id}`);
}
