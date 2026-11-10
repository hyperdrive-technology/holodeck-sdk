import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**'],
      exclude: [
        'coverage/**',
        'dist/**',
        '**/node_modules/**',
        '**/[.]**',
        'packages/*/test?(s)/**',
        '**/*.d.ts',
        '**/virtual:*',
        '**/__x00__*',
        '**/\x00*',
        'cypress/**',
        'test?(s)/**',
        'test?(-*).?(c|m)[jt]s?(x)',
        '**/*{.,-}{test,spec}.?(c|m)[jt]s?(x)',
        '**/__tests__/**',
        '**/{karma,rollup,webpack,vite,vitest,jest,ava,babel,nyc,cypress,tsup,build}.config.*',
        '**/vitest.{workspace,projects}.[jt]s?(on)',
        '**/.{eslint,mocha,prettier}rc.{?(c|m)js,yml}'
      ],
      // Flat keys: Vitest reads a nested `global: {...}` as a file glob, so the old
      // config never enforced anything (#22). Coverage is an L5/release check
      // (`pnpm test:coverage`), not part of dev-check or PR CI.
      thresholds: {
        branches: 80,
        functions: 80,
        lines: 80,
        statements: 80
      }
    }
    // No `typecheck` block: Vitest's type-test mode only checks `*.test-d.ts` files and
    // spawned tsc on every run for nothing (#22). `pnpm type-check` (tsconfig.check.json)
    // now type-checks the tests themselves, including the `expectTypeOf` type tests in
    // src/types.test.ts.
  }
});