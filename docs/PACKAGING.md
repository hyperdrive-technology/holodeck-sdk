# Holodeck packaging: engines, themes, libraries and providers

**Status:** v1 contract, 2026-10-14. Types and validators: `ts/src/{package,engine,document,provider,hub,host,checks,version}.ts`.
JSON Schemas: [`schema/holodeck-package.v1.schema.json`](../schema/holodeck-package.v1.schema.json),
[`schema/holodeck-document.v1.schema.json`](../schema/holodeck-document.v1.schema.json). Example manifests:
[`examples/packages/`](../examples/packages/).

This document says how a Holodeck product is assembled from parts, how those parts ship, and how a host
product (such as Hyperdrive) and its marketplace carry Holodeck parts without Holodeck knowing about them.

## 1. The four pieces

| Piece | What it is | Example | Ships as |
|---|---|---|---|
| **Engine** | A canvas technology with its own document body and its own contribution kinds | `holodeck.iso` (React Three Fiber, 2.5D isometric), `holodeck.flow` (xyflow graphs) | An engine package (`@holodeck/editor-2.5d-react`) that exports a `HolodeckEngine` descriptor and React components |
| **Theme** | Visual tokens for one engine | `arcentry-light`, `blueprint`, a host's style guide | `<engine>.theme` contributions in any package |
| **Library** (asset pack) | Things users place: parts, components, icons, blocks, plus their GLB/SVG assets | cloud archetypes, AWS components, logic blocks | `<engine>.part` / `<engine>.block` … contributions + `assets/` |
| **Provider** | Live data. A provider connects to a backend and streams values for opaque `source` strings. It may also browse, write, keep history, discover resources, or *run* a document | `aws.cloudwatch`, `holodeck.http`, `holodeck.flow.local` | `holodeck.provider` contributions |

Two supporting kinds are engine-agnostic as well. `holodeck.importer` turns a foreign file into a document.
`holodeck.document.check` lints a document.

A **product** is an engine plus the packages installed into it:

```
Arcentry-style cloud diagrams            Node-RED-style logic
──────────────────────────────           ──────────────────────────────
engine    holodeck.iso   (r3f 2.5D)       engine    holodeck.flow  (xyflow)
theme     arcentry-light (holodeck.cloud) theme     fbd-light      (holodeck.logic)
library   holodeck.cloud + holodeck.aws   library   holodeck.logic (AND/OR/… blocks)
provider  aws.cloudwatch (provider-aws)   provider  holodeck.flow.local (deploys + runs the flow)
```

Every piece is independent. One document can bind an iso component's colour to a flow block's output,
because both are just provider signals (§6).

## 2. Engines

An engine package exports a descriptor (pure data and functions; no React needed to register it):

```ts
export interface HolodeckEngine<Body = unknown> {
  id: string;                 // 'holodeck.iso'
  label: string;
  apiVersion: string;         // semver of the contribution API, matched by packages' `engines` ranges
  documentFormat: string;     // 'holodeck.iso.scene.v1' — format of HolodeckDocument.body
  kinds: ContributionKind[];  // every name is `<id>.<name>`
  collectBindings?(body: Body): BindingRef[];   // where bindings live in the body (§6.3)
  validateBody?(body: unknown): string[];
}
```

Rules:

- **Kind names are `<engine id>.<name>`.** That is how a manifest knows which engine a kind needs (`engineOfKind`).
  Ids (packages, providers, engines) are lowercase; segments after a kind's namespace may be camelCase
  (`holodeck.flow.nodeType`), checked by `isKindName`.
  Host kinds (`holodeck.provider`, `holodeck.importer`, `holodeck.document.check`) are the only exceptions.
- **`apiVersion` is the contract packages build against.** Adding an optional field to a contribution type
  is a minor bump. Removing or reinterpreting one is a major bump. A host refuses to register an engine
  that breaks an installed package (`ENGINE_INCOMPATIBLE`), and refuses packages that target an
  incompatible engine.
- An engine may ship built-in contributions (default theme, primitives) as an ordinary package with the
  same id as the engine.

Kinds by engine (✓ exists today, M2/M3 = planned milestone):

| Engine | Kind | Item | Status |
|---|---|---|---|
| `holodeck.iso` | `.part` | `IsoPartDefinition`: footprint, ports, params, component or `model`+`logo` (data-only) | ✓; data-only parts M2 |
| | `.theme` | `IsoTheme { style }` | ✓ |
| | `.animator` | `IsoAnimator { param, apply() }` | ✓ |
| | `.inspector` | inspector panel component | ✓ |
| `holodeck.flow` | `.block` | `FlowBlockDefinition`: ports, params, `evaluate` (§7) | M3 |
| | `.nodeType` / `.edgeType` | custom React node/edge renderers | ✓ |
| | `.palette` | palette entries | ✓ |
| | `.theme` | flow theme tokens | M3 |
| `holodeck.scene3d` | `.renderer` | `SceneObjectRenderer` | ✓ |

## 3. Packages

A package is a directory, normally an npm package:

```
holodeck.package.json   manifest — readable without running code
dist/index.js           entry module — default export defineHolodeckPackage({...})
assets/                 GLB, SVG, PNG referenced by contributions
```

### 3.1 Manifest (`holodeck.package.v1`)

```json
{
  "schemaVersion": "holodeck.package.v1",
  "id": "holodeck.aws",
  "name": "AWS architecture components",
  "version": "0.1.0",
  "license": "MIT",
  "contributes": ["holodeck.iso.part"],
  "engines": { "holodeck.iso": "^1.0" },
  "requires": { "holodeck.cloud": "^0.1" },
  "entry": "dist/index.js",
  "assets": "assets",
  "assetLicenses": [{ "path": "assets/aws-icons", "license": "LicenseRef-AWS-Architecture-Icons", "notice": "…" }]
}
```

| Field | Rule |
|---|---|
| `id` | Dotted, lowercase. Also the extension id in the registry, so it is globally unique. |
| `version` | `MAJOR.MINOR.PATCH`; must equal the extension's `version`. |
| `contributes` | Every kind the package contributes. Hosts and marketplaces index it, and kinds with no engine yet are `pending`. Installing an extension that contributes an undeclared kind fails. |
| `engines` | Required for every engine whose kinds appear in `contributes`. Ranges: `*`, `1.2.3`, `^1.2`, `~1.2`, `>=1.2.3` (deliberate subset, `version.ts`). |
| `engine` | Only on engine packages: `{ id, apiVersion, documentFormat }`. |
| `providers` | Ids of the package's `holodeck.provider` items. Must match the extension exactly. |
| `requires` | Other Holodeck packages that must be installed first (id → range). Forms a DAG. |
| `permissions.network` | Origins providers may contact (`https://monitoring.*.amazonaws.com`): `scheme://host[:port]`, no path. At most one wildcard label `*`, never one of the last two labels, so `https://*.com`, `https://example.*` and `https://a.*.*` are rejected. Each provider's `origins` must be covered. Hosts show these before install and may enforce them. |
| `assetLicenses` | Assets under a different licence than `license`, for example vendor icon sets and their trademark notices. Hosts show `notice` in credits. |
| `entry`, `assets` | Package-relative paths. No `..`, absolute paths or URLs. Also none of the things a URL parser would rewrite: `%` escapes, `\`, `?`, `#`, control characters, or surrounding whitespace. |

Unknown fields are errors (typos fail loudly). Marketplace facets (`engine`, `theme`, `library`, `provider`, `importer`,
`check`) are derived from the manifest with `packageRoles`, never declared, so they cannot drift.

### 3.2 Entry module

```ts
import { defineHolodeckPackage } from '@holodeck/sdk';
import manifest from '../holodeck.package.json';

export default defineHolodeckPackage({
  manifest,                                   // optional embedded copy; host checks id/version agree
  createExtension: ({ assetUrl }) => ({
    id: 'holodeck.aws',
    version: '0.1.0',
    contributions: {
      'holodeck.iso.part': [
        { id: 'aws.ec2', label: 'EC2', category: 'Compute', model: 'holodeck.cloud/server', logo: assetUrl('aws-icons/ec2.svg') },
      ],
    },
  }),
});
```

`assetUrl(path)` resolves against wherever the host put the package (npm bundle, CDN, marketplace cache)
and refuses paths that escape `assets/`. A bundled npm package may still use `new URL('./x.glb', import.meta.url)`.

### 3.3 Data-only and code packages

A package whose contributions are pure data (parts that name a `model` and `logo`, themes, block
definitions with built-in `evaluate` ids) can be indexed, previewed and installed without running
third-party code. Packages with React components or providers run code: hosts treat them as trusted
installs, and a marketplace should label them. Sandboxed execution of provider code is future work and
not part of v1.

## 4. Installing: `HolodeckHost`

```ts
const host = new HolodeckHost({ name: 'holodeck-studio' });      // registers the host kinds
host.registerEngine(isoEngine);                                   // engine kinds
await host.installPackage(manifestJson, entryModule, { manifestUrl });
host.uninstallPackage('holodeck.aws');
```

`installPackage(manifest, source, { owner, range })` steps. Any failure leaves the host and registry unchanged.

1. Validate the manifest → `INVALID_MANIFEST` (all problems listed).
2. If the id is already installed, **share it**. A compatible version (the installed version satisfies
   `range`, or equals `manifest.version` when no range is given) gains `owner` and returns
   `{ shared: true }`. Anything else → `VERSION_CONFLICT`, listing the installed version, its owners and
   the request. There are no silent upgrades and no side-by-side versions. The same owner installing
   twice, or a concurrent install of the same id → `DUPLICATE_PACKAGE`.
3. Check `requires` against installed versions → `MISSING_REQUIREMENT`.
4. Check `engines` against registered engines → `ENGINE_INCOMPATIBLE`. Engines not registered yet are
   reported in `unresolvedEngines`; their kinds wait as `pending` and replay when the engine registers.
5. `createExtension(ctx)` and compare the result with the manifest → `MANIFEST_MISMATCH`.
6. Re-run steps 3–4 (the factory may have awaited while packages or engines changed). Also refuse an id
   that an extension installed outside this host already uses in a shared registry → `DUPLICATE_PACKAGE`.
7. `registry.install(ext)`, which is atomic and validates every item against its kind. Ownership is
   recorded only for this install's own commit.

**Ownership.** Each installed package has a set of owners: `USER_OWNER` for direct installs, and the ids
of host-product extensions that embed it. A package stays installed while it has an owner **or** an
installed package requires it. Releasing an owner removes every package left with neither, dependents
first:

- `uninstallPackage(id)` releases the user's ownership. It throws `NOT_OWNER` if only extensions hold
  the package, and `REQUIRED_BY` if the release would orphan a package other installed packages require.
- `uninstallOwnedBy(owner)` releases a host extension's ownership of everything it embedded. It never
  blocks: packages still held by the user or other extensions, or still required, are reported in `kept`.

Both return `{ removed, kept }`. This is what makes embedding in host extensions work (§8).

**Mutations are transactions.** Every host mutation runs as one synchronous transaction under a single
lock: engine registration and teardown, the commit (or share) step of an install, `uninstallPackage`
and `uninstallOwnedBy`. Registry hooks and subscribers run inside that transaction, so a mutation
attempted from one of them throws `BUSY`. Read-only calls (`packages()`, `engine()`, registry lookups)
are fine. A callback that needs to change the host defers the change until the call returns, for
example with `queueMicrotask`. An install's async part (awaiting `createExtension`) holds no lock: its
checks run again inside the commit transaction. If `uninstallOwnedBy(owner)` runs while one of that
owner's installs is still awaiting, the install fails with `CANCELLED`.

Registry semantics (duplicate ids are errors, pending kinds, hooks after commit) are unchanged: see the
README's "Registry behaviour".

## 5. Documents

Every engine's documents share one envelope (`HolodeckDocument`, `holodeck.document.v1`):

```json
{
  "format": "holodeck.document.v1",
  "id": "prod-overview",
  "name": "Production overview",
  "engine": "holodeck.iso",
  "engineVersion": "1.0.0",
  "theme": "arcentry-light",
  "requires": { "holodeck.aws": "^0.1" },
  "connections": [{ "id": "prod", "provider": "aws.cloudwatch", "config": { "region": "eu-west-1" } }],
  "body": { "objects": [ … engine-owned … ] }
}
```

- The engine owns `body` and its schema (`documentFormat`). A host can open, list, check and connect a
  document without understanding the body.
- `requires` lets a host offer to install missing packages when a document is opened.
- `connections[].config` holds **non-secret** settings only. Secrets live in the host's secret store and reach
  providers through `ProviderContext.secret(key)`.
- `SceneFile` remains the body for `holodeck.scene3d` and the importer interchange format.

## 6. Providers and bindings

### 6.1 Provider contract

```ts
interface HolodeckProvider {             // contribution of kind holodeck.provider
  id: string;                            // 'aws.cloudwatch'
  label: string;
  capabilities: { read?, write?, browse?, history?, discover?, deploy? };   // subscribe is mandatory
  sourceSyntax?: string;                 // shown in binding editors
  configSchema?: JSONSchema;             // non-secret connection settings
  secrets?: { key, label, optional? }[]; // asked for by the host, never stored in documents
  origins?: string[];                    // ⊆ manifest permissions.network
  connect(config, ctx): Promise<ProviderSession>;
}
interface ProviderSession {
  status(); onStatus(cb);                                   // connecting | live | stale | disconnected | error
  subscribe(sources, onSamples): () => void;                // Sample { source, value, ts, quality? }
  read?(sources); write?(source, value); browse?(path);     // pickers and commands
  history?(source, { from, to, stepMs });                   // chart widgets
  discover?(): DiscoveredResource[];                        // "import my AWS account" (key, kind, partHint, bindings)
  deploy?(doc): DeployResult;                               // run a flow document on this provider
  close();
}
```

Values are JSON scalars (`number | string | boolean | null`). Structured data is split into several sources.
A provider owns its `source` syntax completely (`cloudwatch:eu-west-1/AWS/EC2/CPUUtilization?InstanceId=i-1&stat=Average`,
`alarm:eu-west-1/HighCPU`, a host product's own addresses). Engines and hosts never parse it.

### 6.2 Bindings

An engine object binds a parameter to a signal:

```json
"bindings": {
  "color": { "connection": "prod", "source": "alarm:eu-west-1/web-cpu",
             "transform": { "kind": "map", "cases": { "ALARM": "#e74c3c", "OK": "#2ecc71" }, "default": "#bdc3c7" } },
  "label": { "connection": "prod", "source": "cloudwatch:…CPUUtilization…",
             "transform": { "kind": "format", "template": "{value} %", "digits": 0 } }
}
```

Transforms cover the Arcentry live-document cases without code: `scale` (value → height or fill),
`threshold` (CPU → status colour), `map` (state → colour or label), `format` (number → label text).
Engines decide where `bindings` sit in their body and expose them through `collectBindings`.

### 6.3 `ProviderHub`

One hub per open document turns connections and bindings into the values the engine renders:

```ts
const hub = host.createProviderHub({ secret: (connectionId, key) => vault.get(connectionId, key) });
hub.setConnections(doc.connections);
hub.setBindings(engine.collectBindings(doc.body));
const snap = useSyncExternalStore(hub.subscribe, hub.getSnapshot);
<Canvas metrics={snap.metrics} />           // objectId → param → value
```

- Sessions open lazily, one subscription per connection covering every bound source, and are replaced when
  the bound set changes. A changed config reopens the session. A superseded `connect` is closed when it
  arrives.
- A connection whose provider is not installed shows `error`, and connects by itself once the package
  is installed. Uninstalling a provider closes its sessions.
- Snapshots are immutable and structurally shared, so unchanged objects keep their identity (cheap React
  re-renders).
- `hub.write(objectId, param, value)` writes through a binding. `scale` is inverted; other transforms
  refuse (`NOT_INVERTIBLE`).
- `snap.connections[id].status` drives the connection badge (live / stale / disconnected).

### 6.4 Test double, demo data, conformance

`createSimProvider()` (`holodeck.sim`) is the reference provider. Its waveforms (`sine:10`, `ramp:30:0:100`,
`noise:7`) are pure functions of time, so `history` is exact. `mem:<name>` is writable. Hosts may install it
as "demo data"; tests drive it with `createManualSchedule()`. Every provider package must pass
`runProviderConformance(makeProvider, { sources, config, flush }, assert)` against a fake backend in CI.
`flush` makes the fake backend deliver anything pending (tick fake timers). The kit calls it around the
quiet window after `unsubscribe`, so a leaked subscription is caught deterministically. Every kind
an engine registers must pass `runContributionKindConformance`.

### 6.5 Document checks (`holodeck.document.check`)

```ts
{ id, label, engines: ['holodeck.iso'] | ['*'], check(doc, { registry, engine }) → Diagnostic[] }
```

`host.checkDocument(doc)` runs the engine's `validateBody` and every applicable check. A check that throws
or returns malformed output becomes one `CHECK_FAILED` / `CHECK_INVALID_RESULT` error; the other checks
still run. Host products ship their style-guide rules this way (for example an HMI style lint), as an
ordinary package.

### 6.6 Importers (`holodeck.importer`)

```ts
{ id, label, engine, accepts: { extensions?: ['.tfstate'], mimeTypes?: [...] }, import(input, ctx) → { document, diagnostics } }
```

`findImporters(registry, fileName, mimeType)` picks candidates. Provider discovery (`discover()`) plus an
importer gives "draw my AWS account". The older `Importer → SceneFile` interface stays for 3D scenes.

## 7. The flow engine (`holodeck.flow`, M3)

The second engine is a Node-RED-style editor on xyflow with generic function-block logic. It is not an
IEC/ISA-specific language. Blocks are data plus an evaluator:

```ts
interface FlowBlockDefinition {                // kind holodeck.flow.block
  id: string;                                  // 'logic.and'
  label: string; category: string;             // 'Logic'
  inputs:  { name: string; type: 'bool' | 'number' | 'string' | 'any'; variadic?: boolean }[];
  outputs: { name: string; type: … }[];
  params?: Record<string, ParamSpec>;          // e.g. TON preset time
  evaluate(inputs, state, ctx): outputs;       // pure per scan; `state` persists per node (timers, latches, edges)
}
```

- **Evaluation is cyclic dataflow.** Each scan evaluates blocks in topological order. A feedback wire must go
  through an explicit delay block. This is FBD semantics, and it maps cleanly onto a PLC when a host
  provider deploys the same graph.
- **Signals in and out are blocks.** `signal.in` subscribes to any provider source and `signal.out` writes
  one. Iso documents can bind to `flow:<nodeId>.<port>` sources published by the flow runtime.
- **Deploy = provider.** `holodeck.flow.local` (in `holodeck.logic`) has `capabilities.deploy`. It runs the
  graph in the browser and publishes node outputs as sources. A host product may ship another deploy
  provider that compiles the same document for its own runtime. The editor's "Deploy" button calls
  `hub.session(connectionId).deploy(doc)`, whichever provider it is.
- Message-passing (Node-RED `msg` events) is a later extension: event-typed ports on the same block contract.

## 8. Host products and marketplaces (orthogonality)

Holodeck packages never reference a host product. A host product embeds them **by reference** in its own
extension format:

```
Host extension (e.g. a Hyperdrive extension on its marketplace)
├── host-specific content (its own manifest, logic libraries, plugins …)
└── holodeck: { packages: [ <reference>, … ] }
                    └── each resolves to an ordinary holodeck.package.json directory, installable anywhere
```

The reference grammar belongs to the host product, not to this SDK. Illustrative forms:
`"./holodeck"`, `{ "path": "vendor/pumps" }`, `{ "npm": "@acme/holodeck-pumps", "version": "^1.2.0" }`,
`{ "tarball": "pumps-1.2.3.tgz", "integrity": "sha512-…" }` (air-gapped / OT sites), each with an optional
`integrity` so a project lockfile can pin exact content. The host resolves a reference to a manifest plus
entry module, then calls `installPackage(manifest, module, { owner: <extension id>, range })`.

**Integrity and signatures are the host's job, before `installPackage`.** For example, a detached
`holodeck.package.json.sig` verified against the host's trust store. The manifest has no signature field,
and unknown manifest fields are rejected.

Rules:

1. **One-way dependency.** Host product code depends on `@holodeck/sdk` and Holodeck packages, never the
   reverse. Host-specific behaviour (bindings to a controller, style-guide lints, runtime data) is a
   Holodeck package *made by the host*, using only this public contract: providers, checks, themes, parts.
2. **Same unit everywhere.** A Holodeck package installs unchanged into Holodeck Studio, into a host
   product, or from npm. A marketplace lists both pure Holodeck packages and host extensions that embed
   them. `packageRoles` gives the facets.
3. **Ownership.** The host installs embedded packages with `owner = <host extension id>` and the
   reference's `range`, and removes them with `uninstallOwnedBy`. A package already installed (by the
   user or another extension) in a compatible version is shared, not duplicated. An incompatible one is
   a `VERSION_CONFLICT` the host surfaces to the user. Removing one extension never removes a package
   another owner or an installed requirer still needs (§4).
4. **Providers are the bridge.** A host product exposes its live data as a `holodeck.provider` (with its own
   `source` syntax and `deploy` if it can run flow documents). Documents bind to it like any other
   provider, so a scene can mix host signals with AWS metrics or flow outputs.

The host-side manifest section, install order and marketplace listing are specified by each host product.
For Hyperdrive see core's `docs/EXTENSIONS_AND_LIBRARIES.md`.

## 9. Errors

Hosts switch on `code`; messages are for people. Every error class lists all problems in `details`
where there can be several.

| Class | Codes |
|---|---|
| `HolodeckPackageError` (`HolodeckPackageErrorCode`) | `INVALID_MANIFEST`, `ASSET_ESCAPES_PACKAGE` |
| `HolodeckHostError` (`HolodeckHostErrorCode`) | `INVALID_MANIFEST`, `MANIFEST_MISMATCH`, `DUPLICATE_PACKAGE`, `MISSING_REQUIREMENT`, `ENGINE_INCOMPATIBLE`, `INVALID_ENGINE`, `DUPLICATE_ENGINE`, `UNKNOWN_PACKAGE`, `REQUIRED_BY`, `VERSION_CONFLICT`, `NOT_OWNER`, `BUSY`, `CANCELLED` |
| `ProviderHubError` (`ProviderHubErrorCode`) | `DISPOSED`, `UNBOUND`, `NOT_CONNECTED`, `NOT_WRITABLE`, `NOT_INVERTIBLE` |
| `ContributionRegistryError` | `DUPLICATE_KIND`, `DUPLICATE_ID`, `INVALID_ITEM`, `DUPLICATE_EXTENSION`, `UNKNOWN_EXTENSION` |

Malformed input to `ProviderHub.setConnections` / `setBindings` throws a `TypeError` listing every problem.

## 10. Conformance checklist

| Role | Must ship |
|---|---|
| Engine | `HolodeckEngine` descriptor passing `validateEngine`; `runContributionKindConformance` per kind; `collectBindings` + `validateBody` tests; a `holodeck.package.json` with `engine` |
| Library / theme | Manifest passing `validateHolodeckPackageManifest`; an install test with `HolodeckHost` + the target engine (all items pass the kind validator); asset files present for every referenced path |
| Provider | `runProviderConformance` against a fake backend; `permissions.network` covering `origins`; no secrets in `configSchema` |
| Importer / check | Kind validator passes; fixture-based tests |

## 11. Migration from the pre-v1 contracts

| Old | New |
|---|---|
| `SceneComponentPack` | Still accepted via `packToExtension`; new packs ship a manifest |
| `Provider` / `MetricsQuery` (node-centric) | `HolodeckProvider` (signal-centric); old types kept, deprecated |
| Iso `IsoSceneFile` | Becomes the `holodeck.iso.scene.v1` body inside the envelope; loaders accept both during M2 |
| Host bags such as `extensions['hyperdrive.bindings']` | Generic `bindings` on objects with a host provider connection; the host migrates its own bag |
