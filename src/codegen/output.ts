import * as fs from 'node:fs';
import * as path from 'node:path';
import type { OutputFiles } from './files';

function move(from: string, to: string): void {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  try {
    fs.renameSync(from, to);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
    fs.cpSync(from, to, { recursive: true });
    fs.rmSync(from, { recursive: true, force: true });
  }
}

export interface CommittedOutput {
  /** Restores the previous output (used when the type check fails). */
  rollback(): void;
  /** Drops the backup of the previous output. */
  finalize(): void;
}

/**
 * Writes all files into a staging directory first, then swaps them in: the models directory as a whole
 * (stale models disappear), every other file individually. Nothing in the target is touched before
 * the staging write succeeded; a failure during the swap restores what was there.
 */
export function commitOutput(files: OutputFiles, modelsDir: string, stagingParent: string): CommittedOutput {
  fs.mkdirSync(stagingParent, { recursive: true });
  const staging = fs.mkdtempSync(path.join(stagingParent, '.ddd-web-sdk-'));
  const stagedModels = path.join(staging, 'models');
  const backupModels = path.join(staging, 'models.previous');
  const singles: Array<{ target: string; staged: string; backup: string }> = [];

  try {
    fs.mkdirSync(stagedModels, { recursive: true });
    for (const filePath of files.paths()) {
      const content = files.get(filePath)!;
      const relative = path.relative(modelsDir, filePath);
      if (!relative.startsWith('..') && !path.isAbsolute(relative)) {
        const staged = path.join(stagedModels, relative);
        fs.mkdirSync(path.dirname(staged), { recursive: true });
        fs.writeFileSync(staged, content);
      } else {
        const staged = path.join(staging, 'files', String(singles.length));
        fs.mkdirSync(path.dirname(staged), { recursive: true });
        fs.writeFileSync(staged, content);
        singles.push({ target: filePath, staged, backup: path.join(staging, 'files.previous', String(singles.length)) });
      }
    }
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw error;
  }

  const done: Array<() => void> = [];
  const rollback = (): void => {
    for (const undo of done.reverse()) undo();
    done.length = 0;
    fs.rmSync(staging, { recursive: true, force: true });
  };

  try {
    const hadModels = fs.existsSync(modelsDir);
    if (hadModels) move(modelsDir, backupModels);
    move(stagedModels, modelsDir);
    done.push(() => {
      fs.rmSync(modelsDir, { recursive: true, force: true });
      if (hadModels) move(backupModels, modelsDir);
    });
    for (const single of singles) {
      const existed = fs.existsSync(single.target);
      if (existed) move(single.target, single.backup);
      move(single.staged, single.target);
      done.push(() => {
        fs.rmSync(single.target, { force: true });
        if (existed) move(single.backup, single.target);
      });
    }
  } catch (error) {
    rollback();
    throw error;
  }

  return {
    rollback,
    finalize: () => fs.rmSync(staging, { recursive: true, force: true }),
  };
}
