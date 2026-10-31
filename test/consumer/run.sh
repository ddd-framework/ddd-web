#!/usr/bin/env bash
# Installs a packed @mgamadeus/ddd-web tarball into a fresh consumer project and checks it as a user would:
#   1. every exports / bin target exists in the tarball (scripts/check-package.mjs)
#   2. every subpath imports at runtime (smoke.mjs)
#   3. a strict TypeScript consumer importing every subpath compiles with moduleResolution bundler and nodenext
#   4. ddd-web-sdk generates an SDK from the sample spec, for bundler and for nodenext (esmExtensions), and the
#      generated code type-checks
#   5. ddd-web link-skills runs
#
# Usage: test/consumer/run.sh <tarball> <npm|pnpm> <workDir>
set -euo pipefail

TARBALL=$(cd "$(dirname "$1")" && pwd)/$(basename "$1")
PM=$2
WORK=$3
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)

rm -rf "$WORK" && mkdir -p "$WORK/extracted"
tar -xzf "$TARBALL" -C "$WORK/extracted"
echo "── tarball contents"
node "$ROOT/scripts/check-package.mjs" "$WORK/extracted/package"

APP="$WORK/app"
mkdir -p "$APP"
cp "$HERE/smoke.mjs" "$HERE/consumer.ts" "$ROOT/test/fixtures/specs/sample-admin.json" "$APP/"
cd "$APP"
echo '{"name":"consumer","private":true,"type":"module"}' > package.json
DEPS=("$TARBALL" @reduxjs/toolkit react react-redux @types/react typescript @types/node)
echo "── install with $PM"
if [ "$PM" = npm ]; then npm install --no-audit --no-fund "${DEPS[@]}"; else pnpm add "${DEPS[@]}"; fi

echo "── runtime imports"
node smoke.mjs

for MODE in bundler nodenext; do
  if [ "$MODE" = bundler ]; then MODULE=esnext; ESM=false; else MODULE=nodenext; ESM=true; fi
  mkdir -p "sdk-$MODE/api"
  cat > "sdk-$MODE/api/baseApi.ts" <<TS
import { createApi, fetchBaseQuery } from '@reduxjs/toolkit/query/react';
export const baseApi = createApi({ baseQuery: fetchBaseQuery({ baseUrl: '' }), endpoints: () => ({}) });
TS
  cat > "tsconfig.$MODE.json" <<JSON
{
  "compilerOptions": {
    "target": "ES2022", "lib": ["ES2022", "DOM"], "module": "$MODULE", "moduleResolution": "$MODE",
    "strict": true, "noUncheckedIndexedAccess": true, "skipLibCheck": false, "noEmit": true,
    "resolveJsonModule": true, "types": ["node"]
  },
  "include": ["consumer.ts", "sdk-$MODE"]
}
JSON
  cat > "openapi-config.$MODE.ts" <<TS
import { defineConfig } from '@mgamadeus/ddd-web/codegen';
export default defineConfig({
  tsconfig: 'tsconfig.$MODE.json',
  apis: [{
    schemaFile: './sample-admin.json',
    apiFile: './sdk-$MODE/api/baseApi.ts', apiImport: 'baseApi',
    outputFile: './sdk-$MODE/api/adminApi.ts', exportName: 'adminApi',
    hooks: { queries: true, lazyQueries: true, mutations: true },
    esmExtensions: $ESM,
  }],
});
TS
  echo "── ddd-web-sdk ($MODE)"
  if [ "$PM" = npm ]; then npx --no-install ddd-web-sdk --config "openapi-config.$MODE.ts"; else pnpm exec ddd-web-sdk --config "openapi-config.$MODE.ts"; fi
  echo "── tsc ($MODE): consumer + generated SDK"
  node node_modules/typescript/bin/tsc -p "tsconfig.$MODE.json"
done

echo "── ddd-web link-skills"
if [ "$PM" = npm ]; then npx --no-install ddd-web link-skills; else pnpm exec ddd-web link-skills; fi
echo "consumer check ($PM) passed"
