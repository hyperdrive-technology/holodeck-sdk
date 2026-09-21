# Changelog

All notable changes to the Holodeck SDK will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-09-22

First tagged Holodeck SDK release (formerly Starfleet SDK).

### Added

- Core TypeScript types: `SceneNode`, `SceneEdge`, `SceneFile`, `AnimationHook`, importers/providers
- Utilities: `createTransform`, `validateScene`, `calculateSceneStats`
- JSON Schema for scene file validation
- **Scene extension contracts**: `SceneComponentPack`, `SceneObjectRenderer`, `ScenePaletteItem`, `SceneLayoutConfig`, `SceneEditorAdapter`, `SceneViewerAdapter` (Tier 1 packs + Tier 2 editor/viewer adapters)
- TypeScript test suite and vitest coverage reporting
- Build configuration with tsup

### Changed

- Package renamed **`@starfleet/sdk` → `@holodeck/sdk`**
- Docs, schema `$id`, and GitHub URLs rebranded to Holodeck

### Removed

- Go bindings and golangci-lint configuration (TypeScript + schema are the supported surface)

### Infrastructure

- GitHub Actions publish/test workflows trimmed for the TypeScript-only package
- `ts/pnpm-workspace.yaml` for local workspace builds

[Unreleased]: https://github.com/hyperdrive-technology/starfleet-sdk/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/hyperdrive-technology/starfleet-sdk/releases/tag/v0.1.0
