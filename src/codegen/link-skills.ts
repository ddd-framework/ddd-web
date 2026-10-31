import * as fs from 'node:fs';
import * as path from 'node:path';
import { consoleLogger, type Logger } from './log';

export interface LinkSkillsOptions {
  cwd?: string;
  /** Directory holding the package's skills. Default `<cwd>/node_modules/@mgamadeus/ddd-web/.claude/skills`. */
  sourceDir?: string;
  logger?: Logger;
}

export type LinkSkillAction = 'linked' | 'relinked' | 'unchanged' | 'skipped';

export interface LinkSkillsResult {
  skill: string;
  action: LinkSkillAction;
  target: string;
}

/**
 * Symlinks every skill directory of the installed package into `<cwd>/.claude/skills/`. Idempotent;
 * an existing symlink is repointed, a real file or directory is never touched.
 */
export function linkSkills(options: LinkSkillsOptions = {}): LinkSkillsResult[] {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const logger = options.logger ?? consoleLogger;
  const sourceDir = path.resolve(cwd, options.sourceDir ?? 'node_modules/@mgamadeus/ddd-web/.claude/skills');
  if (!fs.existsSync(sourceDir)) {
    logger.warn(`No skills found at ${sourceDir} — is @mgamadeus/ddd-web installed?`);
    return [];
  }
  const targetDir = path.join(cwd, '.claude', 'skills');
  fs.mkdirSync(targetDir, { recursive: true });

  const results: LinkSkillsResult[] = [];
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const linkPath = path.join(targetDir, entry.name);
    const linkTarget = path.relative(targetDir, path.join(sourceDir, entry.name));
    let action: LinkSkillAction;
    const existing = fs.lstatSync(linkPath, { throwIfNoEntry: false });
    if (!existing) {
      fs.symlinkSync(linkTarget, linkPath, 'dir');
      action = 'linked';
    } else if (!existing.isSymbolicLink()) {
      action = 'skipped';
    } else if (fs.readlinkSync(linkPath) === linkTarget) {
      action = 'unchanged';
    } else {
      fs.unlinkSync(linkPath);
      fs.symlinkSync(linkTarget, linkPath, 'dir');
      action = 'relinked';
    }
    const message = `${action.padEnd(9)} .claude/skills/${entry.name} → ${linkTarget}`;
    if (action === 'skipped') logger.warn(`${message} (exists and is not a symlink — left as is)`);
    else logger.info(message);
    results.push({ skill: entry.name, action, target: linkTarget });
  }
  return results;
}
