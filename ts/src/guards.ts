/**
 * Small structural guards shared by the validators in this package.
 * Internal: not re-exported from `index.ts`.
 */

export const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export const isStr = (v: unknown): v is string => typeof v === 'string';

export const isNonEmptyStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

export const isFiniteNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export const isStrArray = (v: unknown): v is string[] => Array.isArray(v) && v.every(isNonEmptyStr);

export const isStrRecord = (v: unknown): v is Record<string, string> =>
  isObj(v) && Object.values(v).every(isNonEmptyStr);

/** A JSON-safe signal value: number (finite), string, boolean or null. */
export const isSignalValue = (v: unknown): v is number | string | boolean | null =>
  v === null || typeof v === 'string' || typeof v === 'boolean' || isFiniteNum(v);

/**
 * Dotted identifier used for package, provider and engine ids: lowercase
 * segments of `[a-z0-9-]`, separated by dots, e.g. `holodeck.aws`,
 * `aws.cloudwatch`, `holodeck.iso`. Kind names use `KIND_NAME` below.
 */
export const DOTTED_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\.[a-z0-9]+(?:-[a-z0-9]+)*)*$/;

export const isDottedId = (v: unknown): v is string => isNonEmptyStr(v) && DOTTED_ID.test(v);

/**
 * Contribution kind name: `<engine id>.<name>`, at least two segments. The
 * namespace (first segment) is lowercase like other ids; later segments may
 * be camelCase because existing kinds are (`holodeck.flow.nodeType`).
 */
export const KIND_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\.[a-zA-Z0-9]+(?:-[a-zA-Z0-9]+)*)+$/;

export const isKindName = (v: unknown): v is string => isNonEmptyStr(v) && KIND_NAME.test(v);
