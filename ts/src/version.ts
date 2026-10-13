/**
 * Version and version-range matching for package `requires` and `engines`.
 *
 * Deliberately a small, explicit subset of npm semver ranges, so the SDK keeps
 * zero runtime dependencies (it ships into browsers and Workers). Anything
 * outside the subset throws instead of being guessed at:
 *
 *   `*`                any version
 *   `1.2.3`            exactly that version (`1.2` = `1.2.0`)
 *   `^1.2.3`, `^1.2`   same major (same minor while major is 0, same patch while 0.0)
 *   `~1.2.3`, `~1.2`   same major.minor
 *   `>=1.2.3`          at least that version
 *
 * Pre-release tags (`1.0.0-beta.1`) are accepted on versions and sort before
 * the release (`1.0.0-beta < 1.0.0`). Ranges cannot name one, so a
 * pre-release version only satisfies `*`.
 */

export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease?: string;
}

const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?$/;
const PARTIAL = /^(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\.(0|[1-9]\d*))?$/;

/** Parse a full `MAJOR.MINOR.PATCH[-pre]` version; `undefined` if malformed. */
export function parseVersion(version: string): ParsedVersion | undefined {
  const m = VERSION.exec(version);
  if (!m) return undefined;
  const parsed: ParsedVersion = { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
  if (m[4] !== undefined) parsed.prerelease = m[4];
  return parsed;
}

export function isValidVersion(version: unknown): version is string {
  return typeof version === 'string' && parseVersion(version) !== undefined;
}

/** -1 / 0 / 1. A pre-release sorts before its release; pre-release tags compare as strings. */
export function compareVersions(a: ParsedVersion, b: ParsedVersion): number {
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  }
  if (a.prerelease === b.prerelease) return 0;
  if (a.prerelease === undefined) return 1;
  if (b.prerelease === undefined) return -1;
  return a.prerelease < b.prerelease ? -1 : 1;
}

interface Bound {
  min: ParsedVersion;
  /** Exclusive upper bound; absent = unbounded. */
  max?: ParsedVersion;
}

const v = (major: number, minor: number, patch: number): ParsedVersion => ({ major, minor, patch });

function parseRange(range: string): Bound | 'any' {
  const r = range.trim();
  if (r === '*') return 'any';
  const op = r.startsWith('>=') ? '>=' : r[0] === '^' || r[0] === '~' ? r[0] : '';
  const m = PARTIAL.exec(r.slice(op.length));
  if (!m) throw new RangeError(`unsupported version range "${range}" (use *, 1.2.3, ^1.2, ~1.2 or >=1.2.3)`);
  const major = Number(m[1]);
  const minor = Number(m[2]);
  const patch = m[3] === undefined ? 0 : Number(m[3]);
  const min = v(major, minor, patch);
  switch (op) {
    case '>=':
      return { min };
    case '~':
      return { min, max: v(major, minor + 1, 0) };
    case '^':
      if (major > 0) return { min, max: v(major + 1, 0, 0) };
      if (minor > 0) return { min, max: v(0, minor + 1, 0) };
      return { min, max: v(0, 0, patch + 1) };
    default:
      return { min, max: v(major, minor, patch + 1) };
  }
}

/** Throws `RangeError` for a range outside the supported subset. */
export function assertValidRange(range: string): void {
  parseRange(range);
}

export function isValidRange(range: unknown): range is string {
  if (typeof range !== 'string') return false;
  try {
    parseRange(range);
    return true;
  } catch {
    return false;
  }
}

/**
 * Does `version` satisfy `range`? Malformed versions never satisfy.
 * Ranges cannot name a pre-release, so a pre-release version only satisfies
 * `*` (npm's rule: `^1.0.0` does not match `1.1.0-beta`).
 */
export function satisfiesRange(version: string, range: string): boolean {
  const bound = parseRange(range);
  const parsed = parseVersion(version);
  if (!parsed) return false;
  if (bound === 'any') return true;
  if (parsed.prerelease !== undefined) return false;
  if (compareVersions(parsed, bound.min) < 0) return false;
  return bound.max === undefined || compareVersions(parsed, bound.max) < 0;
}
