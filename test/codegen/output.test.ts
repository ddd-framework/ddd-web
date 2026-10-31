import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { OutputFiles } from '../../src/codegen/files';
import { commitOutput, defaultMove } from '../../src/codegen/output';

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ddd-web-output-test-'));
  dirs.push(root);
  const modelsDir = path.join(root, 'src', 'models');
  const apiFile = path.join(root, 'src', 'api', 'adminApi.ts');
  fs.mkdirSync(modelsDir, { recursive: true });
  fs.mkdirSync(path.dirname(apiFile), { recursive: true });
  fs.writeFileSync(path.join(modelsDir, 'Old.ts'), 'old model');
  fs.writeFileSync(apiFile, 'old api');
  const files = new OutputFiles();
  files.set(path.join(modelsDir, 'New.ts'), 'new model');
  files.set(apiFile, 'new api');
  return { root, modelsDir, apiFile, files };
}

/** A move that throws for the given (from → to) pair on its first call(s). */
function failingMove(shouldFail: (from: string, to: string) => boolean) {
  return (from: string, to: string): void => {
    if (shouldFail(from, to)) throw Object.assign(new Error(`injected failure ${from} → ${to}`), { code: 'EIO' });
    defaultMove(from, to);
  };
}

describe('commitOutput', () => {
  it('restores the previous models when moving the new models in fails', () => {
    const { root, modelsDir, apiFile, files } = setup();
    const move = failingMove((from, to) => to === modelsDir && !from.endsWith('models.previous'));
    expect(() => commitOutput(files, modelsDir, root, { move })).toThrow(/injected failure/);
    expect(fs.readFileSync(path.join(modelsDir, 'Old.ts'), 'utf-8')).toBe('old model');
    expect(fs.existsSync(path.join(modelsDir, 'New.ts'))).toBe(false);
    expect(fs.readFileSync(apiFile, 'utf-8')).toBe('old api');
  });

  it('restores a single file when moving its new version in fails', () => {
    const { root, modelsDir, apiFile, files } = setup();
    let failed = false;
    const move = failingMove((from, to) => {
      if (failed || to !== apiFile || from.includes(`${path.sep}files.previous${path.sep}`)) return false;
      failed = true;
      return true;
    });
    expect(() => commitOutput(files, modelsDir, root, { move })).toThrow(/injected failure/);
    expect(fs.readFileSync(apiFile, 'utf-8')).toBe('old api');
    expect(fs.readFileSync(path.join(modelsDir, 'Old.ts'), 'utf-8')).toBe('old model');
  });

  it('keeps the backup when the restore itself fails', () => {
    const { root, modelsDir, files } = setup();
    const move = failingMove((_from, to) => to === modelsDir);
    expect(() => commitOutput(files, modelsDir, root, { move })).toThrow(/previous output is kept in/);
    const staging = fs.readdirSync(root).filter((name) => name.startsWith('.ddd-web-sdk-'));
    expect(staging).toHaveLength(1);
    expect(fs.readFileSync(path.join(root, staging[0]!, 'models.previous', 'Old.ts'), 'utf-8')).toBe('old model');
  });

  it('swaps everything in and drops the staging directory on finalize', () => {
    const { root, modelsDir, apiFile, files } = setup();
    commitOutput(files, modelsDir, root).finalize();
    expect(fs.readFileSync(path.join(modelsDir, 'New.ts'), 'utf-8')).toBe('new model');
    expect(fs.existsSync(path.join(modelsDir, 'Old.ts'))).toBe(false);
    expect(fs.readFileSync(apiFile, 'utf-8')).toBe('new api');
    expect(fs.readdirSync(root).filter((name) => name.startsWith('.ddd-web-sdk-'))).toEqual([]);
  });
});
