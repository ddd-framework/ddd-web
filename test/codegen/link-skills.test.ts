import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { findSkillsRepositoryRoot, runSkillLinks, silentLogger, type SkillLinksReport } from '../../src/codegen/index';

/*
 * Vendor skill links against the fixture layouts shared with `ddd-link-skills` of mgamadeus/ddd (same scenarios in its
 * PHPUnit suite): (a) nested app with real .agents/skills, (b) .codex/skills a symlink to .claude/skills, (c) .claude a
 * symlink to .codex, (d) removed package, (e) clash with an app skill, (f) edited vendor skill, (g) hand-made tracked
 * links adopted and reported.
 */

const roots: string[] = [];
afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

function createSkill(packageDirectory: string, skillName: string): void {
  fs.mkdirSync(path.join(packageDirectory, '.claude', 'skills', skillName), { recursive: true });
  fs.writeFileSync(path.join(packageDirectory, '.claude', 'skills', skillName, 'SKILL.md'), `# ${skillName}\n`);
}

/** Fixture (a): `app/` Composer root, `web/` frontend, `.claude/skills` real with an app skill, `.agents/skills` real. */
function createNestedAppFixture({ agents = true, claude = true, git = true } = {}): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ddd-skill-links-')));
  roots.push(root);
  if (git) fs.mkdirSync(path.join(root, '.git'));
  createSkill(`${root}/app/vendor/mgamadeus/ddd`, 'ddd-entity-specialist');
  createSkill(`${root}/app/vendor/mgamadeus/ddd`, 'ddd-service-specialist');
  fs.mkdirSync(`${root}/app/vendor/mgamadeus/ddd-common-money`, { recursive: true });
  fs.mkdirSync(`${root}/app/vendor/composer`, { recursive: true });
  fs.writeFileSync(
    `${root}/app/vendor/composer/installed.json`,
    JSON.stringify({ packages: [{ name: 'mgamadeus/ddd', version: '3.36.0' }, { name: 'mgamadeus/ddd-ai', version: '1.9.0' }] }),
  );
  createSkill(`${root}/web/node_modules/@mgamadeus/ddd-web`, 'ddd-web-specialist');
  fs.writeFileSync(`${root}/web/node_modules/@mgamadeus/ddd-web/package.json`, JSON.stringify({ name: '@mgamadeus/ddd-web', version: '0.17.0' }));
  if (claude) {
    fs.mkdirSync(`${root}/.claude/skills/app-own-skill`, { recursive: true });
    fs.writeFileSync(`${root}/.claude/skills/app-own-skill/SKILL.md`, '# app-own-skill\n');
    fs.writeFileSync(`${root}/.claude/skills/.gitignore`, '/own-ignored-file\n');
  }
  if (agents) {
    fs.mkdirSync(`${root}/.agents/skills`, { recursive: true });
    fs.symlinkSync('../../.claude/skills/app-own-skill', `${root}/.agents/skills/app-own-skill`);
  }
  return root;
}

const run = (root: string, options: { check?: boolean; dryRun?: boolean } = {}): SkillLinksReport =>
  runSkillLinks({ root, logger: silentLogger, ...options });
const isLink = (entry: string): boolean => fs.lstatSync(entry, { throwIfNoEntry: false })?.isSymbolicLink() ?? false;
const manifestOf = (file: string) => JSON.parse(fs.readFileSync(file, 'utf-8'));
const gitAvailable = spawnSync('git', ['--version']).status === 0;

describe('vendor skill links', () => {
  it('(a) links vendor skills of a nested app and mirrors them into a real .agents/skills', () => {
    const root = createNestedAppFixture();
    expect(run(root).exitCode).toBe(0);

    expect(fs.readlinkSync(`${root}/.claude/skills/ddd-entity-specialist`)).toBe('../../app/vendor/mgamadeus/ddd/.claude/skills/ddd-entity-specialist');
    expect(fs.readlinkSync(`${root}/.claude/skills/ddd-web-specialist`)).toBe(
      '../../web/node_modules/@mgamadeus/ddd-web/.claude/skills/ddd-web-specialist',
    );
    expect(fs.existsSync(`${root}/.claude/skills/ddd-web-specialist/SKILL.md`)).toBe(true);
    expect(fs.readlinkSync(`${root}/.agents/skills/ddd-entity-specialist`)).toBe('../../.claude/skills/ddd-entity-specialist');
    expect(fs.readlinkSync(`${root}/.agents/skills/ddd-web-specialist`)).toBe('../../.claude/skills/ddd-web-specialist');
    expect(isLink(`${root}/.claude/skills/app-own-skill`)).toBe(false);
    expect(fs.readlinkSync(`${root}/.agents/skills/app-own-skill`)).toBe('../../.claude/skills/app-own-skill');
    expect(fs.existsSync(`${root}/.codex`)).toBe(false);

    const manifest = manifestOf(`${root}/.claude/skills/.ddd-skills.json`);
    expect(manifest.format).toBe(1);
    expect(Object.keys(manifest.skills)).toEqual(['ddd-entity-specialist', 'ddd-service-specialist', 'ddd-web-specialist']);
    expect(manifest.skills['ddd-entity-specialist']).toEqual({
      package: 'mgamadeus/ddd',
      version: '3.36.0',
      source: 'app/vendor/mgamadeus/ddd/.claude/skills/ddd-entity-specialist',
      target: '../../app/vendor/mgamadeus/ddd/.claude/skills/ddd-entity-specialist',
      sha256: createHash('sha256').update('# ddd-entity-specialist\n').digest('hex'),
      mirrors: ['.agents/skills'],
    });
    expect(manifest.skills['ddd-web-specialist'].package).toBe('@mgamadeus/ddd-web');
    expect(manifest.skills['ddd-web-specialist'].version).toBe('0.17.0');

    const primaryGitignore = fs.readFileSync(`${root}/.claude/skills/.gitignore`, 'utf-8');
    expect(primaryGitignore.startsWith('/own-ignored-file\n\n# ddd-skills:start\n')).toBe(true);
    expect(primaryGitignore).toContain('/.ddd-skills.json\n/ddd-entity-specialist\n/ddd-service-specialist\n/ddd-web-specialist\n# ddd-skills:end\n');
    const mirrorGitignore = fs.readFileSync(`${root}/.agents/skills/.gitignore`, 'utf-8');
    expect(mirrorGitignore).toContain('/ddd-entity-specialist\n/ddd-service-specialist\n/ddd-web-specialist\n# ddd-skills:end\n');
    expect(mirrorGitignore).not.toContain('app-own-skill');

    const second = run(root);
    expect(second.exitCode).toBe(0);
    expect(second.lines).toContain('3 skill(s) from 2 package(s), 0 change(s)');
    expect(second.skills.every((result) => result.action === 'unchanged')).toBe(true);
    expect(run(root, { check: true }).exitCode).toBe(0);
  });

  it('finds the root from the Composer or npm subfolder', () => {
    const root = createNestedAppFixture();
    expect(findSkillsRepositoryRoot(`${root}/app`)).toBe(root);
    expect(findSkillsRepositoryRoot(`${root}/web/node_modules`)).toBe(root);
    expect(runSkillLinks({ cwd: `${root}/web`, logger: silentLogger }).root).toBe(root);
  });

  it('--check and --dry-run change nothing', () => {
    const root = createNestedAppFixture();
    const check = run(root, { check: true });
    expect(check.exitCode).toBe(1);
    expect(check.problems.some((problem) => problem.startsWith('missing'))).toBe(true);
    expect(run(root, { dryRun: true }).exitCode).toBe(0);
    expect(isLink(`${root}/.claude/skills/ddd-entity-specialist`)).toBe(false);
    expect(fs.existsSync(`${root}/.claude/skills/.ddd-skills.json`)).toBe(false);
  });

  it('(b) .codex/skills symlinked to .claude/skills gets the links once', () => {
    const root = createNestedAppFixture({ agents: false });
    fs.mkdirSync(`${root}/.codex`);
    fs.symlinkSync('../.claude/skills', `${root}/.codex/skills`);
    expect(run(root).exitCode).toBe(0);
    expect(isLink(`${root}/.codex/skills`)).toBe(true);
    expect(fs.readlinkSync(`${root}/.claude/skills/ddd-entity-specialist`)).toBe('../../app/vendor/mgamadeus/ddd/.claude/skills/ddd-entity-specialist');
    expect(manifestOf(`${root}/.claude/skills/.ddd-skills.json`).skills['ddd-entity-specialist'].mirrors).toEqual([]);
    expect(run(root, { check: true }).exitCode).toBe(0);
  });

  it('(c) .claude symlinked to .codex writes into the real folder', () => {
    const root = createNestedAppFixture({ agents: false, claude: false });
    fs.mkdirSync(`${root}/.codex/skills`, { recursive: true });
    fs.symlinkSync('.codex', `${root}/.claude`);
    expect(run(root).exitCode).toBe(0);
    expect(isLink(`${root}/.claude`)).toBe(true);
    expect(fs.readlinkSync(`${root}/.codex/skills/ddd-entity-specialist`)).toBe('../../app/vendor/mgamadeus/ddd/.claude/skills/ddd-entity-specialist');
    expect(fs.existsSync(`${root}/.codex/skills/ddd-entity-specialist/SKILL.md`)).toBe(true);
    expect(fs.existsSync(`${root}/.codex/skills/.ddd-skills.json`)).toBe(true);
    expect(fs.readFileSync(`${root}/.codex/skills/.gitignore`, 'utf-8')).toContain('/ddd-entity-specialist');
    expect(run(root, { check: true }).exitCode).toBe(0);
  });

  it('(d) a removed package loses its links, app skills stay', () => {
    const root = createNestedAppFixture();
    run(root);
    fs.rmSync(`${root}/web/node_modules/@mgamadeus/ddd-web`, { recursive: true });

    const check = run(root, { check: true });
    expect(check.exitCode).toBe(1);
    expect(check.problems.some((problem) => problem.startsWith('broken'))).toBe(true);

    expect(run(root).exitCode).toBe(0);
    expect(isLink(`${root}/.claude/skills/ddd-web-specialist`)).toBe(false);
    expect(isLink(`${root}/.agents/skills/ddd-web-specialist`)).toBe(false);
    expect(isLink(`${root}/.claude/skills/ddd-entity-specialist`)).toBe(true);
    expect(fs.existsSync(`${root}/.claude/skills/app-own-skill/SKILL.md`)).toBe(true);
    expect(isLink(`${root}/.agents/skills/app-own-skill`)).toBe(true);
    expect(manifestOf(`${root}/.claude/skills/.ddd-skills.json`).skills).not.toHaveProperty('ddd-web-specialist');
    expect(fs.readFileSync(`${root}/.claude/skills/.gitignore`, 'utf-8')).not.toContain('ddd-web-specialist');
    expect(fs.readFileSync(`${root}/.agents/skills/.gitignore`, 'utf-8')).not.toContain('ddd-web-specialist');
    expect(run(root, { check: true }).exitCode).toBe(0);
  });

  it('(e) an app skill of the same name is a clash and stays untouched', () => {
    const root = createNestedAppFixture();
    fs.mkdirSync(`${root}/.claude/skills/ddd-entity-specialist`);
    fs.writeFileSync(`${root}/.claude/skills/ddd-entity-specialist/SKILL.md`, '# app version\n');
    const report = run(root);
    expect(report.exitCode).toBe(0);
    expect(report.problems.some((problem) => problem.startsWith('clash') && problem.includes('ddd-entity-specialist'))).toBe(true);
    expect(report.skills.find((result) => result.skill === 'ddd-entity-specialist')?.action).toBe('skipped');
    expect(isLink(`${root}/.claude/skills/ddd-entity-specialist`)).toBe(false);
    expect(fs.readFileSync(`${root}/.claude/skills/ddd-entity-specialist/SKILL.md`, 'utf-8')).toBe('# app version\n');
    expect(fs.readFileSync(`${root}/.claude/skills/.gitignore`, 'utf-8')).not.toContain('/ddd-entity-specialist');
    expect(run(root, { check: true }).exitCode).toBe(1);
  });

  it('keeps the first of two packages shipping the same skill', () => {
    const root = createNestedAppFixture();
    createSkill(`${root}/app/vendor/mgamadeus/ddd-ai`, 'ddd-entity-specialist');
    const report = run(root);
    expect(fs.readlinkSync(`${root}/.claude/skills/ddd-entity-specialist`)).toBe('../../app/vendor/mgamadeus/ddd-ai/.claude/skills/ddd-entity-specialist');
    expect(report.problems.some((problem) => problem.includes('shipped by mgamadeus/ddd-ai'))).toBe(true);
    expect(run(root, { check: true }).exitCode).toBe(1);
  });

  it('(f) an edited vendor skill is caught by --check', () => {
    const root = createNestedAppFixture();
    run(root);
    fs.writeFileSync(`${root}/app/vendor/mgamadeus/ddd/.claude/skills/ddd-entity-specialist/SKILL.md`, '# edited in vendor\n');
    const check = run(root, { check: true });
    expect(check.exitCode).toBe(1);
    expect(check.problems.some((problem) => problem.startsWith('edited') && problem.includes('ddd-entity-specialist'))).toBe(true);
    run(root);
    expect(run(root, { check: true }).exitCode).toBe(1);
  });

  it.skipIf(!gitAvailable)('(g) hand-made tracked links are adopted and reported', () => {
    const root = createNestedAppFixture({ git: false });
    execFileSync('git', ['-C', root, 'init', '-q']);
    fs.symlinkSync('../../app/vendor/mgamadeus/ddd/.claude/skills/ddd-entity-specialist', `${root}/.claude/skills/ddd-entity-specialist`);
    execFileSync('git', ['-C', root, 'add', '.claude/skills/ddd-entity-specialist']);

    const report = run(root);
    expect(report.exitCode).toBe(0);
    expect(report.skills.find((result) => result.skill === 'ddd-entity-specialist')?.action).toBe('unchanged');
    const tracked = report.problems.filter((problem) => problem.startsWith('tracked'));
    expect(tracked).toHaveLength(1);
    expect(tracked[0]).toContain('git rm --cached -- .claude/skills/ddd-entity-specialist');
    expect(run(root, { check: true }).exitCode).toBe(1);

    execFileSync('git', ['-C', root, 'rm', '-q', '--cached', '--', '.claude/skills/ddd-entity-specialist']);
    expect(run(root, { check: true }).exitCode).toBe(0);
  });
});
