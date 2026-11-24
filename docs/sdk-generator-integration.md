# SDK generation modes

Use the same `openapi-config.ts` and API entries for all three modes. Omit `generator` to use DDD Web’s existing RTK Query generation. Select an opt-in mode per run with `ddd-web-sdk --mode future` or `ddd-web-sdk --mode legacy`, or set `generator.mode` in the config.

| Mode | Output | Consumer dependency |
| --- | --- | --- |
| `default` | DDD RTK Query endpoints, hooks, shared models, tags, enhancements, and configured request builders | Existing DDD Web dependencies |
| `future` | TypeScript models and a typed promise client, with optional seeded mocks | `swagger-sdk-generator@^3` from npm |
| `legacy` | Legacy-dialect models, stores, thunks, and mocks | `swagger-sdk-generator@^3.1` from npm, plus the generated code’s Redux Toolkit, RxJS, and Faker dependencies |

## Promise client

Install the generator as an application dependency. Generated clients use its runtime in the running app.

```sh
pnpm add swagger-sdk-generator@^3
pnpm exec ddd-web-sdk --mode future
```

To inject a transport or add mocks, configure the output options in `openapi-config.ts`.

```ts
export default defineConfig({
  generator: {
    mode: 'future',
    outputs: { client: { transport: 'none' }, mocks: {} },
  },
  apis: [{
    schemaFile: './openapi.json',
    apiFile: './src/api/baseApi.ts',
    outputFile: './src/api/adminApi.ts',
  }],
});
```

Import `createApi` from `src/generated-sdk/future/adminApi/client/client.ts`. The client defaults to Fetch. With `transport: 'none'`, pass a custom transport or wrap an application-owned Axios instance with `createAxiosTransport` from `swagger-sdk-generator/runtime`. Configure auth and request hooks when calling `createApi`. Install Faker if you enable mocks.

## Legacy stores

Install `swagger-sdk-generator@^3.1`, then run `ddd-web-sdk --mode legacy`. The generated `stores/stores.ts` configures the shared transport runtime. Keep the model aliases required by your legacy configuration. For the default legacy alias, map `@models/swagger/*` to `./src/generated-sdk/legacy/adminApi/models/*` in the consuming project.

Set `generator.outputs.stores.runtimeModule` to use an app-owned runtime and generate only the operation stores. Use a package or alias specifier, or a relative path from the stores output directory. With the standard legacy mode, the module exports `send`, which you can get from `createStoreRuntime` in `swagger-sdk-generator/runtime/stores`. Configure that runtime with your own transport, such as an Axios instance wrapped with `createAxiosTransport`.

Apps migrating an existing legacy generator can call `generateLegacySdk` from `@mgamadeus/ddd-web/codegen`. Pass the ordered OpenAPI sources and explicit generator output options, including the app’s existing directories. This entry point accepts plain OpenAPI documents and stages the planned files before writing them. Files outside the plan stay in place.

For `engine: 'legacy'`, your `runtimeModule` exports `LegacyStoreBase`, `AbortControllersManager`, `HttpCallOptions` (a type), `sendLegacyRequest`, and `legacyStoreThunk`. The generated methods delegate to `sendLegacyRequest(store, abortManager, verb, path, call)`. The call includes query parameters, options, content type, the binary response flag, and the request body for writes. When `legacyRequestBuilders` is configured, the call also carries the operation's builder metadata so the app can choose its sender. The runtime's `legacyStoreThunk(name, request)` wraps an Observable-returning method for Redux Toolkit callers.

## Output and validation

The opt-in directories default to `src/generated-sdk/<mode>/<output-file-stem>/`. Change the base with `generator.outputDir`. DDD Web owns and replaces each selected API’s directory, so use a dedicated directory for generated files. Relative imports in the delegated TypeScript output assume bundler-style resolution.

Both opt-in modes validate the DDD contract, repair missing path parameters, and honor `skipUpdatePostTwins`. They use the external generator’s output and transport behavior. DDD RTK-specific settings, including base API bindings, hooks, response overrides, and invalidation resolvers, apply in default mode. `--api` regenerates one API and `--schema` can override its input. Generation stages every selected API and restores previous files if the type check fails.
