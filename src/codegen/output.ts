import * as fs from 'node:fs';
import * as path from 'node:path';
import type { OutputFiles } from './files';
import { SdkGenerationError } from './log';

/** Moves a file or directory; falls back to copy + delete across devices. */
export function defaultMove(from: string, to: string): void {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  try {
    fs.renameSync(from, to);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
    fs.cpSync(from, to, { recursive: true });
    fs.rmSync(from, { recursive: true, force: true });
  }
}

export interface CommitOutputOptions {
  /** File system move (injectable for tests). Default {@link defaultMove}. */
  move?: (from: string, to: string) => void;
}

export interface CommittedOutput {
  /** Restores the previous output (used when the type check fails). Throws, keeping the backup, if a restore fails. */
  rollback(): void;
  /** Drops the backup of the previous output. */
  finalize(): void;
}

/**
 * Writes all files into a staging directory first, then swaps them in: the models directory as a whole
 * (stale models disappear), every other file individually. Nothing in the target is touched before
 * the staging write succeeded; a failure during the swap restores what was there.
 *
 * Every backup move registers its restore immediately, so a failure between "old output moved away" and "new output
 * moved in" still restores the old output. If a restore fails, the staging directory (with the backups) is kept and
 * the error names it.
 */
export function commitOutput(
  files: OutputFiles,
  modelsDir: string,
  stagingParent: string,
  options: CommitOutputOptions = {},
): CommittedOutput {
  const move = options.move ?? defaultMove;
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

  const undo: Array<() => void> = [];
  const rollback = (): void => {
    const failures: unknown[] = [];
    for (const step of undo.reverse()) {
      try {
        step();
      } catch (error) {
        failures.push(error);
      }
    }
    undo.length = 0;
    if (failures.length > 0) {
      throw new SdkGenerationError(
        `Could not restore the previous output; the previous output is kept in ${staging} ` +
          `(models.previous/, files.previous/): ${failures.map((failure) => (failure as Error).message).join('; ')}`,
      );
    }
    fs.rmSync(staging, { recursive: true, force: true });
  };

  /** Moves `target` to `backup` (if it exists) and `staged` to `target`; the restore is registered before the swap. */
  const swap = (target: string, staged: string, backup: string, removeTarget: () => void): void => {
    const state = { backedUp: false, movedIn: false };
    undo.push(() => {
      if (state.movedIn) removeTarget();
      if (state.backedUp) move(backup, target);
    });
    if (fs.existsSync(target)) {
      move(target, backup);
      state.backedUp = true;
    }
    move(staged, target);
    state.movedIn = true;
  };

  try {
    swap(modelsDir, stagedModels, backupModels, () => fs.rmSync(modelsDir, { recursive: true, force: true }));
    for (const single of singles) {
      swap(single.target, single.staged, single.backup, () => fs.rmSync(single.target, { force: true }));
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
