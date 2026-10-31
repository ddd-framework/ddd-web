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

function importSpecifier(fromFile: string, toFile: string, esm: boolean): string {
  let relative = path.relative(path.dirname(fromFile), toFile.replace(/\.ts$/, '')).replace(/\\/g, '/');
  if (!relative.startsWith('.')) relative = `./${relative}`;
  return esm ? `${relative}.js` : relative;
}

const EXPORTED_NAME = /^export (?:type|interface) (\w+)/m;

export interface ExtractModelsInput {
  /** Generated RTK source (types still inline). */
  apiSource: string;
  /** Final path of the api file (for the models import). */
  apiFilePath: string;
  modelsDir: string;
  registry: NamespacePath[];
  files: OutputFiles;
  logger: Logger;
  /** Write `.js` import specifiers (`esmExtensions`), incl. `index.js` for the models barrel. */
  esm?: boolean;
  /** RTK names of the response types of text-only endpoints; only these become `string`. */
  textResponseTypes?: ReadonlySet<string>;
}

/**
 * Moves every exported type of the RTK output into its own file under `modelsDir` (namespace folders
 * from the registry, `_endpoints/` for arg/response types, `_others/` otherwise), merges models shared
 * between apis, maintains the barrel `index.ts` and returns the api source importing from `modelsDir`.
 *
 * Every model file keeps one exported name across all apis. A model is named after its leaf (`…Books.Item` →
 * `Item`); when another model file already uses that name, the name is qualified with namespace segments
 * (`BooksItem`, then `EntitiesBooksItem`, …) so models of different namespaces never merge into one file and the
 * barrel can export every model.
 */
export function extractModels(input: ExtractModelsInput): string {
  const { modelsDir, registry, files, logger } = input;
  const esm = input.esm === true;
  const textResponseTypes = input.textResponseTypes ?? new Set<string>();
  const indexPath = path.join(modelsDir, 'index.ts');

  // Exported name → model file (lower-case path), over everything already in the store (earlier apis, seeded files).
  const nameOwners = new Map<string, string>();
  for (const filePath of files.paths()) {
    const relative = path.relative(modelsDir, filePath);
    if (relative.startsWith('..') || path.isAbsolute(relative) || path.resolve(filePath) === path.resolve(indexPath)) continue;
    const name = files.get(filePath)?.match(EXPORTED_NAME)?.[1];
    if (name && !nameOwners.has(name)) nameOwners.set(name, path.resolve(filePath).toLowerCase());
  }

  const placement = (oldName: string): { filePath: string; leafName: string; segments: string[] } => {
    const match = registryMatch(oldName, registry);
    if (match) {
      const planned = path.join(modelsDir, ...match.segments, `${match.leafName}.ts`);
      return { filePath: files.findPath(planned) ?? planned, leafName: match.leafName, segments: match.segments };
    }
    const folder = /^(Get|Post|Put|Patch|Delete)/.test(oldName) ? '_endpoints' : '_others';
    return { filePath: path.join(modelsDir, folder, `${oldName}.ts`), leafName: oldName, segments: [] };
  };

  const originalNames = exportedTypeDeclarations(input.apiSource).map((declaration) => declaration.name);
  const renameMap = new Map<string, string>();
  const targetByNewName = new Map<string, string>();
  const nameByPath = new Map<string, string>();
  for (const oldName of originalNames) {
    const { filePath, leafName, segments } = placement(oldName);
    const pathKey = path.resolve(filePath).toLowerCase();
    let name = nameByPath.get(pathKey) ?? files.get(filePath)?.match(EXPORTED_NAME)?.[1];
    if (!name) {
      const owner = (candidate: string): string | undefined => nameOwners.get(candidate);
      name = leafName;
      for (let depth = 1; owner(name) !== undefined && owner(name) !== pathKey && depth <= segments.length; depth++) {
        name = segments.slice(-depth).join('') + leafName;
      }
      if (owner(name) !== undefined && owner(name) !== pathKey) name = oldName;
      if (name !== leafName) logger.info(`  ${oldName}: leaf name ${leafName} is taken — exported as ${name}`);
    }
    nameOwners.set(name, pathKey);
    nameByPath.set(pathKey, name);
    renameMap.set(oldName, name);
    targetByNewName.set(name, filePath);
  }

  const renameRegex = alternation([...renameMap.keys()]);
  const renamedSource = renameRegex
    ? input.apiSource.replace(renameRegex, (_, name: string) => renameMap.get(name) ?? name)
    : input.apiSource;
  const textTypes = new Set([...textResponseTypes].map((name) => renameMap.get(name) ?? name));

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
  const usedInApi = [...new Set(entries.map((entry) => entry.name))].filter((name) =>
    new RegExp(`(?<![A-Za-z0-9_$])${escapeRegExp(name)}(?![A-Za-z0-9_$])`).test(strippedSource),
  );

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
      .map((dependency) => `import { ${dependency} } from '${importSpecifier(filePath, pathByName.get(dependency)!, esm)}';`)
      .join('\n');

    // Text-response endpoints come out of RTK as `= /** status 200 */ {}`; `string` is what arrives.
    const typedBody = textTypes.has(name) ? body.replace(/(=\s*\/\*\* status \d+[^*]*\*\/)\s*\{\}/g, '$1 string') : body;

    const existing = files.isGeneratedThisRun(filePath) ? files.get(filePath) : undefined;
    const content =
      existing !== undefined
        ? mergeModel(existing, typedBody, importLines, name, logger)
        : (importLines ? `${importLines}\n\n` : '') + `${typedBody}\n\nexport default ${name};\n`;
    files.set(filePath, content);

    if (isPresentation(path.relative(modelsDir, filePath))) continue;
    barrelEntries.push(`export * from '${importSpecifier(indexPath, filePath, esm)}';`);
  }

  writeBarrel(files, indexPath, barrelEntries);

  const others = entries.filter((entry) => path.relative(modelsDir, entry.filePath).split(path.sep)[0] === '_others');
  if (others.length > 0) {
    logger.warn(`${others.length} type(s) without a namespace match placed in _others/: ${others.map((e) => e.name).join(', ')}`);
  }
  logger.info(`  extracted ${entries.length} types`);

  const modelsImport = esm
    ? importSpecifier(input.apiFilePath, indexPath, true)
    : importSpecifier(input.apiFilePath, indexPath, false).replace(/\/index$/, '');
  return `import {\n  ${usedInApi.join(',\n  ')}\n} from '${modelsImport}';\n\n${strippedSource}`;
}

/**
 * Barrel: previous entries first, then new ones, each file once. Model names are unique per file (see
 * {@link extractModels}), so no entry is dropped; entries whose file no longer exists in the store are removed.
 */
function writeBarrel(files: OutputFiles, indexPath: string, newEntries: string[]): void {
  const existing = (files.get(indexPath) ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('export *'));
  const merged: string[] = [];
  const seen = new Set<string>();
  for (const entry of [...existing, ...newEntries]) {
    const specifier = entry.match(/from ['"](.+)['"];?\s*$/)?.[1];
    if (!specifier) continue;
    const target = path.resolve(path.dirname(indexPath), specifier.replace(/\.js$/, '')) + '.ts';
    const key = target.toLowerCase();
    if (seen.has(key) || !files.findPath(target)) continue;
    seen.add(key);
    merged.push(entry);
  }
  files.set(indexPath, `${merged.join('\n')}\n`);
}
