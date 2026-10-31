import * as path from 'node:path';
import type TypeScript from 'typescript';
import type { OutputFiles } from './files';
import type { Logger } from './log';
import type { NamespacePath } from './registry';
import { loadTypeScript } from './typescript';

interface Declaration {
  name: string;
  /** Source text including leading trivia (doc comments). */
  text: string;
  start: number;
  end: number;
}

function hasExport(ts: typeof TypeScript, statement: TypeScript.Statement): boolean {
  if (!ts.canHaveModifiers(statement)) return false;
  return ts.getModifiers(statement)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false;
}

function exportedTypeDeclarations(source: string): Declaration[] {
  const ts = loadTypeScript();
  const sourceFile = ts.createSourceFile('input.ts', source, ts.ScriptTarget.Latest, true);
  const result: Declaration[] = [];
  for (const statement of sourceFile.statements) {
    if (!hasExport(ts, statement)) continue;
    if (ts.isTypeAliasDeclaration(statement) || ts.isInterfaceDeclaration(statement)) {
      const start = statement.getFullStart();
      const end = statement.getEnd();
      result.push({ name: statement.name.text, text: source.slice(start, end), start, end });
    }
  }
  return result;
}

function stripDeclarations(source: string, declarations: Declaration[]): string {
  let result = source;
  for (const { start, end } of [...declarations].sort((a, b) => b.start - a.start)) {
    result = result.slice(0, start) + result.slice(end);
  }
  return result.trim();
}

interface TypeMembers {
  header: string;
  members: Map<string, string>;
}

function parseTypeMembers(source: string): TypeMembers | null {
  const ts = loadTypeScript();
  const sourceFile = ts.createSourceFile('type.ts', source, ts.ScriptTarget.Latest, true);
  const declaration = sourceFile.statements.find(
    (statement): statement is TypeScript.TypeAliasDeclaration | TypeScript.InterfaceDeclaration =>
      ts.isTypeAliasDeclaration(statement) || ts.isInterfaceDeclaration(statement),
  );
  if (!declaration) return null;
  const isInterface = ts.isInterfaceDeclaration(declaration);
  const header = isInterface ? `export interface ${declaration.name.text} {` : `export type ${declaration.name.text} = {`;
  const elements = isInterface
    ? declaration.members
    : ts.isTypeLiteralNode(declaration.type)
      ? declaration.type.members
      : [];
  const members = new Map<string, string>();
  for (const member of elements) {
    let key: string;
    if (ts.isPropertySignature(member) && member.name) {
      key = ts.isIdentifier(member.name) ? member.name.text : member.name.getText(sourceFile);
    } else if (ts.isIndexSignatureDeclaration(member)) {
      key = '__index__';
    } else {
      continue;
    }
    members.set(key, source.slice(member.getFullStart(), member.getEnd()));
  }
  return { header, members };
}

function parseImportLines(source: string): Map<string, string> {
  const ts = loadTypeScript();
  const sourceFile = ts.createSourceFile('imports.ts', source, ts.ScriptTarget.Latest, true);
  const imports = new Map<string, string>();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    const line = source.slice(statement.getStart(sourceFile), statement.getEnd());
    for (const element of bindings.elements) imports.set(element.name.text, line);
  }
  return imports;
}

/** Union of properties when two apis emit the same model; properties already present win. */
function mergeModel(existing: string, body: string, importLines: string, name: string, logger: Logger): string {
  const existingParsed = parseTypeMembers(existing);
  const incoming = parseTypeMembers(body);
  if (!existingParsed || !incoming) {
    return (importLines ? `${importLines}\n\n` : '') + `${body}\n\nexport default ${name};\n`;
  }
  const merged = new Map(existingParsed.members);
  let added = 0;
  for (const [key, text] of incoming.members) {
    if (!merged.has(key)) {
      merged.set(key, text);
      added++;
    }
  }
  if (added === 0) return existing;
  const imports = parseImportLines(existing);
  for (const [symbol, line] of parseImportLines(importLines)) if (!imports.has(symbol)) imports.set(symbol, line);
  const importBlock = imports.size > 0 ? `${[...imports.values()].join('\n')}\n\n` : '';
  logger.info(`  merged ${added} new propert${added === 1 ? 'y' : 'ies'} into ${name}`);
  return `${importBlock}${existingParsed.header}\n${[...merged.values()].join('\n')}\n};\n\nexport default ${name};\n`;
}

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function alternation(names: string[]): RegExp | null {
  if (names.length === 0) return null;
  const sorted = [...names].sort((a, b) => b.length - a.length).map(escapeRegExp);
  return new RegExp(`(?<![A-Za-z0-9])(${sorted.join('|')})(?![A-Za-z0-9])`, 'g');
}

/**
 * Registry match for a type name. Case-insensitive because the registry key follows RTK's acronym
 * normalisation (AICosts → Aicosts) while the type name may differ in casing.
 */
function registryMatch(name: string, registry: NamespacePath[]): { segments: string[]; leafName: string } | null {
  const lower = name.toLowerCase();
  for (const [prefix, segments] of registry) {
    if (lower.startsWith(prefix.toLowerCase())) {
      const leafName = name.slice(prefix.length);
      if (leafName.length > 0 && /^[A-Z]/.test(leafName)) return { segments, leafName };
    }
  }
  return null;
}

function importSpecifier(fromFile: string, toFile: string): string {
  let relative = path.relative(path.dirname(fromFile), toFile.replace(/\.ts$/, '')).replace(/\\/g, '/');
  if (!relative.startsWith('.')) relative = `./${relative}`;
  return relative;
}

export interface ExtractModelsInput {
  /** Generated RTK source (types still inline). */
  apiSource: string;
  /** Final path of the api file (for the models import). */
  apiFilePath: string;
  modelsDir: string;
  registry: NamespacePath[];
  files: OutputFiles;
  logger: Logger;
}

/**
 * Moves every exported type of the RTK output into its own file under `modelsDir` (namespace folders
 * from the registry, `_endpoints/` for arg/response types, `_others/` otherwise), merges models shared
 * between apis, maintains the barrel `index.ts` and returns the api source importing from `modelsDir`.
 */
export function extractModels(input: ExtractModelsInput): string {
  const { modelsDir, registry, files, logger } = input;

  const findModelPath = (segments: string[], leafName: string): string | undefined =>
    files.findPath(path.join(modelsDir, ...segments, `${leafName}.ts`));

  const newTypeName = (oldName: string): string => {
    const match = registryMatch(oldName, registry);
    if (!match) return oldName;
    const existing = findModelPath(match.segments, match.leafName);
    const existingName = existing ? files.get(existing)?.match(/^export (?:type|interface) (\w+)/m)?.[1] : undefined;
    return existingName ?? match.leafName;
  };

  const targetPath = (oldName: string, newName: string): string => {
    const match = registryMatch(oldName, registry);
    if (match) return findModelPath(match.segments, match.leafName) ?? path.join(modelsDir, ...match.segments, `${match.leafName}.ts`);
    if (/^(Get|Post|Put|Patch|Delete)/.test(oldName)) return path.join(modelsDir, '_endpoints', `${newName}.ts`);
    return path.join(modelsDir, '_others', `${newName}.ts`);
  };

  const originalNames = exportedTypeDeclarations(input.apiSource).map((declaration) => declaration.name);
  const renameMap = new Map<string, string>();
  const reverseRename = new Map<string, string>();
  const targetByNewName = new Map<string, string>();
  for (const oldName of originalNames) {
    const name = newTypeName(oldName);
    renameMap.set(oldName, name);
    reverseRename.set(name, oldName);
    targetByNewName.set(name, targetPath(oldName, name));
  }

  const renameRegex = alternation([...renameMap.keys()]);
  const renamedSource = renameRegex
    ? input.apiSource.replace(renameRegex, (_, name: string) => renameMap.get(name) ?? name)
    : input.apiSource;

  const renamedDeclarations = exportedTypeDeclarations(renamedSource);
  const entries: Array<{ name: string; body: string; filePath: string }> = [];
  for (const { name, text } of renamedDeclarations) {
    const filePath = targetByNewName.get(name);
    if (!filePath) {
      logger.warn(`Re-extracted type "${name}" not in rename map — skipping.`);
      continue;
    }
    entries.push({ name, body: text, filePath });
  }

  const pathByName = new Map(entries.map((entry) => [entry.name, entry.filePath]));
  const dependencyRegex = alternation([...pathByName.keys()]);

  const strippedSource = stripDeclarations(renamedSource, renamedDeclarations);
  const usedInApi = entries
    .map((entry) => entry.name)
    .filter((name) => new RegExp(`(?<![A-Za-z0-9_$])${escapeRegExp(name)}(?![A-Za-z0-9_$])`).test(strippedSource));

  // Presentation DTOs are split per audience and share names with diverging shapes; re-exporting
  // them from one barrel would produce TS2308 duplicate exports.
  const isPresentation = (filePath: string): boolean => filePath.split(path.sep).includes('Presentation');
  const barrelEntries: string[] = [];

  for (const { name, body, filePath } of entries) {
    const dependencies = new Set<string>();
    if (dependencyRegex) {
      for (const match of body.matchAll(new RegExp(dependencyRegex.source, 'g'))) {
        if (match[1] && match[1] !== name) dependencies.add(match[1]);
      }
    }
    const importLines = [...dependencies]
      .map((dependency) => `import { ${dependency} } from '${importSpecifier(filePath, pathByName.get(dependency)!)}';`)
      .join('\n');

    // Text-response endpoints come out of RTK as `= /** status 200 */ {}`; `string` is what arrives.
    const body2 = name.endsWith('ApiResponse') ? body.replace(/(=\s*\/\*\* status \d+\s*\*\/)\s*\{\}/g, '$1 string') : body;

    const existing = files.isGeneratedThisRun(filePath) ? files.get(filePath) : undefined;
    const content =
      existing !== undefined
        ? mergeModel(existing, body2, importLines, name, logger)
        : (importLines ? `${importLines}\n\n` : '') + `${body2}\n\nexport default ${name};\n`;
    files.set(filePath, content);

    if (isPresentation(path.relative(modelsDir, filePath))) continue;
    const relative = path.relative(modelsDir, filePath.replace(/\.ts$/, '')).replace(/\\/g, '/');
    barrelEntries.push(`export * from '${relative.startsWith('.') ? relative : `./${relative}`}';`);
  }

  writeBarrel(files, path.join(modelsDir, 'index.ts'), barrelEntries);

  const others = entries.filter((entry) => path.relative(modelsDir, entry.filePath).split(path.sep)[0] === '_others');
  if (others.length > 0) {
    logger.warn(`${others.length} type(s) without a namespace match placed in _others/: ${others.map((e) => e.name).join(', ')}`);
  }
  logger.info(`  extracted ${entries.length} types`);

  const modelsImport = importSpecifier(input.apiFilePath, path.join(modelsDir, 'index.ts')).replace(/\/index$/, '');
  return `import {\n  ${usedInApi.join(',\n  ')}\n} from '${modelsImport}';\n\n${strippedSource}`;
}

/** Barrel: previous entries first, deduplicated by leaf name (same leaf in two namespaces → TS2308). */
function writeBarrel(files: OutputFiles, indexPath: string, newEntries: string[]): void {
  const existing = (files.get(indexPath) ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('export *'));
  const all = [...existing, ...newEntries.filter((entry) => !existing.includes(entry))];
  const seenLeaves = new Set<string>();
  const merged: string[] = [];
  for (const entry of all) {
    const leaf = entry.match(/\/([A-Za-z0-9_$]+)["'];?\s*$/)?.[1] ?? entry;
    if (seenLeaves.has(leaf)) continue;
    seenLeaves.add(leaf);
    merged.push(entry);
  }
  files.set(indexPath, `${merged.join('\n')}\n`);
}
