/**
 * Vite plugin: binds the `Request` that RTK Query's `fetchBaseQuery` constructs to `FetchApiRequest`
 * (`@mgamadeus/ddd-web/fetch-api-request`), for apps that run inside pages whose global `Request` is not the Fetch API's
 * (MooTools 1.x, Prototype). The binding is an import prepended to the toolkit's query module; it shadows the global
 * there and nowhere else, so the page's own scripts keep their class.
 *
 * Build only (a watch build included). The dev server pre-bundles the toolkit untransformed (`optimizeDeps`), so a page
 * with a foreign `Request` served by the dev server is not covered; the base query then refuses the request with a
 * message that names the cause. The build fails when the toolkit's query module is part of it and is not bound (its
 * file moved, or it no longer constructs a `Request`), so a toolkit update cannot bring the defect back unnoticed.
 *
 * @example
 * // vite.config.ts
 * import { dddFetchApiRequestPlugin } from '@mgamadeus/ddd-web/vite';
 * export default defineConfig({ plugins: [react(), dddFetchApiRequestPlugin()] });
 */

/** The parts of a Rollup plugin context the plugin uses. */
export interface DddFetchApiRequestPluginContext {
  error(message: string): never;
  getModuleIds(): IterableIterator<string>;
  getModuleInfo(moduleId: string): { code: string | null } | null;
}

/** The plugin object (a Vite `Plugin`; typed structurally, so the package needs no Vite dependency). */
export interface DddFetchApiRequestPlugin {
  name: string;
  apply: 'build';
  enforce: 'pre';
  transform(this: DddFetchApiRequestPluginContext, code: string, moduleId: string): { code: string; map: null } | null;
  buildEnd(this: DddFetchApiRequestPluginContext, buildError?: Error): void;
}

export interface DddFetchApiRequestPluginOptions {
  /** Module that exports `FetchApiRequest`. Default `@mgamadeus/ddd-web/fetch-api-request`. */
  fetchApiRequestModule?: string;
}

const TOOLKIT_QUERY_MODULE_PATH = /[\\/]@reduxjs[\\/]toolkit[\\/]dist[\\/]query[\\/]rtk-query\.[\w.-]+\.m?js$/;
const TOOLKIT_QUERY_FOLDER_PATH = /[\\/]@reduxjs[\\/]toolkit[\\/]dist[\\/]query[\\/][^\\/]+\.m?js$/;
const REQUEST_CONSTRUCTION = 'new Request(';
const REQUEST_BINDING_NAME = 'FetchApiRequest';

const readModulePath = (moduleId: string): string => moduleId.split('?')[0] as string;

export function dddFetchApiRequestPlugin(options: DddFetchApiRequestPluginOptions = {}): DddFetchApiRequestPlugin {
  const fetchApiRequestModule = options.fetchApiRequestModule ?? '@mgamadeus/ddd-web/fetch-api-request';
  // On the module's first line, without a line break: every line keeps its number in the source map.
  const requestBinding = `import { ${REQUEST_BINDING_NAME} as Request } from ${JSON.stringify(fetchApiRequestModule)};`;
  return {
    name: 'ddd-web:fetch-api-request-in-toolkit-query',
    apply: 'build',
    enforce: 'pre',
    transform(code, moduleId) {
      if (!TOOLKIT_QUERY_MODULE_PATH.test(readModulePath(moduleId))) return null;
      if (!code.includes(REQUEST_CONSTRUCTION)) {
        this.error(`${moduleId} constructs no Request any more: check how the toolkit builds its requests now.`);
      }
      return { code: `${requestBinding}${code}`, map: null };
    },
    /** Reads the built modules and keeps no state: a watch rebuild takes the bound toolkit module from its cache. */
    buildEnd(buildError) {
      if (buildError) return;
      const toolkitQueryModuleIds = [...this.getModuleIds()].filter((moduleId) => TOOLKIT_QUERY_FOLDER_PATH.test(readModulePath(moduleId)));
      const unboundModuleIds = toolkitQueryModuleIds.filter((moduleId) => {
        const moduleCode = this.getModuleInfo(moduleId)?.code ?? '';
        return moduleCode.includes(REQUEST_CONSTRUCTION) && !moduleCode.includes(REQUEST_BINDING_NAME);
      });
      const isQueryModulePartOfBuild = toolkitQueryModuleIds.some((moduleId) => TOOLKIT_QUERY_MODULE_PATH.test(readModulePath(moduleId)));
      if (unboundModuleIds.length > 0 || (toolkitQueryModuleIds.length > 0 && !isQueryModulePartOfBuild)) {
        this.error(`ddd-web: the toolkit's query module is part of this build but its Request is not bound: ${toolkitQueryModuleIds.join(', ')}`);
      }
    },
  };
}
