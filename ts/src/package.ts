/**
 * Holodeck packages: how engines, themes, libraries (asset packs), providers,
 * importers and checks ship (contract: docs/PACKAGING.md §3–4).
 *
 * A package is a directory (normally an npm package) with:
 *
 *   holodeck.package.json   manifest, readable without running code
 *   <entry>                 ES module; default export `defineHolodeckPackage(...)`
 *   <assets>/               GLB / SVG / PNG files the contributions reference
 *
 * The manifest declares what the package contributes so hosts and the
 * marketplace can index, check compatibility and ask for permissions before
 * loading code. Installing creates the extension from the entry module and
 * checks it against the manifest (`checkExtensionMatchesManifest`).
 *
 * Holodeck packages never reference a host product. A host product's own
 * extension format (e.g. a Hyperdrive extension) embeds Holodeck packages by
 * reference; see docs/PACKAGING.md §8.
 */

import { isDottedId, isKindName, isNonEmptyStr, isObj, isStr, isStrArray } from './guards.js';

export { isKindName };
import { HOLODECK_KINDS, type HolodeckExtension } from './registry.js';
import { isValidRange, isValidVersion } from './version.js';

export const HOLODECK_PACKAGE_SCHEMA = 'holodeck.package.v1';
export const HOLODECK_PACKAGE_MANIFEST_FILE = 'holodeck.package.json';

/** Kinds owned by the host rather than an engine; packages need no `engines` entry for them. */
export const HOST_KINDS: readonly string[] = [
  HOLODECK_KINDS.provider,
  HOLODECK_KINDS.importer,
  HOLODECK_KINDS.documentCheck,
];

export interface HolodeckEngineDeclaration {
  /** Engine id, e.g. `holodeck.iso`. Its kinds are `<id>.<name>`. */
  id: string;
  /** Contribution API version (semver) that `engines` ranges are matched against. */
  apiVersion: string;
  /** Format id of the document body the engine reads, e.g. `holodeck.iso.scene.v1`. */
  documentFormat: string;
}

export interface HolodeckAssetLicense {
  /** Path (or directory) inside the package. */
  path: string;
  /** SPDX id, or `LicenseRef-…` for proprietary terms such as vendor icon sets. */
  license: string;
  /** Attribution / trademark notice the host shows in its credits. */
  notice?: string;
}

export interface HolodeckPackageManifest {
  schemaVersion: typeof HOLODECK_PACKAGE_SCHEMA;
  /** Package id, also the extension id in the registry. Dotted, e.g. `holodeck.aws`. */
  id: string;
  name: string;
  /** `MAJOR.MINOR.PATCH`. Matches the extension's `version`. */
  version: string;
  /** SPDX license of code and original assets. */
  license: string;
  description?: string;
  /** Every kind the package contributes to. */
  contributes: string[];
  /** Engine id → engine API range. Required for each engine whose kinds appear in `contributes`. */
  engines?: Record<string, string>;
  /** Present when the package implements an engine. */
  engine?: HolodeckEngineDeclaration;
  /** Ids of the `holodeck.provider` contributions, for indexing and connection pickers. */
  providers?: string[];
  /** Holodeck packages that must be installed first: package id → version range. */
  requires?: Record<string, string>;
  /** Entry module, relative to the manifest. */
  entry: string;
  /** Static asset root, relative to the manifest. */
  assets?: string;
  permissions?: {
    /** Origins providers may contact, e.g. `https://monitoring.*.amazonaws.com`. */
    network?: string[];
  };
  /** Assets whose license differs from `license`. */
  assetLicenses?: HolodeckAssetLicense[];
  homepage?: string;
  repository?: string;
  keywords?: string[];
}

/** Marketplace facets; derived from the manifest so they cannot drift from it. */
export type HolodeckPackageRole = 'engine' | 'theme' | 'library' | 'provider' | 'importer' | 'check';

/** Every top-level manifest field (`$schema` lets editors find the JSON Schema). Unknown fields are errors. */
export const HOLODECK_PACKAGE_MANIFEST_FIELDS = [
  '$schema',
  'schemaVersion',
  'id',
  'name',
  'version',
  'license',
  'description',
  'contributes',
  'engines',
  'engine',
  'providers',
  'requires',
  'entry',
  'assets',
  'permissions',
  'assetLicenses',
  'homepage',
  'repository',
  'keywords',
] as const;

const MANIFEST_KEYS: ReadonlySet<string> = new Set(HOLODECK_PACKAGE_MANIFEST_FIELDS);

/** `<engine id>.<name>` → engine id; `undefined` for host kinds. */
export function engineOfKind(kind: string): string | undefined {
  if (HOST_KINDS.includes(kind)) return undefined;
  const dot = kind.lastIndexOf('.');
  return dot > 0 ? kind.slice(0, dot) : undefined;
}

/**
 * A path inside the package: relative, no `..` segment, no scheme. Also
 * rejects everything the WHATWG URL parser would rewrite into something else,
 * so the string checked here is the path that gets resolved:
 * - `%` (encoded traversal such as `%2e%2e/` or `%2f`),
 * - backslashes (parsed as `/` in special URLs),
 * - ASCII control characters, tab/CR/LF (stripped anywhere), and leading or
 *   trailing whitespace (trimmed, so `" https://x"` would become absolute),
 * - `?` and `#` (they end the path).
 */
export function isPackageRelativePath(path: unknown): path is string {
  if (!isNonEmptyStr(path)) return false;
  if (path !== path.trim() || /[\u0000-\u001f\u007f%\\?#]/.test(path)) return false;
  if (path.startsWith('/') || /^[a-z][a-z0-9+.-]*:/i.test(path)) return false;
  return path.split('/').every((segment) => segment !== '..');
}

const ORIGIN = /^(https|wss|http|ws):\/\/([^/:]+)(:\d{1,5})?$/;
const LABEL = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Network permission pattern: `scheme://host[:port]` with scheme https, wss,
 * http or ws and no path. Host labels are lowercase `[a-z0-9-]`. At most one
 * label may be the whole-label wildcard `*`, and never one of the last two
 * labels, so a pattern always names a concrete registrable domain:
 * `https://*.amazonaws.com` and `https://monitoring.*.amazonaws.com` are
 * valid; `https://*.com`, `https://example.*`, `https://a.*.*` and
 * `https://ex*ample.com` are not (#29). Public suffixes with two labels
 * (`*.co.uk`) are not detected.
 */
export function isOriginPattern(origin: unknown): origin is string {
  if (!isNonEmptyStr(origin)) return false;
  const m = ORIGIN.exec(origin);
  if (!m) return false;
  const labels = (m[2] as string).split('.');
  const wildcards = labels.filter((l) => l === '*').length;
  if (!labels.every((l) => l === '*' || LABEL.test(l))) return false;
  if (wildcards === 0) return true;
  return wildcards === 1 && labels.length >= 3 && labels.indexOf('*') < labels.length - 2;
}

/**
 * Does a concrete origin (`https://monitoring.eu-west-1.amazonaws.com`) match
 * a pattern? `*` matches exactly one label. Invalid patterns match nothing.
 */
export function originMatches(pattern: string, origin: string): boolean {
  if (!isOriginPattern(pattern)) return false;
  if (pattern === origin) return true;
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[a-z0-9-]+');
  return new RegExp(`^${escaped}$`).test(origin);
}

/** Every problem with a manifest; empty = valid. */
export function validateHolodeckPackageManifest(raw: unknown): string[] {
  if (!isObj(raw)) return ['manifest: must be an object'];
  const errors: string[] = [];
  for (const key of Object.keys(raw)) if (!MANIFEST_KEYS.has(key)) errors.push(`${key}: unknown field`);

  if (raw.schemaVersion !== HOLODECK_PACKAGE_SCHEMA) errors.push(`schemaVersion: must be "${HOLODECK_PACKAGE_SCHEMA}"`);
  if (!isDottedId(raw.id)) errors.push('id: must be a dotted id such as "holodeck.aws"');
  if (!isNonEmptyStr(raw.name)) errors.push('name: must be a non-empty string');
  if (!isValidVersion(raw.version)) errors.push('version: must be MAJOR.MINOR.PATCH');
  if (!isNonEmptyStr(raw.license)) errors.push('license: must be an SPDX id');
  if (raw.description !== undefined && !isStr(raw.description)) errors.push('description: must be a string');

  const engines = isObj(raw.engines) ? raw.engines : {};
  if (raw.engines !== undefined) {
    if (!isObj(raw.engines)) errors.push('engines: must map engine ids to version ranges');
    else {
      for (const [id, range] of Object.entries(raw.engines)) {
        if (!isDottedId(id)) errors.push(`engines: "${id}" is not a dotted engine id`);
        if (!isValidRange(range)) errors.push(`engines.${id}: unsupported version range "${String(range)}"`);
      }
    }
  }

  if (!isStrArray(raw.contributes)) errors.push('contributes: must be an array of kind names');
  else {
    const seen = new Set<string>();
    for (const kind of raw.contributes) {
      if (!isKindName(kind)) errors.push(`contributes: "${kind}" is not a kind name such as "holodeck.iso.part"`);
      if (seen.has(kind)) errors.push(`contributes: "${kind}" is listed twice`);
      seen.add(kind);
      const engine = engineOfKind(kind);
      if (engine !== undefined && !(engine in engines)) {
        errors.push(`contributes: "${kind}" needs an engines["${engine}"] range`);
      }
    }
  }

  if (raw.engine !== undefined) {
    const e = raw.engine;
    if (!isObj(e)) errors.push('engine: must be an object');
    else {
      if (!isDottedId(e.id)) errors.push('engine.id: must be a dotted engine id');
      if (!isValidVersion(e.apiVersion)) errors.push('engine.apiVersion: must be MAJOR.MINOR.PATCH');
      if (!isNonEmptyStr(e.documentFormat)) errors.push('engine.documentFormat: must be a non-empty string');
    }
  }

  if (raw.providers !== undefined) {
    if (!Array.isArray(raw.providers) || !raw.providers.every(isDottedId)) {
      errors.push('providers: must be an array of dotted provider ids');
    } else {
      if (new Set(raw.providers).size !== raw.providers.length) errors.push('providers: duplicate provider id');
      if (raw.providers.length && !(isStrArray(raw.contributes) && raw.contributes.includes(HOLODECK_KINDS.provider))) {
        errors.push(`providers: requires "${HOLODECK_KINDS.provider}" in contributes`);
      }
    }
  }

  if (raw.requires !== undefined) {
    if (!isObj(raw.requires)) errors.push('requires: must map package ids to version ranges');
    else {
      for (const [id, range] of Object.entries(raw.requires)) {
        if (!isDottedId(id)) errors.push(`requires: "${id}" is not a dotted package id`);
        if (id === raw.id) errors.push('requires: a package cannot require itself');
        if (!isValidRange(range)) errors.push(`requires.${id}: unsupported version range "${String(range)}"`);
      }
    }
  }

  if (!isPackageRelativePath(raw.entry)) errors.push('entry: must be a relative path inside the package');
  if (raw.assets !== undefined && !isPackageRelativePath(raw.assets)) {
    errors.push('assets: must be a relative path inside the package');
  }

  if (raw.permissions !== undefined) {
    if (!isObj(raw.permissions)) errors.push('permissions: must be an object');
    else {
      for (const key of Object.keys(raw.permissions)) {
        if (key !== 'network') errors.push(`permissions.${key}: unknown permission`);
      }
      const net = raw.permissions.network;
      if (net !== undefined && !(Array.isArray(net) && net.every(isOriginPattern))) {
        errors.push('permissions.network: must be origins such as "https://*.example.com" (no paths)');
      }
    }
  }

  if (raw.assetLicenses !== undefined) {
    if (!Array.isArray(raw.assetLicenses)) errors.push('assetLicenses: must be an array');
    else {
      raw.assetLicenses.forEach((a: unknown, i: number) => {
        if (!isObj(a) || !isPackageRelativePath(a.path) || !isNonEmptyStr(a.license)) {
          errors.push(`assetLicenses[${i}]: needs a relative path and a license`);
        } else if (a.notice !== undefined && !isStr(a.notice)) {
          errors.push(`assetLicenses[${i}].notice: must be a string`);
        }
      });
    }
  }

  for (const key of ['homepage', 'repository'] as const) {
    if (raw[key] !== undefined && !isStr(raw[key])) errors.push(`${key}: must be a string`);
  }
  if (raw.keywords !== undefined && !isStrArray(raw.keywords)) errors.push('keywords: must be an array of strings');
  return errors;
}

export type HolodeckPackageErrorCode = 'INVALID_MANIFEST' | 'ASSET_ESCAPES_PACKAGE';

export class HolodeckPackageError extends Error {
  constructor(
    message: string,
    public readonly code: HolodeckPackageErrorCode,
    public readonly details: readonly string[] = [],
  ) {
    super(details.length ? `${message}:\n- ${details.join('\n- ')}` : message);
    this.name = 'HolodeckPackageError';
  }
}

/** Throws `HolodeckPackageError` listing every problem; returns the manifest typed. */
export function parseHolodeckPackageManifest(raw: unknown): HolodeckPackageManifest {
  const errors = validateHolodeckPackageManifest(raw);
  if (errors.length) throw new HolodeckPackageError('invalid holodeck.package.json', 'INVALID_MANIFEST', errors);
  return raw as HolodeckPackageManifest;
}

/** Marketplace facets of a valid manifest. */
export function packageRoles(manifest: HolodeckPackageManifest): HolodeckPackageRole[] {
  const roles = new Set<HolodeckPackageRole>();
  if (manifest.engine) roles.add('engine');
  for (const kind of manifest.contributes) {
    if (kind === HOLODECK_KINDS.provider) roles.add('provider');
    else if (kind === HOLODECK_KINDS.importer) roles.add('importer');
    else if (kind === HOLODECK_KINDS.documentCheck) roles.add('check');
    else if (kind.endsWith('.theme')) roles.add('theme');
    else roles.add('library');
  }
  const order: HolodeckPackageRole[] = ['engine', 'theme', 'library', 'provider', 'importer', 'check'];
  return order.filter((r) => roles.has(r));
}

/**
 * Problems where the extension created by the entry module disagrees with the
 * manifest: id/version, undeclared kinds, provider ids, provider origins.
 */
export function checkExtensionMatchesManifest(manifest: HolodeckPackageManifest, ext: HolodeckExtension): string[] {
  const errors: string[] = [];
  if (ext.id !== manifest.id) errors.push(`extension id "${ext.id}" differs from manifest id "${manifest.id}"`);
  if (ext.version !== manifest.version) {
    errors.push(`extension version "${ext.version}" differs from manifest version "${manifest.version}"`);
  }
  for (const [kind, items] of Object.entries(ext.contributions)) {
    if (items.length && !manifest.contributes.includes(kind)) {
      errors.push(`extension contributes "${kind}" but the manifest does not declare it`);
    }
  }
  const providers = (ext.contributions[HOLODECK_KINDS.provider] ?? []) as Array<{ id: string; origins?: unknown }>;
  const declared = new Set(manifest.providers ?? []);
  for (const p of providers) {
    if (!declared.has(p.id)) errors.push(`provider "${p.id}" is not listed in manifest.providers`);
    declared.delete(p.id);
    const origins = Array.isArray(p.origins) ? (p.origins as string[]) : [];
    const allowed = manifest.permissions?.network ?? [];
    for (const origin of origins) {
      if (!allowed.some((pattern) => pattern === origin || originMatches(pattern, origin))) {
        errors.push(`provider "${p.id}" origin "${origin}" is not in permissions.network`);
      }
    }
  }
  for (const missing of declared) errors.push(`manifest.providers lists "${missing}" but the extension has no such provider`);
  return errors;
}

/**
 * Resolve a package-relative asset path against the host-chosen asset base
 * URL. Rejects absolute paths and traversal so a package cannot point outside
 * its own assets.
 */
export function resolvePackageAsset(assetBase: string, path: string): string {
  if (!isPackageRelativePath(path)) {
    throw new HolodeckPackageError(`asset path "${path}" escapes the package`, 'ASSET_ESCAPES_PACKAGE');
  }
  const base = new URL(assetBase);
  base.search = '';
  base.hash = '';
  if (!base.pathname.endsWith('/')) base.pathname = `${base.pathname}/`;
  const resolved = new URL(path, base);
  // Belt and braces: whatever the parser did, the result must sit under the base directory.
  if (resolved.origin !== base.origin || !resolved.href.startsWith(base.href) || resolved.search || resolved.hash) {
    throw new HolodeckPackageError(`asset path "${path}" escapes the package`, 'ASSET_ESCAPES_PACKAGE');
  }
  return resolved.href;
}

export interface HolodeckPackageContext {
  /** Package-relative asset path → URL the renderer can fetch. */
  assetUrl(path: string): string;
  /** Host name for diagnostics only (e.g. `holodeck-studio`); never branch semantics on it. */
  host: string;
}

/** Default export of a package's entry module. */
export interface HolodeckPackageModule {
  /** Optional embedded manifest copy (bundlers); the host still checks it against the file. */
  manifest?: HolodeckPackageManifest;
  createExtension(ctx: HolodeckPackageContext): HolodeckExtension | Promise<HolodeckExtension>;
}

/** Identity helper that types an entry module's default export. */
export function defineHolodeckPackage(module: HolodeckPackageModule): HolodeckPackageModule {
  return module;
}
