/**
 * Engine-agnostic contribution kinds for whole documents
 * (contract: docs/PACKAGING.md §6.5–6.6):
 *
 * - `holodeck.document.check`: a lint over a document (style-guide rules,
 *   accessibility, naming). Host products ship their own rule sets as
 *   ordinary Holodeck packages.
 * - `holodeck.importer`: turns an external file (Terraform state, a vendor
 *   export, a diagram from another tool) into a `HolodeckDocument`.
 */

import type { HolodeckDocument } from './document.js';
import type { HolodeckEngine } from './engine.js';
import { isDottedId, isNonEmptyStr, isObj, isStr } from './guards.js';
import type { Diagnostic, RegistryReader } from './provider.js';
import { HOLODECK_KINDS, type Contribution, type ContributionKind } from './registry.js';

// -----------------------------------------------------------------------------
// Document checks
// -----------------------------------------------------------------------------

export interface DocumentCheckContext {
  registry: RegistryReader;
  /** The document's engine, when the host has it registered. */
  engine: HolodeckEngine | undefined;
}

export interface DocumentCheck extends Contribution {
  id: string;
  label: string;
  description?: string;
  /** Engine ids the check understands, or `['*']` for every engine. */
  engines: string[];
  check(doc: HolodeckDocument, ctx: DocumentCheckContext): Diagnostic[] | Promise<Diagnostic[]>;
}

export interface CheckDiagnostic extends Diagnostic {
  /** Id of the check that produced it. */
  check: string;
}

const SEVERITIES = ['error', 'warning', 'info'];

export function isDiagnostic(v: unknown): v is Diagnostic {
  return (
    isObj(v) &&
    SEVERITIES.includes(v.severity as string) &&
    isNonEmptyStr(v.message) &&
    (v.code === undefined || isStr(v.code)) &&
    (v.objectId === undefined || isStr(v.objectId)) &&
    (v.source === undefined || isStr(v.source))
  );
}

export function isDocumentCheck(item: unknown): item is DocumentCheck {
  return (
    isObj(item) &&
    isNonEmptyStr(item.id) &&
    isNonEmptyStr(item.label) &&
    Array.isArray(item.engines) &&
    item.engines.length > 0 &&
    item.engines.every((e) => e === '*' || isDottedId(e)) &&
    typeof item.check === 'function'
  );
}

export const DOCUMENT_CHECK_KIND: ContributionKind<DocumentCheck> = {
  kind: HOLODECK_KINDS.documentCheck,
  validate: isDocumentCheck,
};

/**
 * Run every installed check that applies to `doc.engine`. A check that
 * throws or returns malformed diagnostics yields one `error` diagnostic
 * (`CHECK_FAILED` / `CHECK_INVALID_RESULT`) instead of failing the run.
 * Results keep check registration order.
 */
export async function runDocumentChecks(
  registry: RegistryReader,
  doc: HolodeckDocument,
  engine?: HolodeckEngine,
): Promise<CheckDiagnostic[]> {
  const checks = registry
    .list<DocumentCheck>(HOLODECK_KINDS.documentCheck)
    .filter((c) => c.engines.includes('*') || c.engines.includes(doc.engine));
  const ctx: DocumentCheckContext = { registry, engine };
  const results = await Promise.all(
    checks.map(async (c): Promise<CheckDiagnostic[]> => {
      try {
        const out: unknown = await c.check(doc, ctx);
        if (!Array.isArray(out) || !out.every(isDiagnostic)) {
          return [
            { check: c.id, severity: 'error', code: 'CHECK_INVALID_RESULT', message: `check "${c.id}" returned malformed diagnostics` },
          ];
        }
        return out.map((d) => ({ ...d, check: c.id }));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return [{ check: c.id, severity: 'error', code: 'CHECK_FAILED', message: `check "${c.id}" threw: ${message}` }];
      }
    }),
  );
  return results.flat();
}

// -----------------------------------------------------------------------------
// Importers
// -----------------------------------------------------------------------------

export interface ImportContext {
  fileName?: string;
  mimeType?: string;
  registry: RegistryReader;
}

export interface ImportOutcome {
  document: HolodeckDocument;
  diagnostics: Diagnostic[];
}

export interface HolodeckImporter extends Contribution {
  id: string;
  label: string;
  description?: string;
  /** Engine of the documents it produces. */
  engine: string;
  /** File extensions with the dot (`.tfstate`) and/or MIME types it accepts. */
  accepts: { extensions?: string[]; mimeTypes?: string[] };
  import(input: string | Uint8Array, ctx: ImportContext): Promise<ImportOutcome>;
}

export function isHolodeckImporter(item: unknown): item is HolodeckImporter {
  if (!isObj(item) || !isNonEmptyStr(item.id) || !isNonEmptyStr(item.label) || !isDottedId(item.engine)) return false;
  if (typeof item.import !== 'function' || !isObj(item.accepts)) return false;
  const { extensions, mimeTypes } = item.accepts;
  const okList = (v: unknown, pattern: RegExp) => v === undefined || (Array.isArray(v) && v.every((x) => isStr(x) && pattern.test(x)));
  if (!okList(extensions, /^\.[a-z0-9.+-]+$/i) || !okList(mimeTypes, /^[\w.+-]+\/[\w.+-]+$/)) return false;
  return Boolean((extensions as unknown[] | undefined)?.length || (mimeTypes as unknown[] | undefined)?.length);
}

export const IMPORTER_KIND: ContributionKind<HolodeckImporter> = {
  kind: HOLODECK_KINDS.importer,
  validate: isHolodeckImporter,
};

/** Installed importers that accept a file, by extension suffix (case-insensitive) or MIME type. */
export function findImporters(registry: RegistryReader, fileName?: string, mimeType?: string): HolodeckImporter[] {
  const name = fileName?.toLowerCase() ?? '';
  return registry.list<HolodeckImporter>(HOLODECK_KINDS.importer).filter(
    (imp) =>
      (name && imp.accepts.extensions?.some((ext) => name.endsWith(ext.toLowerCase()))) ||
      (mimeType !== undefined && imp.accepts.mimeTypes?.includes(mimeType)),
  );
}
