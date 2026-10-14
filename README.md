# Holodeck SDK

Holodeck SDK provides the shared TypeScript scene types, JSON Schema, extension
contracts, and contribution registry for [Holodeck](https://github.com/hyperdrive-technology/holodeck).
Importers, live data providers, editors, and viewers use these contracts to
exchange scenes and install extensions without depending on one editor.

[![CI](https://github.com/hyperdrive-technology/holodeck-sdk/actions/workflows/test.yml/badge.svg)](https://github.com/hyperdrive-technology/holodeck-sdk/actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

## Project status

As of 2026-10-14, the current milestone is
[M1 — Brewery on WASM](https://github.com/hyperdrive-technology/holodeck-sdk/milestone/1).
The SDK has scene types and utilities, importer/provider and editor/viewer
contracts, a contribution registry, and a JSON Schema. CI checks types, runs
TypeScript tests, builds the package, and compiles the schema.

The brewery demo currently runs on a TypeScript interpreter in
[Hyperdrive core](https://github.com/hyperdrive-technology/core) (currently private).
M1 replaces that path with the real Rust runtime compiled to WASM in the browser
and consumes Holodeck as built packages. The SDK's immediate work is
[registry atomicity (#6)](https://github.com/hyperdrive-technology/holodeck-sdk/issues/6):
pending-kind replay and throwing lifecycle hooks must leave consistent state.
Package integration is also tracked in
[Holodeck #7](https://github.com/hyperdrive-technology/holodeck/issues/7) and
[core #34](https://github.com/hyperdrive-technology/core/issues/34).

Next is [M2 — Holodeck standalone scene builder](https://github.com/hyperdrive-technology/holodeck-sdk/milestone/2),
with shared scene and extension contracts for a standalone editor.
See [open issues](https://github.com/hyperdrive-technology/holodeck-sdk/issues)
and [good first issues](https://github.com/hyperdrive-technology/holodeck-sdk/issues?q=is%3Aissue%20is%3Aopen%20label%3A%22good%20first%20issue%22).

## Quick start

Use **Node 26** ([`.node-version`](.node-version)) and **pnpm 10.33.2** to match
CI. pnpm 10.26 or newer is required for the workspace's `allowBuilds` setting.

```bash
git clone https://github.com/hyperdrive-technology/holodeck-sdk.git
cd holodeck-sdk/ts
pnpm install --frozen-lockfile
pnpm type-check
pnpm exec vitest run
pnpm build
```

The package builds to `ts/dist/` with CommonJS, ES module, and declaration
outputs. There is no package at the repository root and no sibling checkout
is needed for SDK development. The related Holodeck checkout currently uses
sibling `file:` dependencies; see its
[setup guide](https://github.com/hyperdrive-technology/holodeck/blob/main/CONTRIBUTING.md).

See [CONTRIBUTING.md](CONTRIBUTING.md) for focused tests, the JSON Schema check,
and how local commands map to CI.

## Repository map

| Path | Purpose |
| --- | --- |
| [`ts/src/index.ts`](ts/src/index.ts) | Scene types, importer/provider contracts, extension adapters, and utilities; package entry point |
| [`ts/src/registry.ts`](ts/src/registry.ts) | `ContributionRegistry`, extension routing, and known contribution kinds |
| [`ts/src/index.test.ts`](ts/src/index.test.ts), [`ts/src/registry.test.ts`](ts/src/registry.test.ts) | Colocated unit tests |
| [`ts/package.json`](ts/package.json), [`ts/pnpm-lock.yaml`](ts/pnpm-lock.yaml) | Package scripts, dependencies, and lockfile |
| [`schema/scenefile.schema.json`](schema/scenefile.schema.json) | JSON Schema for the scene interchange format |
| [`examples/README.md`](examples/README.md) | Pointers to SDK usage examples |
| [`.github/workflows/test.yml`](.github/workflows/test.yml) | Pull request and `main` checks |
| [`.github/workflows/publish.yml`](.github/workflows/publish.yml) | Tag-triggered package release workflow |
| [`CHANGELOG.md`](CHANGELOG.md) | Release history |

## Core concepts

- **SceneFile** is the container for metadata, scene graph, assets, and extensions.
- **SceneNode** and **SceneEdge** describe elements and connections; transforms,
  geometry, and materials describe their appearance.
- **Importer** converts external data into a `SceneFile`.
- **Provider** supplies live metrics and manages connection lifecycle.
- **AnimationHook** defines optional frame, node, edge, and lifecycle callbacks.
- **SceneComponentPack** supplies palette entries, node/edge components, and 3D renderers.
- **SceneEditorAdapter** and **SceneViewerAdapter** connect another editor or viewer
  to the same `SceneFile` interchange format.
- **ContributionRegistry** routes extension contributions to registered kinds
  and keeps contributions for unregistered kinds pending.

The SDK is domain-neutral. Hosts supply PLC bindings and runtime behavior.
See the [extension architecture](https://github.com/hyperdrive-technology/core/blob/main/docs/EXTENSIONS_AND_LIBRARIES.md)
in core (currently private) for the host integration design.

## Usage

Once `@holodeck/sdk` is available to your application, create and check a scene:

```typescript
import {
  createMaterial,
  createTransform,
  generateId,
  validateScene,
  type SceneFile,
} from '@holodeck/sdk';

const scene: SceneFile = {
  version: '0.1.0',
  metadata: { name: 'My infrastructure' },
  scene: {
    nodes: [{
      id: generateId(),
      type: 'server',
      name: 'Web server',
      transform: createTransform({ x: 0, y: 0, z: 0 }),
      material: createMaterial({ color: { r: 0.2, g: 0.8, b: 0.2, a: 1 } }),
      status: 'healthy',
      metadata: { cpu: '85%', memory: '12GB' },
    }],
    edges: [],
  },
};

const validation = validateScene(scene);
if (!validation.valid) {
  console.error(validation.errors);
}
```

`validateScene` performs basic structural and reference checks; it does not
run the JSON Schema. Use [`scenefile.schema.json`](schema/scenefile.schema.json)
with a JSON Schema validator when you need schema validation.

### Extensions

An editor registers the kinds it accepts. An extension contributes items keyed
by kind; each item's ID is unique within that kind.

```typescript
import { ContributionRegistry, HOLODECK_KINDS, packToExtension } from '@holodeck/sdk';

const registry = new ContributionRegistry();
registry.registerKind({ kind: HOLODECK_KINDS.flowPalette });
registry.install(packToExtension({
  id: 'example.infrastructure',
  version: '0.1.0',
  paletteItems: [{ id: 'example:server', nodeType: 'server', label: 'Server' }],
}));

console.log(registry.list(HOLODECK_KINDS.flowPalette));
```

### Registry behaviour

`ContributionRegistry` routes an extension's contributions to registered kinds and
keeps contributions for unregistered kinds pending. Installation validates each
item's string `id` and reserves it within its kind, including pending kinds.
Duplicates within an extension or across installed extensions fail immediately.
Unregistering a kind retains its reservations; uninstalling an extension releases them.

Kind-specific validation runs at installation for registered kinds and during
late registration for pending kinds. Installation and registration validate all
contributions before publishing any state or calling lifecycle hooks. A validation
failure leaves the registry unchanged. After a failed late registration, remove
or correct the invalid extension and retry `registerKind()`.

Lifecycle hooks run after the entire operation commits, followed by subscribers.
Subscribers to `kind-registered` can read all replayed items and their owners.
If a hook or subscriber throws, the remaining callbacks still run and the method
throws an `AggregateError` containing all callback failures in execution order.
The operation remains committed: an install is fully installed, an uninstall is
fully removed, and a kind registration remains registered even if replay hooks
fail. Inspect the registry after a callback error; retrying the same install or
registration will report a duplicate. When `registerKind()` hits callback
errors it throws a `KindRegistrationError` (a subclass of `AggregateError`) whose
`unregister` property is the function a successful call would have returned.
A `registerKind()` call for a kind whose replay validation is still running
(for example from inside a `validate` callback) fails with `DUPLICATE_KIND`. Runtimes must support `AggregateError`.

The contracts and their comments in [`ts/src/`](ts/src/) are the API reference.

## Scene file format

A scene is a JSON document. This minimal example uses the current format:

```json
{
  "version": "0.1.0",
  "metadata": { "name": "Production infrastructure" },
  "scene": {
    "nodes": [{
      "id": "web-server-1",
      "type": "server",
      "name": "Web server",
      "transform": {
        "position": { "x": 0, "y": 0, "z": 0 },
        "rotation": { "x": 0, "y": 0, "z": 0 },
        "scale": { "x": 1, "y": 1, "z": 1 }
      },
      "geometry": { "type": "box", "parameters": { "width": 2, "height": 1, "depth": 1 } },
      "material": { "color": { "r": 0.2, "g": 0.8, "b": 0.2, "a": 1 } },
      "status": "healthy"
    }],
    "edges": []
  }
}
```

## Versioning

The package currently declares version 0.1.0 and follows semantic versioning.
Coordinate breaking contract changes with consumers and record them in the
[changelog](CHANGELOG.md).

## Contributing and support

Read [CONTRIBUTING.md](CONTRIBUTING.md) for setup and checks, and the
[organization guide](https://github.com/hyperdrive-technology/.github/blob/main/CONTRIBUTING.md)
for the shared contribution and review process.
Use [issues](https://github.com/hyperdrive-technology/holodeck-sdk/issues) for bugs
and [Discussions](https://github.com/hyperdrive-technology/holodeck-sdk/discussions)
for questions. Licensed under [MIT](LICENSE).
