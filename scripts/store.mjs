/*
 * A content-addressed blob store with two backends.
 *
 * Keys are `img/<sha256>.png`, so a key never changes meaning: same key, same
 * bytes, forever. That buys three things for free — an unchanged story uploads
 * nothing, every branch's baselines coexist without collision, and objects can
 * be cached until the heat death of the universe.
 *
 * The store only needs two verbs. Everything reads via relative paths from the
 * report, so there is no public-URL setting to get wrong.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

export function openStore(spec = process.env.SNAPMATIC_STORE || '.snapmatic/store') {
  return spec.startsWith('s3://') ? s3Store(spec) : localStore(spec);
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
  };
}
