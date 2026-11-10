#!/usr/bin/env node
/**
 * Smoke-tests the BUILT package (run `pnpm build` first): loads `@holodeck/sdk` BY NAME,
 * through the package's own `exports` map (package self-reference), both by `import` and by
 * Node's `require(esm)`. A relative path would skip `exports` and miss a broken map or a
 * missing `default` condition; `require(esm)` also proves dist has no top-level await.
 *
 * Used by test.yml ("Smoke-test built package") and `scripts/dev-check.sh full`.
 */
import { createRequire } from 'node:module';

const imported = await import('@holodeck/sdk');
if (typeof imported.HolodeckHost !== 'function') throw new Error('import(@holodeck/sdk) failed: no HolodeckHost export');

const required = createRequire(import.meta.url)('@holodeck/sdk');
if (typeof required.HolodeckHost !== 'function') throw new Error('require(@holodeck/sdk) (require(esm)) failed: no HolodeckHost export');

console.log('smoke-dist: ok (import + require(esm))');
