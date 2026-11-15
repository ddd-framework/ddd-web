import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { normalizeDddError as fromContract } from '../../src/contract';
import { normalizeDddError as fromApi } from '../../src/api';

const packageRoot = path.resolve(__dirname, '..', '..');

/** Collects the bare module specifiers a built file imports, following its own relative chunks. */
const bareImportsOf = (file: string, seen = new Set<string>()): Set<string> => {
  const bare = new Set<string>();
  if (seen.has(file)) return bare;
  seen.add(file);
  const source = fs.readFileSync(file, 'utf8');
  for (const [, specifier] of source.matchAll(/from\s+["']([^"']+)["']/g)) {
    if (specifier!.startsWith('.')) {
      for (const nested of bareImportsOf(path.resolve(path.dirname(file), specifier!), seen)) bare.add(nested);
    } else {
      bare.add(specifier!);
    }
  }
  return bare;
};

describe('normalizeDddError in /contract', () => {
  it('is the same function as in /api and reads a DDD error body', () => {
    expect(fromContract).toBe(fromApi);
    expect(fromContract({ status: 400, data: { error: 'Name is required' } }).message).toBe('Name is required');
  });

  it('the built /contract entry imports no RTK Query runtime', () => {
    const entry = path.join(packageRoot, 'dist', 'contract', 'index.js');
    if (!fs.existsSync(entry)) return; // the build test covers a missing build
    expect([...bareImportsOf(entry)].filter((specifier) => specifier.startsWith('@reduxjs'))).toEqual([]);
  });
});
