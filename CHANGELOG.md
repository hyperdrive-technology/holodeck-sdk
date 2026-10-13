# Changelog

All notable changes to the Holodeck SDK will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Packaging contract v1 ([docs/PACKAGING.md](docs/PACKAGING.md)): `holodeck.package.v1` manifests
  (`validateHolodeckPackageManifest`, `packageRoles`, `checkExtensionMatchesManifest`, JSON Schema),
  `HolodeckEngine` descriptors, and `HolodeckHost` (engine registration with API compatibility,
  package install with `requires`, ownership and `uninstallOwnedBy`, document checks).
- `HolodeckDocument` envelope (`holodeck.document.v1`), signal bindings and value transforms
  (`scale`, `threshold`, `map`, `format`).
- Provider contract `HolodeckProvider` / `ProviderSession` (subscribe plus optional read, write, browse,
  history, discover, deploy), the `holodeck.sim` reference provider, and `runProviderConformance`.
- `ProviderHub`: connections and bindings → per-object live values, with reconnect on install and
  write-through.
- Kinds `holodeck.provider`, `holodeck.importer`, `holodeck.document.check`, `holodeck.flow.block`,
  `holodeck.flow.theme`; `DocumentCheck`, `HolodeckImporter`, `runDocumentChecks`, `findImporters`.
- Version ranges (`satisfiesRange`: `*`, exact, `^`, `~`, `>=`).

### Deprecated

- `Provider`, `ProviderConfig`, `MetricsQuery`, `MetricsResult`: use `HolodeckProvider` and bindings.

## [0.1.0] - 2026-09-22

First tagged Holodeck SDK release.

### Added

- Core TypeScript types: `SceneNode`, `SceneEdge`, `SceneFile`, `AnimationHook`, importers/providers
- Utilities: `createTransform`, `validateScene`, `calculateSceneStats`
- JSON Schema for scene file validation
- **Scene extension contracts**: `SceneComponentPack`, `SceneObjectRenderer`, `ScenePaletteItem`, `SceneLayoutConfig`, `SceneEditorAdapter`, `SceneViewerAdapter` (Tier 1 packs + Tier 2 editor/viewer adapters)
- TypeScript test suite and vitest coverage reporting
- Build configuration with tsup

### Changed

- Package name standardized as **`@holodeck/sdk`**
- Docs, schema `$id`, and GitHub URLs rebranded to Holodeck

### Removed

- Go bindings and golangci-lint configuration (TypeScript + schema are the supported surface)

### Infrastructure

- GitHub Actions publish/test workflows trimmed for the TypeScript-only package
- `ts/pnpm-workspace.yaml` for local workspace builds

[Unreleased]: https://github.com/hyperdrive-technology/holodeck-sdk/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/hyperdrive-technology/holodeck-sdk/releases/tag/v0.1.0
