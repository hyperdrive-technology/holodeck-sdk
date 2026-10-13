/**
 * HolodeckHost: the one object an app creates to run Holodeck
 * (contract: docs/PACKAGING.md §4 and §8).
 *
 *   const host = new HolodeckHost({ name: 'holodeck-studio' });
 *   host.registerEngine(isoEngine);                    // engine kinds
 *   await host.installPackage(manifest, awsAssets);    // libraries, themes, providers …
 *   const hub = host.createProviderHub();              // live values for a document
 *
 * It wraps one `ContributionRegistry` (engines, packages and host products
 * share it) and adds what a bare registry cannot know: package manifests,
 * `requires` between packages, engine API compatibility, and ownership.
 *
 * Ownership: a package has a set of owners: the user (`USER_OWNER`) and/or
 * host-product extensions that embed it. Installing a package that is already
 * installed with a compatible version adds an owner instead of installing it
 * again (`VERSION_CONFLICT` otherwise). A package stays installed while it
 * has an owner or an installed package requires it; releasing the last owner
 * removes it and then any package left with neither (dependents first).
 */

import { runDocumentChecks, DOCUMENT_CHECK_KIND, IMPORTER_KIND, type CheckDiagnostic } from './checks.js';
import type { HolodeckDocument } from './document.js';
import { validateEngine, type HolodeckEngine } from './engine.js';
import { ProviderHub, type ProviderHubOptions } from './hub.js';
import {
  checkExtensionMatchesManifest,
  parseHolodeckPackageManifest,
  resolvePackageAsset,
  type HolodeckPackageManifest,
  type HolodeckPackageModule,
} from './package.js';
import { PROVIDER_KIND } from './provider.js';
import {
  ContributionRegistry,
  type Contribution,
  type ContributionKind,
  type HolodeckExtension,
  type InstallResult,
} from './registry.js';
import { isValidRange, satisfiesRange } from './version.js';

export type HolodeckHostErrorCode =
  | 'INVALID_MANIFEST'
  | 'MANIFEST_MISMATCH'
  | 'DUPLICATE_PACKAGE'
  | 'MISSING_REQUIREMENT'
  | 'ENGINE_INCOMPATIBLE'
  | 'INVALID_ENGINE'
  | 'DUPLICATE_ENGINE'
  | 'UNKNOWN_PACKAGE'
  | 'REQUIRED_BY'
  | 'VERSION_CONFLICT'
  | 'NOT_OWNER';

export class HolodeckHostError extends Error {
  constructor(
    message: string,
    public readonly code: HolodeckHostErrorCode,
    public readonly details: readonly string[] = [],
  ) {
    super(details.length ? `${message}:\n- ${details.join('\n- ')}` : message);
    this.name = 'HolodeckHostError';
  }
}

/**
 * Owner id for packages the user installed directly. Not a valid dotted id, so
 * it can never collide with a host-product extension id.
 */
export const USER_OWNER = '#user';

export interface InstalledPackage {
  manifest: HolodeckPackageManifest;
  /** `USER_OWNER` and/or host-product extension ids, in the order they claimed it. Never empty
   * unless an installed package requires it (it is then kept alive by that requirement). */
  owners: readonly string[];
}

export interface PackageInstallOptions {
  /** Who is installing: a host-product extension id, or `USER_OWNER` (default). */
  owner?: string;
  /**
   * The range the owner asked for (e.g. an extension's embedded reference `^2.0`). When the
   * package is already installed, the installed version must satisfy it; otherwise it must equal
   * `manifest.version`. A new install checks `manifest.version` against it.
   */
  range?: string;
  /** Base URL of the package's `assets` directory. Default: `assets` resolved against `manifestUrl`. */
  assetBase?: string;
  /** URL of the manifest file, used to resolve the default `assetBase`. */
  manifestUrl?: string;
}

export interface PackageInstallReport {
  packageId: string;
  /** `true` when the package was already installed and the owner was added to it. */
  shared: boolean;
  /** Registry result of a fresh install; absent when `shared`. */
  install?: InstallResult;
  /** Engines named in `engines` that are not registered yet; their kinds wait as `pending`. */
  unresolvedEngines: string[];
}

export interface PackageRemovalReport {
  /** Packages removed from the registry, dependents first. */
  removed: string[];
  /** Packages the owner released that stay installed (other owners or requirers remain). */
  kept: string[];
}

export interface HolodeckHostOptions {
  /** Host name passed to packages for diagnostics, e.g. `holodeck-studio`. */
  name: string;
  /** Share an existing registry (e.g. a host product's). Default: a new one. */
  registry?: ContributionRegistry;
}

export class HolodeckHost {
  readonly registry: ContributionRegistry;
  readonly name: string;
  private readonly engineTable = new Map<string, HolodeckEngine>();
  private readonly installed = new Map<string, InstalledPackage>();
  private readonly installing = new Set<string>();

  constructor(options: HolodeckHostOptions) {
    this.name = options.name;
    this.registry = options.registry ?? new ContributionRegistry();
    // Host kinds: shared by every engine. Adopt them if a previous host on the
    // same registry already registered them.
    const adopt = <T extends Contribution>(kind: ContributionKind<T>) => {
      if (!this.registry.hasKind(kind.kind)) this.registry.registerKind(kind);
    };
    adopt(PROVIDER_KIND);
    adopt(IMPORTER_KIND);
    adopt(DOCUMENT_CHECK_KIND);
  }

  // ---------------------------------------------------------------------------
  // Engines
  // ---------------------------------------------------------------------------

  /**
   * Register an engine and its kinds. Kinds already registered on the shared
   * registry (by code that predates engines) are adopted, not re-registered,
   * and stay registered when the returned function unregisters the engine.
   * Throws `ENGINE_INCOMPATIBLE` if an installed package targets this engine
   * with a range its `apiVersion` does not satisfy.
   */
  registerEngine(engine: HolodeckEngine): () => void {
    const errors = validateEngine(engine);
    if (errors.length) throw new HolodeckHostError(`invalid engine`, 'INVALID_ENGINE', errors);
    if (this.engineTable.has(engine.id)) {
      throw new HolodeckHostError(`engine "${engine.id}" is already registered`, 'DUPLICATE_ENGINE');
    }
    const incompatible = [...this.installed.values()]
      .filter(({ manifest }) => {
        const range = manifest.engines?.[engine.id];
        return range !== undefined && !satisfiesRange(engine.apiVersion, range);
      })
      .map(({ manifest }) => `${manifest.id} needs ${engine.id} ${manifest.engines?.[engine.id]}`);
    if (incompatible.length) {
      throw new HolodeckHostError(
        `engine "${engine.id}" ${engine.apiVersion} is incompatible with installed packages`,
        'ENGINE_INCOMPATIBLE',
        incompatible,
      );
    }
    const offs: Array<() => void> = [];
    try {
      for (const kind of engine.kinds) {
        if (!this.registry.hasKind(kind.kind)) offs.push(this.registry.registerKind(kind));
      }
    } catch (error) {
      // A pending item failed its kind's validation: undo this engine's kinds.
      offs.forEach((off) => off());
      throw error;
    }
    this.engineTable.set(engine.id, engine);
    return () => {
      if (this.engineTable.get(engine.id) !== engine) return;
      this.engineTable.delete(engine.id);
      offs.forEach((off) => off());
    };
  }

  engine(id: string): HolodeckEngine | undefined {
    return this.engineTable.get(id);
  }

  engines(): HolodeckEngine[] {
    return [...this.engineTable.values()];
  }

  // ---------------------------------------------------------------------------
  // Packages
  // ---------------------------------------------------------------------------

  /**
   * Install a package for `options.owner` (default `USER_OWNER`): validate the
   * manifest, share an already-installed compatible version, or check
   * `requires` and engine ranges, create the extension from the entry module,
   * check it matches the manifest, and install it into the registry. Nothing
   * is recorded unless the registry install commits.
   */
  async installPackage(
    rawManifest: unknown,
    source: HolodeckPackageModule | HolodeckExtension,
    options: PackageInstallOptions = {},
  ): Promise<PackageInstallReport> {
    let manifest: HolodeckPackageManifest;
    try {
      manifest = parseHolodeckPackageManifest(rawManifest);
    } catch (error) {
      const details = (error as { details?: string[] }).details ?? [String(error)];
      throw new HolodeckHostError('invalid package manifest', 'INVALID_MANIFEST', details);
    }
    const id = manifest.id;
    const owner = options.owner ?? USER_OWNER;
    if (options.range !== undefined && !isValidRange(options.range)) {
      throw new HolodeckHostError(`unsupported version range "${options.range}"`, 'INVALID_MANIFEST');
    }
    if (this.installing.has(id)) {
      throw new HolodeckHostError(`package "${id}" is being installed`, 'DUPLICATE_PACKAGE');
    }
    const existing = this.installed.get(id);
    if (existing) return this.share(existing, manifest, owner, options.range);
    if (options.range !== undefined && !satisfiesRange(manifest.version, options.range)) {
      throw new HolodeckHostError(`package "${id}" does not satisfy the requested range`, 'VERSION_CONFLICT', [
        `${owner} needs ${id} ${options.range}, offered ${manifest.version}`,
      ]);
    }

    this.installing.add(id);
    try {
      const missing = Object.entries(manifest.requires ?? {}).flatMap(([dep, range]) => {
        const have = this.installed.get(dep)?.manifest.version;
        if (have === undefined) return [`${dep} ${range} is not installed`];
        return satisfiesRange(have, range) ? [] : [`${dep} ${range} is required, ${have} is installed`];
      });
      if (missing.length) {
        throw new HolodeckHostError(`package "${id}" has unmet requirements`, 'MISSING_REQUIREMENT', missing);
      }

      const unresolvedEngines: string[] = [];
      const incompatible: string[] = [];
      for (const [engineId, range] of Object.entries(manifest.engines ?? {})) {
        const engine = this.engineTable.get(engineId);
        if (!engine) unresolvedEngines.push(engineId);
        else if (!satisfiesRange(engine.apiVersion, range)) {
          incompatible.push(`${engineId} ${range} is required, ${engine.apiVersion} is registered`);
        }
      }
      if (incompatible.length) {
        throw new HolodeckHostError(`package "${id}" targets an incompatible engine`, 'ENGINE_INCOMPATIBLE', incompatible);
      }

      const ext = isExtension(source) ? source : await source.createExtension(this.packageContext(manifest, options));
      const mismatch = checkExtensionMatchesManifest(manifest, ext);
      if (!isExtension(source) && source.manifest) {
        if (source.manifest.id !== manifest.id || source.manifest.version !== manifest.version) {
          mismatch.push('the entry module embeds a manifest for a different id or version');
        }
      }
      if (mismatch.length) {
        throw new HolodeckHostError(`package "${id}" does not match its manifest`, 'MANIFEST_MISMATCH', mismatch);
      }

      const record: InstalledPackage = { manifest, owners: [owner] };
      let install: InstallResult;
      try {
        install = this.registry.install(ext);
      } catch (error) {
        // AggregateError = install committed but a hook threw: keep the books straight.
        if (this.registry.installedExtensions().some((e) => e.id === id)) this.installed.set(id, record);
        throw error;
      }
      this.installed.set(id, record);
      return { packageId: id, shared: false, install, unresolvedEngines };
    } finally {
      this.installing.delete(id);
    }
  }

  /**
   * The user's uninstall: release `USER_OWNER` from a package, then remove
   * everything left without an owner or requirer. Throws `NOT_OWNER` if the
   * user did not install it (remove the owning extension instead) and
   * `REQUIRED_BY` if it would lose its last owner while installed packages
   * still require it. Packages other owners hold are kept (`kept`).
   */
  uninstallPackage(id: string): PackageRemovalReport {
    const pkg = this.installed.get(id);
    if (!pkg) throw new HolodeckHostError(`package "${id}" is not installed`, 'UNKNOWN_PACKAGE');
    if (!pkg.owners.includes(USER_OWNER)) {
      throw new HolodeckHostError(`package "${id}" was not installed by the user`, 'NOT_OWNER', [
        `owned by ${pkg.owners.join(', ') || 'nobody (kept alive by requirements)'}`,
      ]);
    }
    const remaining = pkg.owners.filter((o) => o !== USER_OWNER);
    if (!remaining.length) {
      const requirers = this.requirersOf(id);
      if (requirers.length) {
        throw new HolodeckHostError(`package "${id}" is still required`, 'REQUIRED_BY', requirers.map((r) => `${r} requires ${id}`));
      }
    }
    this.installed.set(id, { ...pkg, owners: remaining });
    const removed = this.collectGarbage();
    return { removed, kept: removed.includes(id) ? [] : [id] };
  }

  /**
   * Release `owner` from every package it holds (a host-product extension
   * being removed), then remove every package left with neither an owner nor
   * an installed requirer, dependents first. Never blocks: packages the user
   * or other extensions hold, or that installed packages require, are kept.
   */
  uninstallOwnedBy(owner: string): PackageRemovalReport {
    const released: string[] = [];
    for (const [id, pkg] of this.installed) {
      if (!pkg.owners.includes(owner)) continue;
      this.installed.set(id, { ...pkg, owners: pkg.owners.filter((o) => o !== owner) });
      released.push(id);
    }
    const removed = this.collectGarbage();
    return { removed, kept: released.filter((id) => !removed.includes(id)) };
  }

  packages(): InstalledPackage[] {
    return [...this.installed.values()];
  }

  package(id: string): InstalledPackage | undefined {
    return this.installed.get(id);
  }

  // ---------------------------------------------------------------------------
  // Documents
  // ---------------------------------------------------------------------------

  /** A provider hub over this host's registry. One per open document. */
  createProviderHub(options: Omit<ProviderHubOptions, 'registry'> = {}): ProviderHub {
    return new ProviderHub({ ...options, registry: this.registry });
  }

  /** Run installed `holodeck.document.check`s, plus the engine's own body validation. */
  async checkDocument(doc: HolodeckDocument): Promise<CheckDiagnostic[]> {
    const engine = this.engineTable.get(doc.engine);
    const own: CheckDiagnostic[] = (engine?.validateBody?.(doc.body) ?? []).map((message) => ({
      check: `${doc.engine}.body`,
      severity: 'error',
      code: 'INVALID_BODY',
      message,
    }));
    if (!engine) {
      own.push({ check: 'holodeck.host', severity: 'warning', code: 'UNKNOWN_ENGINE', message: `engine "${doc.engine}" is not registered` });
    }
    return [...own, ...(await runDocumentChecks(this.registry, doc, engine))];
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private packageContext(manifest: HolodeckPackageManifest, options: PackageInstallOptions) {
    const assetBase =
      options.assetBase ??
      (options.manifestUrl ? new URL(manifest.assets ?? '.', options.manifestUrl).toString() : undefined);
    return {
      host: this.name,
      assetUrl: (path: string) => {
        if (assetBase === undefined) {
          throw new HolodeckHostError(
            `package "${manifest.id}" asked for asset "${path}" but no assetBase or manifestUrl was given`,
            'INVALID_MANIFEST',
          );
        }
        return resolvePackageAsset(assetBase, path);
      },
    };
  }

  /** Add `owner` to an installed package if its version is compatible. */
  private share(
    existing: InstalledPackage,
    manifest: HolodeckPackageManifest,
    owner: string,
    range: string | undefined,
  ): PackageInstallReport {
    const id = manifest.id;
    if (existing.owners.includes(owner)) {
      throw new HolodeckHostError(`package "${id}" is already installed`, 'DUPLICATE_PACKAGE', [
        `${owner === USER_OWNER ? 'the user' : owner} already owns ${id} ${existing.manifest.version}`,
      ]);
    }
    const have = existing.manifest.version;
    const compatible = range !== undefined ? satisfiesRange(have, range) : have === manifest.version;
    if (!compatible) {
      throw new HolodeckHostError(`package "${id}" is installed in an incompatible version`, 'VERSION_CONFLICT', [
        `${id} ${have} is installed (owners: ${existing.owners.join(', ') || 'none'})`,
        `${owner} needs ${id} ${range ?? manifest.version}`,
      ]);
    }
    this.installed.set(id, { ...existing, owners: [...existing.owners, owner] });
    return { packageId: id, shared: true, unresolvedEngines: [] };
  }

  /** Installed packages that require `id`. */
  private requirersOf(id: string): string[] {
    return [...this.installed].filter(([, p]) => p.manifest.requires?.[id] !== undefined).map(([other]) => other);
  }

  /**
   * Remove packages with no owner and no installed requirer, repeatedly, so
   * dependents go before what they require. Hook errors after a committed
   * uninstall do not stop the sweep; they are thrown together at the end.
   */
  private collectGarbage(): string[] {
    const removed: string[] = [];
    const hookErrors: unknown[] = [];
    for (;;) {
      const orphan = [...this.installed].find(([id, p]) => !p.owners.length && !this.requirersOf(id).length)?.[0];
      if (orphan === undefined) break;
      try {
        this.removeFromRegistry(orphan);
      } catch (error) {
        if (this.installed.has(orphan)) throw error;
        hookErrors.push(error);
      }
      removed.push(orphan);
    }
    if (hookErrors.length) {
      throw new AggregateError(hookErrors, `packages ${removed.join(', ')} were removed, but uninstall hooks failed`);
    }
    return removed;
  }

  private removeFromRegistry(id: string): void {
    try {
      this.registry.uninstall(id);
    } finally {
      // An AggregateError from uninstall hooks still means the uninstall committed.
      if (!this.registry.installedExtensions().some((e) => e.id === id)) this.installed.delete(id);
    }
  }
}

function isExtension(source: HolodeckPackageModule | HolodeckExtension): source is HolodeckExtension {
  return 'contributions' in source && typeof (source as HolodeckExtension).id === 'string';
}
