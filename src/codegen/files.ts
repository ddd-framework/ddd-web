import * as fs from 'node:fs';
import * as path from 'node:path';

interface StoredFile {
  content: string;
  /** False for files seeded from the previous output (partial runs); those are overwritten, not merged. */
  generatedThisRun: boolean;
}

/** In-memory set of generated files keyed by their final absolute path. */
export class OutputFiles {
  protected files = new Map<string, StoredFile>();
  protected lowerCaseIndex = new Map<string, string>();

  set(filePath: string, content: string): void {
    const absolute = path.resolve(filePath);
    this.files.set(absolute, { content, generatedThisRun: true });
    this.lowerCaseIndex.set(absolute.toLowerCase(), absolute);
  }

  get(filePath: string): string | undefined {
    return this.files.get(path.resolve(filePath))?.content;
  }

  isGeneratedThisRun(filePath: string): boolean {
    return this.files.get(path.resolve(filePath))?.generatedThisRun ?? false;
  }

  /** Case-insensitive lookup; returns the stored path spelling. */
  findPath(filePath: string): string | undefined {
    return this.lowerCaseIndex.get(path.resolve(filePath).toLowerCase());
  }

  paths(): string[] {
    return [...this.files.keys()];
  }

  /** Seeds the store with existing `.ts` files below `dir` (for runs that regenerate only some apis). */
  seedFromDisk(dir: string): void {
    for (const absolute of listTsFiles(dir)) {
      this.files.set(absolute, { content: fs.readFileSync(absolute, 'utf-8'), generatedThisRun: false });
      this.lowerCaseIndex.set(absolute.toLowerCase(), absolute);
    }
  }
}

function listTsFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const result: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) result.push(...listTsFiles(absolute));
    else if (entry.isFile() && entry.name.endsWith('.ts')) result.push(absolute);
  }
  return result;
}
