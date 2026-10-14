/**
 * Holodeck documents and signal bindings (contract: docs/PACKAGING.md §5–6).
 *
 * One envelope serves every engine. The engine owns `body` (iso placements,
 * flow nodes and wires, a 3D `SceneGraph` …). Everything a host needs without
 * understanding the body sits on the envelope: which engine and theme, which
 * packages, and which provider connections.
 *
 * A binding connects one parameter of one document object to one provider
 * signal. The `source` string belongs to the provider; engines and hosts
 * never parse it. That keeps Holodeck domain-neutral: an AWS metric, a PLC
 * tag and a flow-block output are all just `{ connection, source }`.
 */

import { isDottedId, isFiniteNum, isNonEmptyStr, isObj, isSignalValue, isStr, isStrRecord } from './guards.js';
import type { SignalValue } from './provider.js';
import { isValidRange, isValidVersion } from './version.js';

export const HOLODECK_DOCUMENT_FORMAT = 'holodeck.document.v1';

/** A provider session a document uses. Bindings reference it by `id`. */
export interface ProviderConnection {
  /** Document-scoped id, e.g. `prod-aws` or `plant`. */
  id: string;
  /** `holodeck.provider` contribution id, e.g. `aws.cloudwatch`. */
  provider: string;
  label?: string;
  /**
   * Non-secret settings (region, poll interval, endpoint URL). Secrets never go
   * in a document; providers ask the host for them via `ProviderContext.secret`.
   */
  config?: Record<string, unknown>;
}

/**
 * Optional value mapping applied between the provider and the engine.
 *
 * - `scale`: linear map `[inMin, inMax]` → `[outMin, outMax]` (`clamp` default true).
 * - `threshold`: the value of the last step whose `at` ≤ input; `below` when
 *   under the first step. Typical use: CPU % → status colour.
 * - `map`: `cases[String(input)]`, else `default`.
 * - `format`: `template` with `{value}` replaced; numbers use `digits` decimals.
 *
 * Non-numeric input to `scale` / `threshold` yields `null` (booleans count as
 * 0/1, numeric strings are parsed). `null` input always yields `null`.
 */
export type ValueTransform =
  | { kind: 'scale'; inMin: number; inMax: number; outMin: number; outMax: number; clamp?: boolean }
  | { kind: 'threshold'; steps: Array<{ at: number; value: SignalValue }>; below?: SignalValue }
  | { kind: 'map'; cases: Record<string, SignalValue>; default?: SignalValue }
  | { kind: 'format'; template: string; digits?: number };

export interface SignalBinding {
  /** `ProviderConnection.id` in the same document. */
  connection: string;
  /** Provider-defined address of the signal. Opaque to engines and hosts. */
  source: string;
  transform?: ValueTransform;
}

/** A binding located inside an engine body; produced by `HolodeckEngine.collectBindings`. */
export interface BindingRef {
  /** The engine's object id (placement id, flow node id …). */
  objectId: string;
  /** The object parameter the value drives (`level`, `color`, `text` …). */
  param: string;
  binding: SignalBinding;
}

export interface HolodeckDocumentMetadata {
  description?: string;
  author?: string;
  created?: string;
  updated?: string;
  tags?: string[];
}

export interface HolodeckDocument<Body = unknown> {
  format: typeof HOLODECK_DOCUMENT_FORMAT;
  id: string;
  name: string;
  /** Engine id, e.g. `holodeck.iso` or `holodeck.flow`. */
  engine: string;
  /** Engine API version the body was written for (`HolodeckEngine.apiVersion`). */
  engineVersion?: string;
  /** Theme contribution id of that engine. Absent = the engine default. */
  theme?: string;
  /** Packages whose contributions the body uses: package id → version range. */
  requires?: Record<string, string>;
  connections?: ProviderConnection[];
  /** Engine-owned content. */
  body: Body;
  metadata?: HolodeckDocumentMetadata;
  /** Host bags keyed by extension id; opaque to engines. */
  extensions?: Record<string, unknown>;
}

// -----------------------------------------------------------------------------
// Transforms
// -----------------------------------------------------------------------------

function toNumber(value: SignalValue): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Apply a binding transform. `undefined` transform passes the value through. */
export function applyTransform(transform: ValueTransform | undefined, value: SignalValue): SignalValue {
  if (!transform || value === null) return value;
  switch (transform.kind) {
    case 'scale': {
      const x = toNumber(value);
      if (x === null) return null;
      const span = transform.inMax - transform.inMin;
      // A zero-width input range has no slope: map everything to outMin.
      const t = span === 0 ? 0 : (x - transform.inMin) / span;
      const clamped = transform.clamp === false ? t : Math.min(1, Math.max(0, t));
      return transform.outMin + clamped * (transform.outMax - transform.outMin);
    }
    case 'threshold': {
      const x = toNumber(value);
      if (x === null) return null;
      let result: SignalValue = transform.below ?? null;
      for (const step of transform.steps) {
        if (x >= step.at) result = step.value;
        else break;
      }
      return result;
    }
    case 'map': {
      const key = String(value);
      if (Object.prototype.hasOwnProperty.call(transform.cases, key)) return transform.cases[key] ?? null;
      return transform.default ?? null;
    }
    case 'format': {
      const text =
        typeof value === 'number' && transform.digits !== undefined ? value.toFixed(transform.digits) : String(value);
      return transform.template.split('{value}').join(text);
    }
  }
}

/** Structural problems with a transform; empty = valid. */
export function validateTransform(raw: unknown, path = 'transform'): string[] {
  if (!isObj(raw)) return [`${path}: must be an object`];
  switch (raw.kind) {
    case 'scale': {
      const errors = ['inMin', 'inMax', 'outMin', 'outMax']
        .filter((k) => !isFiniteNum(raw[k]))
        .map((k) => `${path}.${k}: must be a finite number`);
      if (raw.clamp !== undefined && typeof raw.clamp !== 'boolean') errors.push(`${path}.clamp: must be a boolean`);
      return errors;
    }
    case 'threshold': {
      const errors: string[] = [];
      if (!Array.isArray(raw.steps) || raw.steps.length === 0) return [`${path}.steps: must be a non-empty array`];
      let prev = -Infinity;
      raw.steps.forEach((step: unknown, i: number) => {
        if (!isObj(step) || !isFiniteNum(step.at) || !isSignalValue(step.value)) {
          errors.push(`${path}.steps[${i}]: must be { at: number, value: signal value }`);
          return;
        }
        if (step.at <= prev) errors.push(`${path}.steps[${i}].at: steps must be strictly ascending`);
        prev = step.at;
      });
      if (raw.below !== undefined && !isSignalValue(raw.below)) errors.push(`${path}.below: must be a signal value`);
      return errors;
    }
    case 'map': {
      const errors: string[] = [];
      if (!isObj(raw.cases) || !Object.values(raw.cases).every(isSignalValue)) {
        errors.push(`${path}.cases: must map strings to signal values`);
      }
      if (raw.default !== undefined && !isSignalValue(raw.default)) errors.push(`${path}.default: must be a signal value`);
      return errors;
    }
    case 'format': {
      const errors: string[] = [];
      if (!isStr(raw.template) || !raw.template.includes('{value}')) {
        errors.push(`${path}.template: must be a string containing {value}`);
      }
      if (raw.digits !== undefined && !(Number.isInteger(raw.digits) && (raw.digits as number) >= 0 && (raw.digits as number) <= 20)) {
        errors.push(`${path}.digits: must be an integer 0–20`);
      }
      return errors;
    }
    default:
      return [`${path}.kind: must be one of scale, threshold, map, format`];
  }
}

// -----------------------------------------------------------------------------
// Validation
// -----------------------------------------------------------------------------

/** Structural problems with a document envelope; empty = valid. The body is the engine's to validate. */
export function validateHolodeckDocument(raw: unknown): string[] {
  if (!isObj(raw)) return ['document: must be an object'];
  const errors: string[] = [];
  if (raw.format !== HOLODECK_DOCUMENT_FORMAT) errors.push(`format: must be "${HOLODECK_DOCUMENT_FORMAT}"`);
  if (!isNonEmptyStr(raw.id)) errors.push('id: must be a non-empty string');
  if (!isStr(raw.name)) errors.push('name: must be a string');
  if (!isDottedId(raw.engine)) errors.push('engine: must be a dotted id such as "holodeck.iso"');
  if (raw.engineVersion !== undefined && !isValidVersion(raw.engineVersion)) {
    errors.push('engineVersion: must be a MAJOR.MINOR.PATCH version');
  }
  if (raw.theme !== undefined && !isNonEmptyStr(raw.theme)) errors.push('theme: must be a non-empty string');
  if (raw.requires !== undefined) {
    if (!isStrRecord(raw.requires)) errors.push('requires: must map package ids to version ranges');
    else {
      for (const [id, range] of Object.entries(raw.requires)) {
        if (!isDottedId(id)) errors.push(`requires: "${id}" is not a dotted package id`);
        if (!isValidRange(range)) errors.push(`requires.${id}: unsupported version range "${range}"`);
      }
    }
  }
  if (raw.connections !== undefined) {
    if (!Array.isArray(raw.connections)) errors.push('connections: must be an array');
    else {
      const seen = new Set<string>();
      raw.connections.forEach((c: unknown, i: number) => {
        if (!isObj(c)) {
          errors.push(`connections[${i}]: must be an object`);
          return;
        }
        if (!isNonEmptyStr(c.id)) errors.push(`connections[${i}].id: must be a non-empty string`);
        else if (seen.has(c.id)) errors.push(`connections[${i}].id: duplicate connection id "${c.id}"`);
        else seen.add(c.id);
        if (!isDottedId(c.provider)) errors.push(`connections[${i}].provider: must be a provider id`);
        if (c.label !== undefined && !isStr(c.label)) errors.push(`connections[${i}].label: must be a string`);
        if (c.config !== undefined && !isObj(c.config)) errors.push(`connections[${i}].config: must be an object`);
      });
    }
  }
  if (!('body' in raw) || raw.body === undefined) errors.push('body: is required');
  if (raw.metadata !== undefined && !isObj(raw.metadata)) errors.push('metadata: must be an object');
  if (raw.extensions !== undefined && !isObj(raw.extensions)) errors.push('extensions: must be an object');
  return errors;
}

/** Throws one `TypeError` listing every problem; returns the document typed. */
export function parseHolodeckDocument<Body = unknown>(raw: unknown): HolodeckDocument<Body> {
  const errors = validateHolodeckDocument(raw);
  if (errors.length) throw new TypeError(`invalid Holodeck document:\n- ${errors.join('\n- ')}`);
  return raw as HolodeckDocument<Body>;
}

/**
 * Check bindings an engine collected from a body against the document:
 * every connection exists, sources are non-empty, transforms are well-formed.
 */
export function validateBindings(doc: Pick<HolodeckDocument, 'connections'>, refs: readonly BindingRef[]): string[] {
  const connections = new Set((doc.connections ?? []).map((c) => c.id));
  const errors: string[] = [];
  for (const { objectId, param, binding } of refs) {
    const at = `${objectId}.${param}`;
    if (!isObj(binding)) {
      errors.push(`${at}: binding must be an object`);
      continue;
    }
    if (!isNonEmptyStr(binding.connection) || !connections.has(binding.connection)) {
      errors.push(`${at}: unknown connection "${String(binding.connection)}"`);
    }
    if (!isNonEmptyStr(binding.source)) errors.push(`${at}: source must be a non-empty string`);
    if (binding.transform !== undefined) errors.push(...validateTransform(binding.transform, `${at}.transform`));
  }
  return errors;
}
