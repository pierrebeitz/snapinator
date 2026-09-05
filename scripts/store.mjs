/*
 * A content-addressed blob store with two backends.
 *
 * Keys are `img/<sha256>.png`, so a key never changes meaning: same key, same
 * bytes, forever. That buys three things for free — an unchanged story uploads
 * nothing, every branch's baselines coexist without collision, and objects can
 * be cached until the heat death of the universe.
 *
 * Everything reads via relative paths from the report, so there is no
 * public-URL setting to get wrong.
 *
 * `put` is the one exception to the content-addressed rule: the baseline is a
 * pointer, and a pointer has to be overwritable to be a pointer.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export function openStore(spec = process.env.SNAPINATOR_STORE || '.snapinator/store') {
  const backend = spec.startsWith('s3://') ? s3Store(spec) : localStore(spec);
  return { ...backend, ...json(backend) };
}

// Both backends move files rather than strings, so the round trip through a
// scratch file lives here once instead of at every pointer.
function json(store) {
  const scratch = (key) => path.join('.snapinator', 'json', key.replace(/[^\w.-]/g, '_'));
  return {
    readJson(key, fallback) {
      const file = scratch(key);
      return store.fetch(key, file) ? JSON.parse(readFileSync(file, 'utf8')) : fallback;
    },
    writeJson(key, value) {
      const file = scratch(key);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
      store.put(key, file);
    },
  };
}

function localStore(root) {
  return {
    describe: () => path.resolve(root),
    fetch(key, dest) {
      const src = path.join(root, key);
      if (!existsSync(src)) return false;
      mkdirSync(path.dirname(dest), { recursive: true });
      cpSync(src, dest);
      return true;
    },
    publish(dir, prefix) {
      if (!existsSync(dir)) return;
      mkdirSync(path.join(root, prefix), { recursive: true });
      cpSync(dir, path.join(root, prefix), { recursive: true });
    },
    put(key, file) {
      const dest = path.join(root, key);
      mkdirSync(path.dirname(dest), { recursive: true });
      cpSync(file, dest);
    },
  };
}

function s3Store(base) {
  const at = (suffix) => `${base.replace(/\/$/, '')}/${suffix}`;
  const aws = (args) => execFileSync('aws', [...args, '--only-show-errors'], { stdio: 'pipe' });

  return {
    describe: () => base,
    fetch(key, dest) {
      mkdirSync(path.dirname(dest), { recursive: true });
      try {
        aws(['s3', 'cp', at(key), dest]);
        return true;
      } catch (error) {
        // Only a missing object means "no such baseline". Swallowing every
        // failure turns an expired role or a wrong region into a confident,
        // specific, wrong diagnosis — the report tells the reader a baseline
        // was never uploaded and points them at history instead of at
        // credentials.
        const stderr = String(error.stderr ?? '');
        if (/Not Found|does not exist|NoSuchKey|404/i.test(stderr)) return false;
        throw new Error(`Reading ${at(key)} failed: ${stderr.trim() || error.message}`);
      }
    },
    publish(dir, prefix) {
      if (!existsSync(dir)) return;
      // `--size-only` plus content-addressed names means an existing key is
      // never re-uploaded: same name implies same bytes implies same size.
      aws([
        's3', 'sync', dir, at(prefix),
        '--size-only',
        '--cache-control', 'public,max-age=31536000,immutable',
      ]);
    },
    put(key, file) {
      aws(['s3', 'cp', file, at(key), '--cache-control', 'no-cache']);
    },
  };
}
