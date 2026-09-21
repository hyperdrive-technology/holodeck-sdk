# Changelog

All notable changes to the Holodeck SDK will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Comprehensive test suite for TypeScript package
- Go module tests with JSON marshaling validation
- GitHub Actions CI/CD pipeline for automated publishing
- golangci-lint configuration for Go code quality
- vitest configuration with coverage reporting

### Changed
- Enhanced TypeScript test coverage with integration tests
- Improved validation functions with better error messages

### Fixed
- Type definitions alignment between TypeScript and Go packages

## [0.1.0] - 2024-01-XX

### Added
- Core TypeScript interfaces and types (SceneNode, SceneEdge, SceneFile)
- Plugin interfaces (Importer, Provider, AnimationHook)
- Utility functions (createTransform, validateScene, calculateSceneStats)
- Go bindings and structs with JSON schema validation
- JSON Schema for scene file validation
- Basic examples and documentation
- Build configuration with tsup
- Initial project structure and README

### Infrastructure
- TypeScript package setup with proper exports
- Go module configuration
- Build and development scripts
- ESLint and TypeScript configuration

---

## Release Notes Guidelines

### Version Types
- **Major (x.0.0)**: Breaking changes that require migration
- **Minor (0.x.0)**: New features that are backward compatible
- **Patch (0.0.x)**: Bug fixes and small improvements

### Change Categories
- **Added**: New features or capabilities
- **Changed**: Changes in existing functionality
- **Deprecated**: Soon-to-be removed features
- **Removed**: Features removed in this release
- **Fixed**: Bug fixes
- **Security**: Security vulnerability fixes
- **Infrastructure**: Changes to build, CI/CD, or development tools

### Breaking Changes
Breaking changes should be clearly documented with:
- What changed
- Why it changed
- Migration guide for users
- Timeline for deprecation (if applicable)