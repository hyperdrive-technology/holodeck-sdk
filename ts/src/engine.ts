/**
 * Engines (contract: docs/PACKAGING.md §2).
 *
 * An engine is a canvas technology with its own document body and its own
 * contribution kinds: `holodeck.iso` (React Three Fiber 2.5D),
 * `holodeck.flow` (xyflow graphs), `holodeck.scene3d` (3D viewer). Themes,
 * libraries and inspectors target an engine through its kinds, which are
 * always named `<engine id>.<name>`.
 *
 * The descriptor is plain data plus pure functions, so hosts can register an
 * engine without mounting any React. Each engine package exports one.
 */

import type { BindingRef } from './document.js';
import { isDottedId, isNonEmptyStr, isObj } from './guards.js';
import type { ContributionKind } from './registry.js';
import { isValidVersion } from './version.js';

export interface HolodeckEngine<Body = unknown> {
  /** e.g. `holodeck.iso`. */
  id: string;
  label: string;
  /** Contribution API version (semver). Packages target it with `engines` ranges. */
  apiVersion: string;
  /** Format id of `HolodeckDocument.body`, e.g. `holodeck.iso.scene.v1`. */
  documentFormat: string;
  /** Kinds the engine receives; every name starts with `<id>.`. */
  // `any`: kinds of different item types live in one list; each validates its own items.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  kinds: readonly ContributionKind<any>[];
  /** Locate bindings in a body for `ProviderHub.setBindings`. */
  collectBindings?(body: Body): BindingRef[];
  /** Structural problems with a body; empty = valid. */
  validateBody?(body: unknown): string[];
}

/** Every problem with an engine descriptor; empty = valid. */
export function validateEngine(raw: unknown): string[] {
  if (!isObj(raw)) return ['engine: must be an object'];
  const errors: string[] = [];
  if (!isDottedId(raw.id)) errors.push('id: must be a dotted id such as "holodeck.iso"');
  if (!isNonEmptyStr(raw.label)) errors.push('label: must be a non-empty string');
  if (!isValidVersion(raw.apiVersion)) errors.push('apiVersion: must be MAJOR.MINOR.PATCH');
  if (!isNonEmptyStr(raw.documentFormat)) errors.push('documentFormat: must be a non-empty string');
  if (!Array.isArray(raw.kinds)) errors.push('kinds: must be an array of contribution kinds');
  else {
    const seen = new Set<string>();
    raw.kinds.forEach((k: unknown, i: number) => {
      if (!isObj(k) || !isDottedId(k.kind)) {
        errors.push(`kinds[${i}]: must be a contribution kind with a dotted name`);
        return;
      }
      if (isDottedId(raw.id) && !k.kind.startsWith(`${raw.id}.`)) {
        errors.push(`kinds[${i}]: "${k.kind}" must start with "${raw.id}."`);
      }
      if (seen.has(k.kind)) errors.push(`kinds[${i}]: "${k.kind}" is listed twice`);
      seen.add(k.kind);
    });
  }
  for (const fn of ['collectBindings', 'validateBody'] as const) {
    if (raw[fn] !== undefined && typeof raw[fn] !== 'function') errors.push(`${fn}: must be a function`);
  }
  return errors;
}
