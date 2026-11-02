import type TypeScript from 'typescript';
import type { Logger } from './log';
import type { HttpMethod } from './openapi';
import { loadTypeScript } from './typescript';

/** HTTP method and OpenAPI path of a generated endpoint, recorded while RTK codegen selects the operations. */
export interface OperationLocation {
  method: HttpMethod;
  path: string;
}

/** One endpoint of a generated RTK api file. */
export interface EndpointInfo {
  key: string;
  buildType: 'query' | 'mutation';
  /** URL as written in the generated code, e.g. `/api/x/${queryArg.id}`. */
  url: string;
  /** HTTP method, uppercase. */
  method: string;
  /** OpenAPI path of the operation, e.g. `/api/x/{id}`. */
  path: string;
  /**
   * Path placeholder → expression reading its value from the endpoint argument `arg`, e.g. `{ id: 'arg.id' }`, or
   * `{ id: 'arg' }` with `flattenArg`. Independent of `encodePathParams`.
   */
  pathArgs: Record<string, string>;
  /**
   * Expression reading the request body from the endpoint argument `arg`, e.g. `arg.bookUpdateRequestDto`, or `arg`
   * with `flattenArg`. Absent when the endpoint sends no body.
   */
  bodyArg?: string;
  /** Name of the response type (first type argument of `build.query<…>` / `build.mutation<…>`). */
  responseType?: string;
}

/** `/api/x/${queryArg.fooId}` → `/api/x/{fooId}` (the OpenAPI path, for URLs without a recorded operation). */
export function toOpenApiPath(url: string): string {
  return url
    .replace(/\$\{encodeURIComponent\(String\(queryArg\.([A-Za-z0-9_]+)\)\)\}/g, '{$1}')
    .replace(/\$\{queryArg\.([A-Za-z0-9_]+)\}/g, '{$1}');
}

function objectReturnedBy(ts: typeof TypeScript, fn: TypeScript.ArrowFunction): TypeScript.ObjectLiteralExpression | null {
  const body = fn.body;
  if (ts.isParenthesizedExpression(body) && ts.isObjectLiteralExpression(body.expression)) return body.expression;
  if (ts.isObjectLiteralExpression(body)) return body;
  if (ts.isBlock(body)) {
    for (const statement of body.statements) {
      if (ts.isReturnStatement(statement) && statement.expression) {
        let expression = statement.expression;
        if (ts.isParenthesizedExpression(expression)) expression = expression.expression;
        if (ts.isObjectLiteralExpression(expression)) return expression;
      }
    }
  }
  return null;
}

/** `encodeURIComponent(String(x))` → `x`. */
function unwrapEncoding(ts: typeof TypeScript, expression: TypeScript.Expression): TypeScript.Expression {
  let current = expression;
  while (
    ts.isCallExpression(current) &&
    ts.isIdentifier(current.expression) &&
    (current.expression.text === 'encodeURIComponent' || current.expression.text === 'String') &&
    current.arguments.length === 1
  ) {
    current = current.arguments[0]!;
  }
  return current;
}

/** Accessor expressions of the URL template's substitutions, in order (`queryArg` rewritten to `arg`). */
function templateAccessors(ts: typeof TypeScript, init: TypeScript.TemplateExpression, sourceFile: TypeScript.SourceFile): string[] {
  return init.templateSpans.map((span) => unwrapEncoding(ts, span.expression).getText(sourceFile).replace(/^queryArg\b/, 'arg'));
}

function readEndpoint(
  ts: typeof TypeScript,
  key: string,
  buildType: 'query' | 'mutation',
  call: TypeScript.CallExpression,
  sourceFile: TypeScript.SourceFile,
  location: OperationLocation | undefined,
  logger: Logger,
): EndpointInfo | null {
  const definition = call.arguments[0];
  if (!definition || !ts.isObjectLiteralExpression(definition)) return null;
  const responseTypeNode = call.typeArguments?.[0];
  const responseType =
    responseTypeNode && ts.isTypeReferenceNode(responseTypeNode) && ts.isIdentifier(responseTypeNode.typeName)
      ? responseTypeNode.typeName.text
      : undefined;
  for (const property of definition.properties) {
    if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name) || property.name.text !== 'query') continue;
    if (!ts.isArrowFunction(property.initializer)) continue;
    const returned = objectReturnedBy(ts, property.initializer);
    if (!returned) continue;
    let url: string | undefined;
    let method: string | undefined;
    let accessors: string[] = [];
    let bodyArg: string | undefined;
    for (const member of returned.properties) {
      if (!ts.isPropertyAssignment(member) || !ts.isIdentifier(member.name)) continue;
      const init = member.initializer;
      if (member.name.text === 'url') {
        if (ts.isNoSubstitutionTemplateLiteral(init) || ts.isStringLiteral(init)) url = init.text;
        else if (ts.isTemplateExpression(init)) {
          url = init.getText(sourceFile).slice(1, -1);
          accessors = templateAccessors(ts, init, sourceFile);
        }
      }
      if (member.name.text === 'method' && ts.isStringLiteral(init)) method = init.text;
      if (member.name.text === 'body' && (ts.isIdentifier(init) || ts.isPropertyAccessExpression(init))) {
        const text = init.getText(sourceFile);
        if (/^queryArg(\.[A-Za-z_$][A-Za-z0-9_$]*)*$/.test(text)) bodyArg = text.replace(/^queryArg\b/, 'arg');
      }
    }
    if (url === undefined) {
      logger.warn(`No extractable URL for endpoint "${key}" — skipping.`);
      return null;
    }
    const path = location?.path ?? toOpenApiPath(url);
    const placeholders = [...path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]!);
    const pathArgs: Record<string, string> = {};
    placeholders.forEach((name, index) => {
      const accessor = accessors[index];
      if (accessor !== undefined) pathArgs[name] = accessor;
    });
    return {
      key,
      buildType,
      url,
      method: (location?.method ?? method ?? 'GET').toUpperCase(),
      path,
      pathArgs,
      ...(bodyArg ? { bodyArg } : {}),
      ...(responseType ? { responseType } : {}),
    };
  }
  return null;
}

/**
 * Parses a generated RTK Query api file and returns every `build.query` / `build.mutation` endpoint. `locations`
 * (endpoint key → operation, recorded during generation) identifies each endpoint's operation; without an entry the
 * method and path are read back from the generated code.
 */
export function parseApiEndpoints(
  source: string,
  logger: Logger,
  locations: ReadonlyMap<string, OperationLocation> = new Map(),
): EndpointInfo[] {
  const ts = loadTypeScript();
  const sourceFile = ts.createSourceFile('api.ts', source, ts.ScriptTarget.Latest, true);
  const results: EndpointInfo[] = [];
  const visit = (node: TypeScript.Node): void => {
    if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name) && ts.isCallExpression(node.initializer)) {
      const callee = node.initializer.expression;
      if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && callee.expression.text === 'build') {
        const buildType = callee.name.text;
        if (buildType === 'query' || buildType === 'mutation') {
          const key = node.name.text;
          const info = readEndpoint(ts, key, buildType, node.initializer, sourceFile, locations.get(key), logger);
          if (info) results.push(info);
          return;
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
  return results;
}
