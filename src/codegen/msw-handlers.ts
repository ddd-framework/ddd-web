import * as path from 'node:path';
import type TypeScript from 'typescript';
import type { EndpointInfo } from './endpoints';
import type { OutputFiles } from './files';
import type { HttpMethod, OpenApiDocument } from './openapi';
import { loadTypeScript } from './typescript';

/** Where the default answer of a generated MSW handler comes from: the application's model mock functions. */
export interface ModelMocksOptions {
  /**
   * Module specifier prefix of the model mocks; the model's path below the models directory follows it, then
   * `fileSuffix`. `'@mocks/models/'` + `App/Domain/Library/Entities/Books/Book` + `'.mock'`.
   */
  importPrefix: string;
  /** Named export of a model's mock function (called without arguments). Default `get<ModelName>Mock`. */
  exportName?: (modelName: string, modelPath: string) => string;
  /** Appended to the model path in the import specifier. Default `'.mock'`. */
  fileSuffix?: string;
}

/**
 * Generated MSW request handlers, one factory per operation that has a request builder (`<stem>Mocks.ts`). The
 * generated file imports `msw` (a dependency of the consuming project, never of DDD Web).
 */
export interface MswHandlersOptions {
  /** Default answers from the application's model mocks; without it every handler answers `null`. */
  modelMocks?: ModelMocksOptions;
}

/** Per api: `false` turns the handlers off for this api; the fields override the config-level ones. */
export interface ApiMswHandlersOptions extends MswHandlersOptions {
  /** The handlers file. Default `<stem>Mocks.ts` next to the api output file. */
  outputFile?: string;
  /** Name of the exported handler object. Default `<stem>Mocks`. */
  exportName?: string;
}

export interface RenderMswHandlersInput {
  /** The api source after model extraction (the endpoints with their type arguments, imports of the models). */
  apiSource: string;
  apiFilePath: string;
  /** The endpoints of that source (operation method and path). */
  endpoints: EndpointInfo[];
  /** Endpoint key → response handler kind (`blob` / `text`); JSON otherwise. */
  responseKinds: ReadonlyMap<string, 'text' | 'blob'>;
  doc: OpenApiDocument;
  files: OutputFiles;
  modelsDir: string;
  outputFile: string;
  exportName: string;
  modelMocks?: ModelMocksOptions;
  esm: boolean;
}

interface ImportedName {
  exported: string;
  /** Absolute path of the module file (`.ts`). */
  file: string;
}

interface ModelRef {
  file: string;
  exported: string;
}

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** The handlers module for one api, unformatted. */
export function renderMswHandlers(input: RenderMswHandlersInput): string {
  const ts = loadTypeScript();
  const apiFile = ts.createSourceFile('api.ts', input.apiSource, ts.ScriptTarget.Latest, true);
  const apiImports = readImports(ts, apiFile, input.apiFilePath, input.files);
  const typeArguments = readTypeArguments(ts, apiFile);

  const typeImports = new Map<string, ImportedName>();
  const mockImports = new Map<string, { exported: string; specifier: string }>();
  const mockLocalBySpecifier = new Map<string, string>();
  const mockOf = (model: ModelRef): string | null => {
    const options = input.modelMocks;
    if (!options) return null;
    const relative = path.relative(input.modelsDir, model.file).replace(/\.ts$/, '').split(path.sep).join('/');
    if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
    const modelName = path.basename(relative);
    const prefix = options.importPrefix.endsWith('/') || options.importPrefix === '' ? options.importPrefix : `${options.importPrefix}/`;
    const specifier = `${prefix}${relative}${options.fileSuffix ?? '.mock'}`;
    const exported = options.exportName?.(modelName, relative) ?? `get${modelName}Mock`;
    const key = `${specifier}\0${exported}`;
    const known = mockLocalBySpecifier.get(key);
    if (known) return known;
    let local = exported;
    for (let index = 2; mockImports.has(local) || typeImports.has(local); index++) local = `${exported}${index}`;
    mockImports.set(local, { exported, specifier });
    mockLocalBySpecifier.set(key, local);
    return local;
  };
  const useType = (text: string): string => {
    for (const match of text.matchAll(/[A-Za-z_$][A-Za-z0-9_$]*/g)) {
      const imported = apiImports.get(match[0]);
      if (imported) typeImports.set(match[0], imported);
    }
    return text;
  };

  const entries: string[] = [];
  for (const endpoint of input.endpoints) {
    const types = typeArguments.get(endpoint.key);
    if (!types) continue;
    const method = endpoint.method.toLowerCase() as HttpMethod;
    const kind = input.responseKinds.get(endpoint.key) ?? 'json';
    const operation = input.doc.paths?.[endpoint.path]?.[method];
    const status = kind === 'blob' ? 200 : successStatus(operation?.responses);
    const argType = useType(types.arg ?? 'void');
    let responseType = kind === 'blob' ? 'Blob | string | null' : useType(types.response ?? 'unknown');
    let defaultMock = 'null';
    if (kind === 'json' && types.response && IDENTIFIER.test(types.response)) {
      const shape = responseShape(ts, types.response, apiImports, input.files);
      const local = shape ? mockOf(shape.model) : null;
      if (shape && local) defaultMock = shape.array ? `[${local}()]` : `${local}()`;
    }
    if (kind === 'text' && responseType === 'unknown') responseType = 'string';
    const pattern = mswPathPattern(endpoint.path);
    const key = IDENTIFIER.test(endpoint.key) ? endpoint.key : JSON.stringify(endpoint.key);
    entries.push(
      `  ${key}: (custom?: Partial<StoryMock<${responseType}, ${argType}>>) =>\n` +
        `    mockOperation<${responseType}, ${argType}>(${JSON.stringify(method)}, ${JSON.stringify(pattern)}, ` +
        `${JSON.stringify(endpoint.path)}, ${JSON.stringify(kind)}, ${status}, () => ${defaultMock}, custom),`,
    );
  }

  const specifierOf = (file: string): string => {
    let relative = path.relative(path.dirname(input.outputFile), file.replace(/\.ts$/, '')).split(path.sep).join('/');
    if (!relative.startsWith('.')) relative = `./${relative}`;
    if (input.esm) return `${relative}.js`;
    return relative.endsWith('/index') ? relative.slice(0, -'/index'.length) : relative;
  };
  const typeLines = groupImports([...typeImports].map(([local, { exported, file }]) => ({ local, exported, specifier: specifierOf(file) })), true);
  const mockLines = groupImports([...mockImports].map(([local, { exported, specifier }]) => ({ local, exported, specifier })), false);

  return [
    '// Generated by @mgamadeus/ddd-web (mswHandlers). Do not edit.',
    "import { delay, http, HttpResponse, type DefaultBodyType, type HttpResponseResolver, type PathParams } from 'msw';",
    ...typeLines,
    ...mockLines,
    '',
    RUNTIME,
    `/** MSW handler factories of ${input.exportName.replace(/Mocks$/, '')}: one per operation, answering its default mock. */`,
    `export const ${input.exportName} = {`,
    ...entries,
    '};',
    '',
  ].join('\n');
}

/** One import declaration per module, the names in first-use order. */
function groupImports(names: Array<{ local: string; exported: string; specifier: string }>, typeOnly: boolean): string[] {
  const bySpecifier = new Map<string, string[]>();
  for (const { local, exported, specifier } of names) {
    const list = bySpecifier.get(specifier) ?? [];
    list.push(exported === local ? local : `${exported} as ${local}`);
    bySpecifier.set(specifier, list);
  }
  return [...bySpecifier].map(([specifier, list]) => `import ${typeOnly ? 'type ' : ''}{ ${list.join(', ')} } from '${specifier}';`);
}

const RUNTIME = `type ResolverInfo = Parameters<HttpResponseResolver<PathParams, DefaultBodyType>>[0];

/** The path parameters and query string values of the request, by name, as the strings that arrived. */
export type StoryMockParams<Arg> = { [Name in Arg extends object ? Extract<keyof Arg, string> : never]?: string } & {
  [name: string]: string | undefined;
};

/** How a generated handler answers; the factories take \`Partial<StoryMock<…>>\`. */
export interface StoryMock<Response, Arg = void> {
  /** URL pattern matched instead of the generated one (any origin + the operation path, \`:name\` per path parameter). */
  url: string;
  /** Default: the operation's first declared 2xx status (200 for a file download). */
  status: number;
  /** Delay before answering (MSW \`delay\`). */
  delay: number | 'real' | 'infinite';
  /** The answer, or a function computing it from the request's parameters and the default mock. */
  response:
    | Response
    | ((params: StoryMockParams<Arg>, defaultMock: Response | null, info: ResolverInfo) => Response | Promise<Response>);
}

type BodyKind = 'json' | 'text' | 'blob';

const readParams = (template: string, info: ResolverInfo): Record<string, string> => {
  const url = new URL(info.request.url);
  const params: Record<string, string> = {};
  url.searchParams.forEach((value, name) => {
    params[name] = value;
  });
  const parts = template.split(/\\{([^}]+)\\}/);
  const names = parts.filter((_, index) => index % 2 === 1);
  const pattern = parts
    .map((part, index) => (index % 2 === 1 ? '([^/]+)' : part.replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&')))
    .join('');
  const match = new RegExp(pattern + '/?$').exec(url.pathname);
  names.forEach((name, index) => {
    const value = match?.[index + 1];
    if (value !== undefined) params[name] = decodeURIComponent(value);
  });
  return params;
};

const mockOperation = <Response, Arg>(
  method: 'get' | 'post' | 'put' | 'patch' | 'delete' | 'head' | 'options',
  pattern: string,
  template: string,
  kind: BodyKind,
  status: number,
  defaultMock: () => Response | null,
  custom: Partial<StoryMock<Response, Arg>> = {},
) =>
  http[method](custom.url ?? pattern, async (info) => {
    if (custom.delay !== undefined) await delay(custom.delay);
    const fallback = defaultMock();
    const answer = custom.response;
    const body =
      typeof answer === 'function'
        ? await (answer as (params: StoryMockParams<Arg>, defaultMock: Response | null, info: ResolverInfo) => Response | Promise<Response>)(
            readParams(template, info) as StoryMockParams<Arg>,
            fallback,
            info,
          )
        : answer !== undefined
          ? answer
          : fallback;
    const init = { status: custom.status ?? status };
    if (body === null || body === undefined) return new HttpResponse(null, init);
    if (kind === 'json') return HttpResponse.json(body as never, init);
    return new HttpResponse(body as unknown as BodyInit, init);
  });
`;

/**
 * MSW URL pattern of an operation path: any origin and base path (`*`), then the path with each `{param}` as an MSW
 * `:param`, which matches exactly one segment (a `*` would match across segments: `/books/{id}` would also answer
 * `/books/7/archive`). Parameter names are reduced to word characters and kept unique.
 */
export function mswPathPattern(operationPath: string): string {
  const used = new Set<string>();
  const path = operationPath.replace(/\{([^}]+)\}/g, (_, raw: string) => {
    let name = raw.replace(/\W/g, '_') || 'param';
    if (/^\d/.test(name)) name = `p${name}`;
    let unique = name;
    for (let index = 2; used.has(unique); index++) unique = `${name}${index}`;
    used.add(unique);
    return `:${unique}`;
  });
  return `*${path}`;
}

/** The first declared 2xx status of an operation; 200 when it declares none. */
function successStatus(responses: Record<string, unknown> | undefined): number {
  const codes = Object.keys(responses ?? {}).filter((code) => /^2\d\d$/.test(code)).map(Number).sort((a, b) => a - b);
  return codes[0] ?? 200;
}

/** `key: build.query<Response, Arg>(…)` → the type argument texts. */
function readTypeArguments(ts: typeof TypeScript, sourceFile: TypeScript.SourceFile): Map<string, { response?: string; arg?: string }> {
  const result = new Map<string, { response?: string; arg?: string }>();
  const visit = (node: TypeScript.Node): void => {
    if (ts.isPropertyAssignment(node) && ts.isCallExpression(node.initializer)) {
      const callee = node.initializer.expression;
      if (ts.isPropertyAccessExpression(callee) && ['query', 'mutation'].includes(callee.name.text)) {
        const key = node.name.getText(sourceFile).replace(/^["']|["']$/g, '');
        const [response, arg] = node.initializer.typeArguments ?? [];
        result.set(key, { response: response?.getText(sourceFile), arg: arg?.getText(sourceFile) });
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return result;
}

/** Local name → exported name and module file of every named import of a generated file. */
function readImports(ts: typeof TypeScript, sourceFile: TypeScript.SourceFile, filePath: string, files: OutputFiles): Map<string, ImportedName> {
  const result = new Map<string, ImportedName>();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const specifier = statement.moduleSpecifier.text;
    if (!specifier.startsWith('.')) continue;
    const base = path.resolve(path.dirname(filePath), specifier.replace(/\.js$/, ''));
    const file = files.findPath(`${base}.ts`) ?? files.findPath(path.join(base, 'index.ts'));
    const bindings = statement.importClause?.namedBindings;
    if (!file || !bindings || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      result.set(element.name.text, { exported: (element.propertyName ?? element.name).text, file });
    }
  }
  return result;
}

/** The file that declares `name`: the imported module itself, or (through a barrel) the model file exporting it. */
function declaringFile(name: string, module: string, files: OutputFiles): string | undefined {
  const declares = (file: string): boolean =>
    new RegExp(`^export (?:type|interface) ${name}\\b`, 'm').test(files.get(file) ?? '');
  if (declares(module)) return module;
  const barrel = files.get(module) ?? '';
  for (const match of barrel.matchAll(/from ['"](.+?)['"]/g)) {
    const base = path.resolve(path.dirname(module), match[1]!.replace(/\.js$/, ''));
    const file = files.findPath(`${base}.ts`);
    if (file && declares(file)) return file;
  }
  return undefined;
}

/** A response type that is one model, or an array of one model (`| null` aside). */
function responseShape(
  ts: typeof TypeScript,
  responseType: string,
  apiImports: Map<string, ImportedName>,
  files: OutputFiles,
): { model: ModelRef; array: boolean } | null {
  const imported = apiImports.get(responseType);
  if (!imported) return null;
  const file = declaringFile(imported.exported, imported.file, files);
  if (!file) return null;
  const sourceFile = ts.createSourceFile('response.ts', files.get(file)!, ts.ScriptTarget.Latest, true);
  const alias = sourceFile.statements.find(
    (statement): statement is TypeScript.TypeAliasDeclaration =>
      ts.isTypeAliasDeclaration(statement) && statement.name.text === imported.exported,
  );
  if (!alias) return null;
  let type: TypeScript.TypeNode = alias.type;
  while (ts.isParenthesizedTypeNode(type)) type = type.type;
  if (ts.isUnionTypeNode(type)) {
    const members = type.types.filter(
      (member) => !(ts.isLiteralTypeNode(member) && member.literal.kind === ts.SyntaxKind.NullKeyword) && member.kind !== ts.SyntaxKind.UndefinedKeyword,
    );
    if (members.length !== 1) return null;
    type = members[0]!;
  }
  let array = false;
  if (ts.isArrayTypeNode(type)) {
    array = true;
    type = type.elementType;
  } else if (ts.isTypeReferenceNode(type) && ts.isIdentifier(type.typeName) && type.typeName.text === 'Array' && type.typeArguments?.length === 1) {
    array = true;
    type = type.typeArguments[0]!;
  }
  while (ts.isParenthesizedTypeNode(type)) type = type.type;
  if (!ts.isTypeReferenceNode(type) || !ts.isIdentifier(type.typeName) || type.typeArguments) return null;
  const modelImports = readImports(ts, sourceFile, file, files);
  const model = modelImports.get(type.typeName.text);
  if (!model) return null;
  const modelFile = declaringFile(model.exported, model.file, files);
  return modelFile ? { model: { file: modelFile, exported: model.exported }, array } : null;
}
