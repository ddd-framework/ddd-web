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

/** `@mgamadeus/ddd-web <version>` of the installed package, or the bare name when the version is unknown. */
function packageLabel(packageDir: string | undefined): string {
  if (packageDir) {
    try {
      const version = (JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf-8')) as { version?: unknown }).version;
      if (typeof version === 'string') return `@mgamadeus/ddd-web ${version}`;
    } catch {
      // no readable manifest: fall back to the bare name
    }
  }
  return '@mgamadeus/ddd-web';
}

/**
 * Symlinks every skill directory of the installed package into `<cwd>/.claude/skills/`. Idempotent;
 * an existing symlink is repointed, a real file or directory is never touched. A package version that ships no
 * skills is reported as such (nothing is created).
 */
export function linkSkills(options: LinkSkillsOptions = {}): LinkSkillsResult[] {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const logger = options.logger ?? consoleLogger;
  const packageDir = path.join(cwd, 'node_modules', '@mgamadeus', 'ddd-web');
  const sourceDir = options.sourceDir ? path.resolve(cwd, options.sourceDir) : path.join(packageDir, '.claude', 'skills');
  if (!options.sourceDir && !fs.existsSync(packageDir)) {
    logger.warn(`@mgamadeus/ddd-web is not installed in ${cwd} (no ${packageDir}) — nothing to link.`);
    return [];
  }
  const skills = fs.existsSync(sourceDir)
    ? fs.readdirSync(sourceDir, { withFileTypes: true }).filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
    : [];
  if (skills.length === 0) {
    logger.info(`${packageLabel(options.sourceDir ? undefined : packageDir)} ships no agent skills (${sourceDir}) — nothing to link.`);
    return [];
  }
  const targetDir = path.join(cwd, '.claude', 'skills');
  fs.mkdirSync(targetDir, { recursive: true });

  const results: LinkSkillsResult[] = [];
  for (const entry of skills) {
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
