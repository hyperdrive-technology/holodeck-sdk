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
 * `requires` between packages, engine API compatibility, and ownership, so a
 * host product can install and remove the Holodeck packages embedded in its
 * own extensions as a unit (`owner`).
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
import { satisfiesRange } from './version.js';

export type HolodeckHostErrorCode =
  | 'INVALID_MANIFEST'
  | 'MANIFEST_MISMATCH'
  | 'DUPLICATE_PACKAGE'
  | 'MISSING_REQUIREMENT'
  | 'ENGINE_INCOMPATIBLE'
  | 'INVALID_ENGINE'
  | 'DUPLICATE_ENGINE'
  | 'UNKNOWN_PACKAGE'
  | 'REQUIRED_BY';

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

export interface InstalledPackage {
  manifest: HolodeckPackageManifest;
  /** Who installed it, e.g. a host-product extension id. Absent = the user. */
  owner?: string;
}

export interface PackageInstallOptions {
  /** See `InstalledPackage.owner`. */
  owner?: string;
  /** Base URL of the package's `assets` directory. Default: `assets` resolved against `manifestUrl`. */
  assetBase?: string;
  /** URL of the manifest file, used to resolve the default `assetBase`. */
  manifestUrl?: string;
}

export interface PackageInstallReport {
  packageId: string;
  install: InstallResult;
  /** Engines named in `engines` that are not registered yet; their kinds wait as `pending`. */
  unresolvedEngines: string[];
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
   * Install a package: validate the manifest, check `requires` and engine
   * ranges, create the extension from the entry module, check it matches the
   * manifest, then install it into the registry. Nothing is recorded unless
   * the registry install commits.
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
    if (this.installed.has(id) || this.installing.has(id)) {
      throw new HolodeckHostError(`package "${id}" is already installed`, 'DUPLICATE_PACKAGE');
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

      const record: InstalledPackage = options.owner === undefined ? { manifest } : { manifest, owner: options.owner };
      let install: InstallResult;
      try {
        install = this.registry.install(ext);
      } catch (error) {
        // AggregateError = install committed but a hook threw: keep the books straight.
        if (this.registry.installedExtensions().some((e) => e.id === id)) this.installed.set(id, record);
        throw error;
      }
      this.installed.set(id, record);
      return { packageId: id, install, unresolvedEngines };
    } finally {
      this.installing.delete(id);
    }
  }

  /** Uninstall one package. Throws `REQUIRED_BY` while other installed packages require it. */
  uninstallPackage(id: string): void {
    if (!this.installed.has(id)) throw new HolodeckHostError(`package "${id}" is not installed`, 'UNKNOWN_PACKAGE');
    const dependents = this.dependentsOf(new Set([id]));
    if (dependents.length) {
      throw new HolodeckHostError(`package "${id}" is still required`, 'REQUIRED_BY', dependents);
    }
    this.removeFromRegistry(id);
  }

  /**
   * Uninstall every package installed with `owner`, dependents first. Checks
   * up front that no package outside the set requires one inside it, so it
   * either removes the whole set or nothing. Returns the removed ids in order.
   */
  uninstallOwnedBy(owner: string): string[] {
    const owned = new Set([...this.installed].filter(([, p]) => p.owner === owner).map(([id]) => id));
    const outside = this.dependentsOf(owned);
    if (outside.length) {
      throw new HolodeckHostError(`packages owned by "${owner}" are still required`, 'REQUIRED_BY', outside);
    }
    const order: string[] = [];
    const hookErrors: unknown[] = [];
    const remaining = new Set(owned);
    while (remaining.size) {
      // Remove packages no remaining package requires. `requires` form a DAG
      // (a package can only require packages installed before it), so there
      // is always at least one leaf.
      const leaves = [...remaining].filter(
        (id) => ![...remaining].some((other) => other !== id && this.installed.get(other)?.manifest.requires?.[id]),
      );
      if (!leaves.length) throw new Error(`uninstallOwnedBy("${owner}"): requires cycle among ${[...remaining].join(', ')}`);
      for (const id of leaves) {
        try {
          this.removeFromRegistry(id);
        } catch (error) {
          // Hook errors after a committed uninstall: keep going, report at the end.
          if (this.installed.has(id)) throw error;
          hookErrors.push(error);
        }
        remaining.delete(id);
        order.push(id);
      }
    }
    if (hookErrors.length) {
      throw new AggregateError(hookErrors, `packages owned by "${owner}" were removed, but uninstall hooks failed`);
    }
    return order;
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

  /** Installed packages outside `ids` that require something in `ids`, as "a requires b" strings. */
  private dependentsOf(ids: ReadonlySet<string>): string[] {
    const out: string[] = [];
    for (const [id, { manifest }] of this.installed) {
      if (ids.has(id)) continue;
      for (const dep of Object.keys(manifest.requires ?? {})) if (ids.has(dep)) out.push(`${id} requires ${dep}`);
    }
    return out;
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
