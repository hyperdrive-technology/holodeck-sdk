import { describe, expect, it } from 'vitest';
import {
  DOCUMENT_CHECK_KIND,
  IMPORTER_KIND,
  findImporters,
  isDiagnostic,
  isDocumentCheck,
  isHolodeckImporter,
  runDocumentChecks,
  type DocumentCheck,
  type HolodeckImporter,
} from './checks';
import { HOLODECK_DOCUMENT_FORMAT, type HolodeckDocument } from './document';
import { ContributionRegistry, runContributionKindConformance } from './registry';

const doc: HolodeckDocument = { format: HOLODECK_DOCUMENT_FORMAT, id: 'd', name: 'D', engine: 'holodeck.iso', body: {} };

const check = (id: string, engines: string[], run: DocumentCheck['check']): DocumentCheck => ({ id, label: id, engines, check: run });

const importer = (over: Partial<HolodeckImporter> = {}): HolodeckImporter => ({
  id: 'terraform',
  label: 'Terraform state',
  engine: 'holodeck.iso',
  accepts: { extensions: ['.tfstate'], mimeTypes: ['application/json'] },
  import: async () => ({ document: doc, diagnostics: [] }),
  ...over,
});

describe('document checks', () => {
  it('validates check items and diagnostics', () => {
    expect(isDocumentCheck(check('a', ['*'], () => []))).toBe(true);
    expect(isDocumentCheck(check('a', [], () => []))).toBe(false);
    expect(isDocumentCheck(check('a', ['Bad Engine'], () => []))).toBe(false);
    expect(isDocumentCheck({ id: 'a', label: 'A', engines: ['*'] })).toBe(false);
    expect(isDiagnostic({ severity: 'info', message: 'm', code: 'C', objectId: 'o', source: 's' })).toBe(true);
    expect(isDiagnostic({ severity: 'fatal', message: 'm' })).toBe(false);
    expect(isDiagnostic({ severity: 'info', message: '' })).toBe(false);
    expect(isDiagnostic({ severity: 'info', message: 'm', code: 1 })).toBe(false);
  });

  it('runs applicable checks, tags results, and contains failures', async () => {
    const registry = new ContributionRegistry();
    registry.registerKind(DOCUMENT_CHECK_KIND);
    registry.install({
      id: 'acme.lint',
      version: '1.0.0',
      contributions: {
        'holodeck.document.check': [
          check('any', ['*'], () => [{ severity: 'info', message: 'seen', objectId: 'x' }]),
          check('iso-only', ['holodeck.iso'], async () => [{ severity: 'warning', message: 'iso' }]),
          check('flow-only', ['holodeck.flow'], () => [{ severity: 'error', message: 'never' }]),
          check('throws', ['*'], () => {
            throw new Error('kaboom');
          }),
          check('malformed', ['*'], () => [{ severity: 'loud' }] as never),
          check('not-array', ['*'], () => 'nope' as never),
        ],
      },
    });
    const out = await runDocumentChecks(registry, doc);
    expect(out).toEqual([
      { check: 'any', severity: 'info', message: 'seen', objectId: 'x' },
      { check: 'iso-only', severity: 'warning', message: 'iso' },
      { check: 'throws', severity: 'error', code: 'CHECK_FAILED', message: 'check "throws" threw: kaboom' },
      { check: 'malformed', severity: 'error', code: 'CHECK_INVALID_RESULT', message: 'check "malformed" returned malformed diagnostics' },
      { check: 'not-array', severity: 'error', code: 'CHECK_INVALID_RESULT', message: 'check "not-array" returned malformed diagnostics' },
    ]);
  });

  it('passes the contribution kind conformance kit', () => {
    const failures: string[] = [];
    runContributionKindConformance(
      () => new ContributionRegistry(),
      DOCUMENT_CHECK_KIND,
      [check('a', ['*'], () => []), check('b', ['holodeck.iso'], () => [])],
      (ok, m) => {
        if (!ok) failures.push(m);
      },
    );
    expect(failures).toEqual([]);
  });
});

describe('importers', () => {
  it('validates importer items', () => {
    expect(isHolodeckImporter(importer())).toBe(true);
    expect(isHolodeckImporter(importer({ accepts: { extensions: ['.tfstate'] } }))).toBe(true);
    expect(isHolodeckImporter(importer({ accepts: {} }))).toBe(false);
    expect(isHolodeckImporter(importer({ accepts: { extensions: ['tfstate'] } }))).toBe(false);
    expect(isHolodeckImporter(importer({ accepts: { mimeTypes: ['json'] } }))).toBe(false);
    expect(isHolodeckImporter(importer({ engine: 'Iso' }))).toBe(false);
    expect(isHolodeckImporter({ ...importer(), import: undefined })).toBe(false);
    expect(isHolodeckImporter(null)).toBe(false);
  });

  it('finds importers by extension (case-insensitive) or MIME type', () => {
    const registry = new ContributionRegistry();
    registry.registerKind(IMPORTER_KIND);
    registry.install({
      id: 'importers',
      version: '1.0.0',
      contributions: {
        'holodeck.importer': [importer(), importer({ id: 'drawio', label: 'draw.io', accepts: { extensions: ['.drawio', '.drawio.xml'] } })],
      },
    });
    expect(findImporters(registry, 'prod.TFSTATE').map((i) => i.id)).toEqual(['terraform']);
    expect(findImporters(registry, 'diagram.drawio.xml').map((i) => i.id)).toEqual(['drawio']);
    expect(findImporters(registry, undefined, 'application/json').map((i) => i.id)).toEqual(['terraform']);
    expect(findImporters(registry, 'readme.md')).toEqual([]);
    expect(findImporters(registry)).toEqual([]);
  });

  it('passes the contribution kind conformance kit', () => {
    const failures: string[] = [];
    runContributionKindConformance(() => new ContributionRegistry(), IMPORTER_KIND, [importer(), importer({ id: 'other' })], (ok, m) => {
      if (!ok) failures.push(m);
    });
    expect(failures).toEqual([]);
  });
});
