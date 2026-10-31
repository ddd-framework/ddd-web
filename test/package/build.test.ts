import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('build output', () => {
  it('contains every exports and bin target (parallel tsup configs must not clean each other)', () => {
    const tsup = path.join(root, 'node_modules', 'tsup', 'dist', 'cli-default.js');
    execFileSync(process.execPath, [path.join(root, 'scripts', 'clean.mjs')], { cwd: root });
    execFileSync(process.execPath, [tsup], { cwd: root, stdio: 'pipe' });
    const check = (): string =>
      execFileSync(process.execPath, [path.join(root, 'scripts', 'check-package.mjs'), root], { cwd: root, encoding: 'utf-8' });
    expect(check()).not.toContain('MISSING');
    // a second build on top of an existing dist must be complete as well
    execFileSync(process.execPath, [tsup], { cwd: root, stdio: 'pipe' });
    expect(check()).not.toContain('MISSING');
  }, 120_000);
});
