import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';
import type { WorkspaceOptions } from './config';
import type { Logger } from './log';

const DEFAULT_ENV_FILES = ['.env', '.env.local'];
const DEFAULT_URL_KEYS = ['NEXT_PUBLIC_API_URL', 'EXPO_PUBLIC_API_URL', 'VITE_API_URL', 'VITE_API_ENDPOINT', 'API_URL'];

function parseEnvFile(filePath: string): Record<string, string> {
  if (!fs.existsSync(filePath)) return {};
  const vars: Record<string, string> = {};
  for (const line of fs.readFileSync(filePath, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 1) continue;
    vars[trimmed.slice(0, eq).trim()] = trimmed
      .slice(eq + 1)
      .trim()
      .replace(/^["']|["']$/g, '');
  }
  return vars;
}

function firstHostLabel(url: string): string | null {
  try {
    return new URL(url).hostname.split('.')[0] || null;
  } catch {
    return null;
  }
}

export function sniffWorkspace(rootDir: string, options: WorkspaceOptions): string | null {
  for (const file of options.envFiles ?? DEFAULT_ENV_FILES) {
    const vars = parseEnvFile(path.join(rootDir, file));
    for (const key of options.urlKeys ?? DEFAULT_URL_KEYS) {
      const value = vars[key];
      const label = value ? firstHostLabel(value) : null;
      if (label) return label;
    }
  }
  return null;
}

function ask(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.on('close', () => resolve(''));
    rl.question(question, (answer) => {
      resolve(answer.trim());
      rl.close();
    });
  });
}

/**
 * Resolves the workspace value (explicit → env → .env sniff → TTY prompt) and exports it into the env
 * variable the config reads. Returns null when nothing resolved; the caller continues with whatever
 * default the config itself applies — a non-interactive run is never blocked.
 */
export async function resolveWorkspace(
  rootDir: string,
  options: WorkspaceOptions,
  explicit: string | undefined,
  logger: Logger,
): Promise<string | null> {
  let value = explicit?.trim() || process.env[options.envVar]?.trim() || null;
  const sniffed = value ? null : sniffWorkspace(rootDir, options);
  if (!value && process.stdin.isTTY && options.prompt !== false) {
    const hint = sniffed ? ` [${sniffed}]` : '';
    value = (await ask(`[ddd-web-sdk] ${options.envVar}${hint}: `)) || sniffed;
  } else if (!value) {
    value = sniffed;
  }
  if (value) {
    process.env[options.envVar] = value;
    logger.info(`${options.envVar}=${value}`);
  } else {
    logger.warn(`${options.envVar} not set and not resolvable — using the config's own default.`);
  }
  return value;
}
