# Contributing to Holodeck SDK

The SDK defines the shared scene format, extension contracts, and contribution
registry used by [Holodeck](https://github.com/hyperdrive-technology/holodeck).
Changes here can affect every editor and host that consumes `@holodeck/sdk`.

Follow the [organization contribution guide](https://github.com/hyperdrive-technology/.github/blob/main/CONTRIBUTING.md)
for issue labels, pull requests, and review policy. Humans and coding agents use
the same process. The maintainer is [@DezLitz](https://github.com/DezLitz).

## Local setup

Use Node 26, as pinned in [`.node-version`](.node-version), and pnpm 10.33.2,
the version used in CI. pnpm must be at least 10.26 to read the `allowBuilds`
setting in [`ts/pnpm-workspace.yaml`](ts/pnpm-workspace.yaml).

From your checkout root:

```bash
cd ts
pnpm install --frozen-lockfile
pnpm type-check
pnpm exec vitest run
pnpm build
```

The package and lockfile live in `ts/`; there is no root package. Build output
is generated in `ts/dist/` as CommonJS, ES modules, and type declarations.
No sibling checkout is needed to work on the SDK.

## Tests and checks

Run package commands from `ts/`:

| Area | Source and tests | Local check |
| --- | --- | --- |
| Scene types, utilities, importer/provider contracts | [`src/index.ts`](ts/src/index.ts), [`src/index.test.ts`](ts/src/index.test.ts) | `pnpm exec vitest run src/index.test.ts` |
| Contribution registry and extension routing | [`src/registry.ts`](ts/src/registry.ts), [`src/registry.test.ts`](ts/src/registry.test.ts) | `pnpm exec vitest run src/registry.test.ts` |
| All package tests | `src/*.test.ts` | `pnpm exec vitest run` |
| TypeScript types | [`tsconfig.json`](ts/tsconfig.json) | `pnpm type-check` |
| Package output and declarations | [`package.json`](ts/package.json) | `pnpm build` |

`pnpm test` starts Vitest in watch mode for local development. `pnpm dev`
rebuilds the package when source files change.

Run the schema check from the **repository root**, matching CI:

```bash
npx -y -p ajv-cli@5 -p ajv-formats@3 ajv compile -c ajv-formats -s schema/scenefile.schema.json
```

This checks that the schema compiles; it does not validate example scene data.
For schema changes, include a representative scene and demonstrate that it
validates or is rejected as intended.

[`test.yml`](.github/workflows/test.yml) runs on pull requests to `main` and
pushes to `main`. Its TypeScript job installs with the frozen lockfile, checks
types, runs the full test suite once, and builds. Its other job compiles the
JSON Schema with the command above. Type checking excludes test files; Vitest
executes them.

The package has lint scripts, but there is no ESLint configuration yet, so
linting is not a working local check or a CI gate. The coverage script also
needs `@vitest/coverage-v8`, which is not currently declared; coverage is not
run in CI. Use the checks above when reporting validation.

[`publish.yml`](.github/workflows/publish.yml) runs on `v*` tags and contains
the npm release job. Releases are maintained separately from contribution PRs.

## Making changes

- Add regression tests beside the affected source for bug fixes and new behavior.
- Keep TypeScript scene contracts and [`scenefile.schema.json`](schema/scenefile.schema.json)
  aligned when changing the interchange format.
- Keep contributions domain-neutral. Editors register kinds; extensions supply
  items. PLC compilation, IEC addressing, and deployment belong in the host.
- Check compatibility with Holodeck consumers when changing exports or types.
  The SDK currently targets version 0.1.0; explain breaking changes in the PR
  and update the [changelog](CHANGELOG.md).

Current work is tracked in [GitHub issues](https://github.com/hyperdrive-technology/holodeck-sdk/issues),
including [registry atomicity (#6)](https://github.com/hyperdrive-technology/holodeck-sdk/issues/6).
Start with a [good first issue](https://github.com/hyperdrive-technology/holodeck-sdk/issues?q=is%3Aissue%20is%3Aopen%20label%3A%22good%20first%20issue%22)
or describe the proposed change in an issue.

## Pull requests

Create a feature branch and open a PR to `main`. Use a short imperative or
conventional-commit title, include `Closes #N` for the issue it resolves, and
describe the change and commands you ran. Include tests, relevant docs, and
before/after screenshots when a change affects a UI consumer.

M1 work must keep the brewery demo on the real Rust runtime compiled to WASM
and consume Holodeck as built packages, without a TS interpreter or mock path.

Merge requires green CI and both review statuses on the PR's current head:
`claude-review` and `gpt-review/sol-6.1`. Maintainers squash-merge approved PRs;
merged branches are deleted automatically.
