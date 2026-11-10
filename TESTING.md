# Testing holodeck-sdk

One entry point, the same ladder as every Hyperdrive repo
(`~/dev/hyperdrive/AGENTS.md` § *Dev loop & shift-left*):

```bash
scripts/install-hooks.sh                 # once per clone: pre-push runs `dev-check.sh fast`
scripts/dev-check.sh                     # fast (L1): what the diff vs origin/main touches
scripts/dev-check.sh push                # L2: before opening a PR / asking for review
scripts/dev-check.sh full                # L3: everything PR CI runs; before merging a minor PR
scripts/dev-check.sh full --list         # print the steps and why each was selected; run nothing
scripts/dev-check.sh fast --base <ref>   # diff against another base
HYPERDRIVE_SKIP_HOOKS=1 git push         # WIP / lockout checkpoint: skip the hook once
```

The diff is HEAD + staged + unstaged + untracked files against the merge-base with
`origin/main`. The last line is always
`dev-check: <mode> PASS|FAIL in <N>s — <step>=<passed or ok>; …`, and each run writes
`.dev-check/last.json` (gitignored), which `~/dev/hyperdrive/scripts/ci-local-status.sh`
posts as `ci/local`. Installs run only when `ts/node_modules` is missing or older than
`ts/pnpm-lock.yaml`.

## Ladder

| Tier | When | Runs here | Budget | Measured (warm, M1 Pro) |
|---|---|---|---|---|
| L0 edit | every save | `cd ts && pnpm test` (Vitest watch) or `pnpm exec vitest run src/<file>.test.ts` | seconds | < 1 s per file |
| L1 `fast` | every push (hook) | steps selected by the diff (table below) | ≤ 60 s | 3–4 s |
| L2 `push` | before a PR / review | typecheck, test, schema, dev-check self-tests | ≤ 5 min | ~4.5 s |
| L3 `full` | before merging a minor PR | L2 + build + dist smoke test (= every `test.yml` command) | — | ~6 s |
| L4 heavy CI | once, on the final reviewed head of a major PR | `test.yml` on boat | — | — |
| L5 release | `v*` tag | `publish.yml` (tests, schema, build, npm publish); coverage `cd ts && pnpm test:coverage` | — | — |

## What a change selects (`fast`)

| Changed path | Steps |
|---|---|
| `ts/src/**` | typecheck, test |
| `schema/**`, `examples/**` | schema, test (`package.test.ts` validates the schema and every example) |
| `docs/**` | test (`docs.test.ts` pins `docs/PACKAGING.md` §7) |
| `ts/scripts/smoke-dist.mjs` | build, smoke-dist |
| `scripts/**`, `.githooks/**` | dev-check self-tests |
| top-level `*.md`, `LICENSE`, `.gitignore`, CODEOWNERS/dependabot/actionlint config | nothing |
| `.github/workflows/**`, `.node-version`, `ts/package.json`, lockfile, `ts/tsconfig*.json`, `ts/vitest.config.ts` | **full** |
| anything else | **push** (fail closed) |

`vitest related` is not used: every source module is reached through `src/index.ts`, so
`related` selects the whole suite anyway (measured: 344 of 344 tests for `version.ts`).

## Steps (`full` = `test.yml`, pinned)

| Step | Command (directory) | CI job |
|---|---|---|
| typecheck | `pnpm type-check` (ts) — `tsc -p tsconfig.check.json`: sources **and tests** | Test TypeScript |
| test | `pnpm exec vitest run` (ts) | Test TypeScript |
| dev-check-selftest | `node --test "scripts/*.test.mjs"` (root) | Test TypeScript |
| build | `pnpm build` (ts) | Test TypeScript |
| smoke-dist | `pnpm run smoke:dist` (ts) — import + require(esm) of the built package by name | Test TypeScript |
| schema | `pnpm run validate:schema` (ts) — ajv-cli compile ×3 schemas + validate examples | Validate JSON Schema |

`scripts/dev-check.test.mjs` fails if a `run:` command in `test.yml` is not a `full` step
(same directory, same command) or the other way round, and pins the `types: [labeled]`
trigger. Change both together.

## Timings

Warm runs on the M1 Pro (10 cores) while other agent sessions shared the machine (load
average 25–60), so ±30 %. Before = `main` at 02d726c, after = this branch.

| Check | Before | After | Change |
|---|---|---|---|
| `pnpm type-check` | 0.8 s (sources only) | 1.2 s (sources + tests) | now also checks the 11 test files |
| `pnpm exec vitest run` | 1.9 s (+ empty tsc typecheck pass) | 1.7 s | dropped Vitest's no-op type-test mode |
| schema (3 × `npx -y ajv-cli`) | 9.6 s (network) | 0.7 s (pinned devDependency, offline) | −93 % |
| `pnpm build` | 1.2 s | 1.3 s | — |
| smoke-dist | 0.1 s | 0.1 s | — |
| dev-check self-tests | — | 0.6 s | new |
| **all CI checks, serial** | **13.6 s** | **~6 s** (`dev-check full`) | −55 % |

Slowest tests (all files run in parallel, wall time of the suite 1.4 s):

| Test | Time | Why |
|---|---|---|
| `provider.test.ts` › async flush does not shorten the quiet window | 305 ms | real timers on purpose: it pins the real-time quiet window (sdk#34) |
| `provider.test.ts` (file) | ~1.0 s | several conformance runs with real 20–100 ms quiet windows |
| `document.test.ts` (file) | ~90 ms | — |
| every other file | < 35 ms | — |

No test is over the 1 s budget. The provider conformance tests that wait on real time are
the subject under test (the kit's default real-time quiet window); the deterministic
variants already use `flush` / `wait` (#25, #33).

## Notes

- Coverage (`pnpm test:coverage`, `@vitest/coverage-v8`) is an L5 check with 80 %
  thresholds on `src/**`; on 2026-11-11 it reported 99.7 % lines / 96.6 % branches.
- There is no ESLint config yet, so `pnpm lint` is not a check (see `test.yml`).
- Shift-left rules for this repo: a failure first seen in CI that a lower tier could have
  caught gets a `dev-check` rule or a test in the same PR, and the PR body says so.
