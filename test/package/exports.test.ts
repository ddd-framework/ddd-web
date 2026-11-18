import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf-8')) as {
  exports: Record<string, string | Record<string, string>>;
};

/** Entries without runtime dependencies: a CommonJS caller may require() them (Node's require of an ES module). */
const requirableSubpaths = [
  './contract',
  './query',
  './auth',
  './fetch-api-request',
  './issues',
  './issues/browser',
  './issues/node',
  './issues/wire',
];

/** ES module only: the RTK Query integration (peer dependency) and the build-time tools. */
const importOnlySubpaths = ['./api', './vite', './codegen'];

describe('package exports', () => {
  it.each(requirableSubpaths)('%s has a default condition, last, on the ES module build', (subpath) => {
    const conditions = manifest.exports[subpath] as Record<string, string>;
    expect(Object.keys(conditions)).toEqual(['types', 'import', 'default']);
    expect(conditions.default).toBe(conditions.import);
  });

  it.each(importOnlySubpaths)('%s stays import-only', (subpath) => {
    const conditions = manifest.exports[subpath] as Record<string, string>;
    expect(Object.keys(conditions)).toEqual(['types', 'import']);
  });

  it('lists every subpath in one of the two groups', () => {
    const subpaths = Object.keys(manifest.exports).filter((subpath) => subpath !== './package.json');
    expect([...subpaths].sort()).toEqual([...requirableSubpaths, ...importOnlySubpaths].sort());
  });
});
