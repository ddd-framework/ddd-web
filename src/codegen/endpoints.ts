import type TypeScript from 'typescript';
import type { Logger } from './log';
import { loadTypeScript } from './typescript';

/** One endpoint of a generated RTK api file. */
export interface EndpointInfo {
  key: string;
  buildType: 'query' | 'mutation';
  /** URL as written in the generated code, e.g. `/api/x/${queryArg.id}`. */
  url: string;
  method: string;
}

/** `/api/x/${queryArg.fooId}` → `/api/x/{fooId}` (the OpenAPI path). */
export function toOpenApiPath(url: string): string {
  return url.replace(/\$\{queryArg\.([A-Za-z0-9_]+)\}/g, '{$1}');
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

function readEndpoint(
  ts: typeof TypeScript,
  key: string,
  buildType: 'query' | 'mutation',
  call: TypeScript.CallExpression,
  sourceFile: TypeScript.SourceFile,
  logger: Logger,
): EndpointInfo | null {
  const definition = call.arguments[0];
  if (!definition || !ts.isObjectLiteralExpression(definition)) return null;
  for (const property of definition.properties) {
    if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name) || property.name.text !== 'query') continue;
    if (!ts.isArrowFunction(property.initializer)) continue;
    const returned = objectReturnedBy(ts, property.initializer);
    if (!returned) continue;
    let url: string | undefined;
    let method: string | undefined;
    for (const member of returned.properties) {
      if (!ts.isPropertyAssignment(member) || !ts.isIdentifier(member.name)) continue;
      const init = member.initializer;
      if (member.name.text === 'url') {
        if (ts.isNoSubstitutionTemplateLiteral(init) || ts.isStringLiteral(init)) url = init.text;
        else if (ts.isTemplateExpression(init)) url = init.getText(sourceFile).slice(1, -1);
      }
      if (member.name.text === 'method' && ts.isStringLiteral(init)) method = init.text;
    }
    if (url !== undefined) return { key, buildType, url, method: method ?? 'GET' };
    logger.warn(`No extractable URL for endpoint "${key}" — skipping.`);
    return null;
  }
  return null;
}

/** Parses a generated RTK Query api file and returns every `build.query` / `build.mutation` endpoint. */
export function parseApiEndpoints(source: string, logger: Logger): EndpointInfo[] {
  const ts = loadTypeScript();
  const sourceFile = ts.createSourceFile('api.ts', source, ts.ScriptTarget.Latest, true);
  const results: EndpointInfo[] = [];
  const visit = (node: TypeScript.Node): void => {
    if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name) && ts.isCallExpression(node.initializer)) {
      const callee = node.initializer.expression;
      if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && callee.expression.text === 'build') {
        const buildType = callee.name.text;
        if (buildType === 'query' || buildType === 'mutation') {
          const info = readEndpoint(ts, node.name.text, buildType, node.initializer, sourceFile, logger);
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
