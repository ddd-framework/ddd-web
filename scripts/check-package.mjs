#!/usr/bin/env node
// Checks a package directory (the repo root after `pnpm build`, or an extracted tarball's `package/`):
// every `exports` target and every `bin` target must exist. With --require-skills, at least one
// `.claude/skills/<name>/SKILL.md` must exist as well.
//
// Usage: node scripts/check-package.mjs <packageDir> [--require-skills]
import * as fs from 'node:fs';
import * as path from 'node:path';

const args = process.argv.slice(2);
const requireSkills = args.includes('--require-skills');
const packageDir = path.resolve(args.find((arg) => !arg.startsWith('--')) ?? '.');
const manifest = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf-8'));

/** Every string leaf of an `exports` value (conditions and subpaths flattened). */
function targets(value) {
  if (typeof value === 'string') return [value];
  if (value && typeof value === 'object') return Object.values(value).flatMap(targets);
  return [];
}

const expected = [
  ...targets(manifest.exports ?? {}).map((target) => ({ kind: 'exports', target })),
  ...(typeof manifest.bin === 'string'
    ? [{ kind: 'bin', target: manifest.bin }]
    : Object.values(manifest.bin ?? {}).map((target) => ({ kind: 'bin', target }))),
];

const missing = expected.filter(({ target }) => !fs.existsSync(path.join(packageDir, target)));
for (const { kind, target } of expected) {
  console.log(`${missing.some((entry) => entry.target === target) ? 'MISSING' : 'ok     '} ${kind.padEnd(7)} ${target}`);
}

let skillsMissing = false;
if (requireSkills) {
  const skillsDir = path.join(packageDir, '.claude', 'skills');
  const skills = fs.existsSync(skillsDir)
    ? fs.readdirSync(skillsDir).filter((name) => fs.existsSync(path.join(skillsDir, name, 'SKILL.md')))
    : [];
  if (skills.length === 0) {
    skillsMissing = true;
    console.log('MISSING .claude/skills/*/SKILL.md');
  } else {
    for (const skill of skills) console.log(`ok      skill   .claude/skills/${skill}/SKILL.md`);
  }
}

if (missing.length > 0 || skillsMissing) {
  console.error(`${packageDir}: ${missing.length} missing exports/bin target(s)${skillsMissing ? ', no skills' : ''}`);
  process.exit(1);
}
