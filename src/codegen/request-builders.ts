import type TypeScript from 'typescript';
import { loadTypeScript } from './typescript';

/** The api file with its request builders moved out, and the module that exports them. */
export interface SplitRequestBuilders {
  /** The api file: every endpoint's `query` refers to its builder in the requests module. */
  apiSource: string;
  /** The requests module: `export const <name> = { <endpoint>: (queryArg: <Arg>) => ({ url, … }), … }`. */
  requestsSource: string;
  /** How many builders were moved. */
  count: number;
}

/**
 * Moves the `query` builder of every endpoint of a generated api file into an object of its own module, keyed by the
 * endpoint name, and lets the endpoint use it (`query: adminApiRequests.getItems`): a bundle that only sends
 * requests imports the builders without the endpoint injection. Each builder's argument is typed with the endpoint's
 * argument type and returns `string | FetchArgs` (a type import of RTK Query, erased in the bundle). Named imports that
 * a file no longer uses are dropped from it.
 */
export function splitRequestBuilders(
  apiSource: string,
  requestsObjectName: string,
  requestsModuleSpecifier: string,
): SplitRequestBuilders {
  const ts = loadTypeScript();
  const sourceFile = ts.createSourceFile('api.ts', apiSource, ts.ScriptTarget.Latest, true);
  const builders: Array<{ name: string; text: string }> = [];
  const replacements: Array<{ start: number; end: number; text: string }> = [];

  const visit = (node: TypeScript.Node): void => {
    // `<endpoint>: build.query<Response, Arg>({ query: (queryArg) => (…), … })`
    if (ts.isPropertyAssignment(node) && ts.isCallExpression(node.initializer)) {
      const call = node.initializer;
      const callee = call.expression;
      const isBuildCall =
        ts.isPropertyAccessExpression(callee) && ['query', 'mutation'].includes(callee.name.text) && ts.isIdentifier(callee.expression);
      const definition = call.arguments[0];
      if (isBuildCall && definition && ts.isObjectLiteralExpression(definition)) {
        const endpointName = node.name.getText(sourceFile).replace(/^["']|["']$/g, '');
        const queryProperty = definition.properties.find(
          (property): property is TypeScript.PropertyAssignment =>
            ts.isPropertyAssignment(property) && property.name.getText(sourceFile) === 'query' && ts.isArrowFunction(property.initializer),
        );
        if (queryProperty && ts.isArrowFunction(queryProperty.initializer)) {
          const builder = queryProperty.initializer;
          const argType = call.typeArguments?.[1]?.getText(sourceFile);
          const parameter = builder.parameters[0];
          const parameterText =
            parameter && !parameter.type && argType && argType !== 'void'
              ? `(${parameter.name.getText(sourceFile)}: ${argType})`
              : `(${builder.parameters.map((current) => current.getText(sourceFile)).join(', ')})`;
          const bodyText = builder.body.getText(sourceFile);
          // the builder's return type keeps literal members (`responseHandler: "text"`) as RTK Query reads them
          builders.push({ name: endpointName, text: `${parameterText}: string | FetchArgs => ${bodyText}` });
          replacements.push({
            start: builder.getStart(sourceFile),
            end: builder.getEnd(),
            text: `${requestsObjectName}.${endpointName}`,
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  if (builders.length === 0) return { apiSource, requestsSource: '', count: 0 };

  let replacedApiSource = apiSource;
  for (const { start, end, text } of replacements.sort((a, b) => b.start - a.start)) {
    replacedApiSource = replacedApiSource.slice(0, start) + text + replacedApiSource.slice(end);
  }

  const importDeclarations = sourceFile.statements.filter(ts.isImportDeclaration);
  const importTexts = importDeclarations.map((declaration) => declaration.getText(sourceFile));
  const requestsBody =
    `export const ${requestsObjectName} = {\n` +
    builders.map(({ name, text }) => `  ${/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : JSON.stringify(name)}: ${text},`).join('\n') +
    '\n};\n';
  const requestsSource = [
    `import type { FetchArgs } from '@reduxjs/toolkit/query';`,
    ...keepUsedImports(ts, importTexts, requestsBody),
  ].join('\n') + `\n\n${requestsBody}`;

  // the api file: its own import of the builders, and only the imports it still uses
  const apiWithoutImports = stripImports(ts, replacedApiSource);
  const apiImports = [
    ...keepUsedImports(ts, importTexts, apiWithoutImports),
    `import { ${requestsObjectName} } from '${requestsModuleSpecifier}';`,
  ];
  return { apiSource: `${apiImports.join('\n')}\n${apiWithoutImports}`, requestsSource, count: builders.length };
}

/** The source without its import declarations. */
function stripImports(ts: typeof TypeScript, source: string): string {
  const sourceFile = ts.createSourceFile('api.ts', source, ts.ScriptTarget.Latest, true);
  let result = source;
  for (const declaration of [...sourceFile.statements.filter(ts.isImportDeclaration)].reverse()) {
    result = result.slice(0, declaration.getFullStart()) + result.slice(declaration.getEnd());
  }
  return result.replace(/^\s+/, '\n');
}

/** The import declarations reduced to the named bindings `body` uses; a declaration left without bindings goes. */
function keepUsedImports(ts: typeof TypeScript, importTexts: string[], body: string): string[] {
  // the identifiers the body uses as values or types (a URL text or a property name after `.` is none)
  const usedNames = new Set<string>();
  const bodyFile = ts.createSourceFile('body.ts', body, ts.ScriptTarget.Latest, true);
  const collect = (node: TypeScript.Node): void => {
    if (ts.isIdentifier(node) && !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node)
      && !(ts.isPropertyAssignment(node.parent) && node.parent.name === node)
    ) {
      usedNames.add(node.text);
    }
    ts.forEachChild(node, collect);
  };
  collect(bodyFile);
  const used = (name: string): boolean => usedNames.has(name);
  const kept: string[] = [];
  for (const importText of importTexts) {
    const sourceFile = ts.createSourceFile('import.ts', importText, ts.ScriptTarget.Latest, true);
    const declaration = sourceFile.statements.find(ts.isImportDeclaration);
    const bindings = declaration?.importClause?.namedBindings;
    if (!declaration || !bindings || !ts.isNamedImports(bindings) || declaration.importClause?.name) {
      kept.push(importText);
      continue;
    }
    const elements = bindings.elements.filter((element) => used(element.name.text));
    if (elements.length === 0) continue;
    const typeOnly = declaration.importClause?.isTypeOnly ? 'type ' : '';
    const specifier = declaration.moduleSpecifier.getText(sourceFile);
    kept.push(`import ${typeOnly}{ ${elements.map((element) => element.getText(sourceFile)).join(', ')} } from ${specifier};`);
  }
  return kept;
}
