import Module, { createRequire } from 'node:module';
import * as path from 'node:path';

type ResolveFilename = (request: string, parent: { filename?: string | null } | undefined, ...rest: unknown[]) => string;

let installed = false;

/**
 * Answers the `ajv` lookups of `ajv-draft-04` from the `ajv` 8 of the OpenAPI parser
 * (`@apidevtools/swagger-parser`, a dependency of `@rtk-query/codegen-openapi`).
 *
 * `ajv-draft-04` expects `ajv` 8 as a peer. A consumer that installs with `legacy-peer-deps` gets `ajv-draft-04` hoisted
 * to the top of `node_modules`, next to an `ajv` 6 of its own tooling, and the parser fails to load. The parser's own
 * `ajv` 8 is answered instead; a lookup the parser cannot answer keeps the default resolution. Installed once, before the
 * codegen is loaded ({@link loadRtkCodegen}).
 */
export function installParserModuleResolution(): void {
  if (installed) return;
  installed = true;
  const require = createRequire(import.meta.url);
  let parserRequire: NodeJS.Require;
  try {
    const codegenRequire = createRequire(require.resolve('@rtk-query/codegen-openapi'));
    parserRequire = createRequire(codegenRequire.resolve('@apidevtools/swagger-parser'));
  } catch {
    return;
  }
  const ajvDraft04Folder = `${path.sep}ajv-draft-04${path.sep}`;
  const moduleWithResolver = Module as unknown as { _resolveFilename: ResolveFilename };
  const defaultResolveFilename = moduleWithResolver._resolveFilename;
  moduleWithResolver._resolveFilename = function resolveAjvOfTheParser(request, parent, ...rest) {
    if ((request === 'ajv' || request.startsWith('ajv/')) && parent?.filename?.includes(ajvDraft04Folder)) {
      try {
        return parserRequire.resolve(request);
      } catch {
        // the parser has no such module: the default resolution answers
      }
    }
    return defaultResolveFilename.call(this, request, parent, ...rest);
  };
}

/** `@rtk-query/codegen-openapi`, loaded after {@link installParserModuleResolution}. */
export async function loadRtkCodegen(): Promise<typeof import('@rtk-query/codegen-openapi')> {
  installParserModuleResolution();
  return import('@rtk-query/codegen-openapi');
}
