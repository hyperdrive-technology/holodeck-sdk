import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  HOLODECK_PACKAGE_MANIFEST_FIELDS,
  HOLODECK_PACKAGE_SCHEMA,
  checkExtensionMatchesManifest,
  defineHolodeckPackage,
  engineOfKind,
  isKindName,
  isOriginPattern,
  isPackageRelativePath,
  originMatches,
  packageRoles,
  parseHolodeckPackageManifest,
  resolvePackageAsset,
  validateHolodeckPackageManifest,
  type HolodeckPackageManifest,
} from './package';
import { HOLODECK_KINDS } from './registry';

const manifest = (over: Partial<HolodeckPackageManifest> & Record<string, unknown> = {}): HolodeckPackageManifest => ({
  schemaVersion: HOLODECK_PACKAGE_SCHEMA,
  id: 'holodeck.aws',
  name: 'AWS',
  version: '0.1.0',
  license: 'MIT',
  contributes: ['holodeck.iso.part'],
  engines: { 'holodeck.iso': '^1.0' },
  entry: 'dist/index.js',
  ...over,
});

describe('engineOfKind', () => {
  it('strips the last segment of engine kinds and returns undefined for host kinds', () => {
    expect(engineOfKind('holodeck.iso.part')).toBe('holodeck.iso');
    expect(engineOfKind('acme.pid.symbol')).toBe('acme.pid');
    expect(engineOfKind('holodeck.provider')).toBeUndefined();
    expect(engineOfKind('holodeck.importer')).toBeUndefined();
    expect(engineOfKind('holodeck.document.check')).toBeUndefined();
    expect(engineOfKind('single')).toBeUndefined();
  });
});

describe('paths and origins', () => {
  it.each([
    ['dist/index.js', true],
    ['./assets', true],
    ['assets/logos/ec2.svg', true],
    ['/etc/passwd', false],
    ['../outside', false],
    ['a/../../b', false],
    ['https://cdn/x.js', false],
    ['C:\\x', false],
    ['', false],
    // GPT review sdk#23 P1: inputs the URL parser would normalise outside the package
    ['%2e%2e/private.svg', false],
    ['..%2fprivate.svg', false],
    ['a%20b.svg', false],
    [' https://other.example/a.svg', false],
    ['\thttps://other.example/a.svg', false],
    ['a/\n../../b', false],
    ['a.svg ', false],
    ['a\u0000.svg', false],
    ['a?x=1', false],
    ['a#frag', false],
    ['icons/aws ec2.svg', true],
  ])('isPackageRelativePath(%j) = %s', (p, ok) => {
    expect(isPackageRelativePath(p)).toBe(ok);
  });

  it.each([
    ['https://monitoring.eu-west-1.amazonaws.com', true],
    ['https://*.amazonaws.com', true],
    ['https://monitoring.*.amazonaws.com', true],
    ['wss://plc.local:8443', true],
    ['http://localhost:3000', true],
    ['https://example.com/path', false],
    ['ftp://example.com', false],
    ['https://', false],
    ['*.example.com', false],
    // #29: the wildcard is one whole label, at most once, never in the last two labels
    ['https://*.com', false],
    ['https://example.*', false],
    ['https://a.*.*', false],
    ['https://*.*.example.com', false],
    ['https://ex*ample.com', false],
    ['https://*', false],
    ['https://-bad.example.com', false],
    ['https://Example.com', false],
    ['https://a.*.example.com', true],
    ['http://localhost', true],
  ])('isOriginPattern(%j) = %s', (o, ok) => {
    expect(isOriginPattern(o)).toBe(ok);
  });

  it('matches wildcards to exactly one label', () => {
    expect(originMatches('https://monitoring.*.amazonaws.com', 'https://monitoring.eu-west-1.amazonaws.com')).toBe(true);
    expect(originMatches('https://*.amazonaws.com', 'https://a.b.amazonaws.com')).toBe(false);
    expect(originMatches('https://*.amazonaws.com', 'https://evil.com')).toBe(false);
    expect(originMatches('https://a.com', 'https://a.com')).toBe(true);
    expect(originMatches('https://a.com', 'https://aXcom')).toBe(false);
    // #29: invalid patterns match nothing, even literally
    expect(originMatches('https://*.com', 'https://evil.com')).toBe(false);
    expect(originMatches('https://*.com', 'https://*.com')).toBe(false);
    expect(originMatches('https://example.*', 'https://example.evil')).toBe(false);
  });

  it('resolves assets inside the base and refuses escapes', () => {
    expect(resolvePackageAsset('https://cdn.example/pkg/assets', 'logos/ec2.svg')).toBe('https://cdn.example/pkg/assets/logos/ec2.svg');
    expect(resolvePackageAsset('https://cdn.example/pkg/assets/', './a.glb')).toBe('https://cdn.example/pkg/assets/a.glb');
    expect(() => resolvePackageAsset('https://cdn.example/a/', '../b')).toThrow(/escapes/);
    expect(() => resolvePackageAsset('https://cdn.example/a/', 'https://evil/x')).toThrow(/escapes/);
  });

  it('#30: package errors carry a code', () => {
    try {
      resolvePackageAsset('https://cdn.example/a/', '../b');
      expect.unreachable();
    } catch (error) {
      expect(error).toMatchObject({ name: 'HolodeckPackageError', code: 'ASSET_ESCAPES_PACKAGE', details: [] });
    }
    try {
      parseHolodeckPackageManifest({});
      expect.unreachable();
    } catch (error) {
      expect(error).toMatchObject({ name: 'HolodeckPackageError', code: 'INVALID_MANIFEST' });
    }
  });

  it('keeps resolved assets under the base (GPT review sdk#23 P1)', () => {
    for (const bad of ['%2e%2e/private.svg', ' https://other.example/a.svg', '\t//other.example/a.svg', 'x/%2e%2e/%2e%2e/y']) {
      expect(() => resolvePackageAsset('https://cdn.example/pkg/assets/', bad)).toThrow(/escapes/);
    }
    expect(resolvePackageAsset('https://cdn.example/pkg/assets?v=1#top', 'a.svg')).toBe('https://cdn.example/pkg/assets/a.svg');
    expect(resolvePackageAsset('file:///opt/pkg/assets', 'logos/a.svg')).toBe('file:///opt/pkg/assets/logos/a.svg');
    expect(validateHolodeckPackageManifest(manifest({ entry: '%2e%2e/evil.js' }))).toEqual([
      'entry: must be a relative path inside the package',
    ]);
  });
});

describe('validateHolodeckPackageManifest', () => {
  it('accepts a full library + provider manifest', () => {
    expect(
      validateHolodeckPackageManifest(
        manifest({
          $schema: 'https://example/schema.json',
          description: 'AWS icons and CloudWatch',
          contributes: ['holodeck.iso.part', 'holodeck.iso.theme', 'holodeck.provider'],
          providers: ['aws.cloudwatch'],
          requires: { 'holodeck.cloud': '^0.1' },
          assets: 'assets',
          permissions: { network: ['https://monitoring.*.amazonaws.com'] },
          assetLicenses: [{ path: 'assets/logos', license: 'LicenseRef-AWS-Trademark', notice: 'AWS icons © Amazon' }],
          homepage: 'https://holodeck.dev',
          repository: 'github:hyperdrive-technology/holodeck',
          keywords: ['aws'],
        }),
      ),
    ).toEqual([]);
  });

  it('accepts an engine manifest', () => {
    expect(
      validateHolodeckPackageManifest(
        manifest({
          id: 'holodeck.iso',
          engine: { id: 'holodeck.iso', apiVersion: '1.0.0', documentFormat: 'holodeck.iso.scene.v1' },
          contributes: ['holodeck.iso.part'],
        }),
      ),
    ).toEqual([]);
  });

  it('requires an engines range for every engine kind but not for host kinds', () => {
    expect(validateHolodeckPackageManifest(manifest({ engines: {} }))).toEqual([
      'contributes: "holodeck.iso.part" needs an engines["holodeck.iso"] range',
    ]);
    const { engines: _e, ...rest } = manifest({ contributes: ['holodeck.provider', 'holodeck.document.check'], providers: ['a.b'] });
    expect(validateHolodeckPackageManifest(rest)).toEqual([]);
  });

  it('reports every problem at once', () => {
    const errors = validateHolodeckPackageManifest({
      schemaVersion: 'holodeck.package.v0',
      id: 'Holodeck AWS',
      name: '',
      version: '1.0',
      license: '',
      description: 5,
      contributes: ['holodeck.iso.part', 'holodeck.iso.part', 'Bad Kind'],
      engines: { 'Holodeck Iso': 'latest' },
      engine: { id: 'x', apiVersion: '1', documentFormat: '' },
      providers: ['a.b', 'a.b'],
      requires: { self: '^1', 'Bad Id': 'x' },
      entry: '../evil.js',
      assets: '/abs',
      permissions: { network: ['https://x.com/path'], camera: true },
      assetLicenses: [{ path: '/x', license: '' }, { path: 'ok', license: 'MIT', notice: 1 }],
      homepage: 1,
      keywords: [1],
      surprise: true,
    });
    expect(errors).toEqual(
      expect.arrayContaining([
        'surprise: unknown field',
        expect.stringMatching(/^schemaVersion/),
        expect.stringMatching(/^id:/),
        expect.stringMatching(/^name/),
        expect.stringMatching(/^version/),
        expect.stringMatching(/^license/),
        expect.stringMatching(/^description/),
        'contributes: "holodeck.iso.part" is listed twice',
        'contributes: "Bad Kind" is not a kind name such as "holodeck.iso.part"',
        'contributes: "holodeck.iso.part" needs an engines["holodeck.iso"] range',
        'engines: "Holodeck Iso" is not a dotted engine id',
        expect.stringMatching(/engines\.Holodeck Iso: unsupported/),
        'engine.apiVersion: must be MAJOR.MINOR.PATCH',
        'engine.documentFormat: must be a non-empty string',
        'providers: duplicate provider id',
        'providers: requires "holodeck.provider" in contributes',
        'requires: "Bad Id" is not a dotted package id',
        expect.stringMatching(/requires\.Bad Id: unsupported/),
        expect.stringMatching(/^entry/),
        expect.stringMatching(/^assets/),
        'permissions.camera: unknown permission',
        expect.stringMatching(/^permissions\.network/),
        'assetLicenses[0]: needs a relative path and a license',
        'assetLicenses[1].notice: must be a string',
        'homepage: must be a string',
        'keywords: must be an array of strings',
      ]),
    );
  });

  it('rejects self-requires, malformed shapes and non-objects', () => {
    expect(validateHolodeckPackageManifest(manifest({ requires: { 'holodeck.aws': '*' } }))).toEqual([
      'requires: a package cannot require itself',
    ]);
    expect(validateHolodeckPackageManifest(manifest({ contributes: 'holodeck.iso.part' as never }))[0]).toMatch(/contributes/);
    expect(validateHolodeckPackageManifest(manifest({ engines: [] as never })).join()).toMatch(/engines: must map/);
    expect(validateHolodeckPackageManifest(manifest({ engine: 'x' as never }))).toEqual(['engine: must be an object']);
    expect(validateHolodeckPackageManifest(manifest({ providers: 'x' as never }))[0]).toMatch(/providers/);
    expect(validateHolodeckPackageManifest(manifest({ requires: [] as never }))[0]).toMatch(/requires/);
    expect(validateHolodeckPackageManifest(manifest({ permissions: [] as never }))[0]).toMatch(/permissions/);
    expect(validateHolodeckPackageManifest(manifest({ assetLicenses: {} as never }))[0]).toMatch(/assetLicenses/);
    expect(validateHolodeckPackageManifest('x')).toEqual(['manifest: must be an object']);
  });

  it('parseHolodeckPackageManifest throws a HolodeckPackageError with details', () => {
    expect(parseHolodeckPackageManifest(manifest()).id).toBe('holodeck.aws');
    try {
      parseHolodeckPackageManifest({});
      expect.unreachable();
    } catch (error) {
      expect((error as Error).name).toBe('HolodeckPackageError');
      expect((error as { details: string[] }).details.length).toBeGreaterThan(3);
    }
  });
});

describe('kind names (GPT review sdk#23 r2 P1)', () => {
  it('accepts the exported camelCase flow kinds in contributes', () => {
    expect(
      validateHolodeckPackageManifest(
        manifest({
          contributes: [HOLODECK_KINDS.flowNodeType, HOLODECK_KINDS.flowEdgeType, HOLODECK_KINDS.flowPalette, HOLODECK_KINDS.flowBlock],
          engines: { 'holodeck.flow': '^1.0' },
        }),
      ),
    ).toEqual([]);
  });

  it('every exported kind is a valid kind name, and kind rules stay stricter than free text', () => {
    for (const kind of Object.values(HOLODECK_KINDS)) expect([kind, isKindName(kind)]).toEqual([kind, true]);
    for (const bad of ['Holodeck.iso.part', 'single', 'holodeck..part', 'holodeck.iso.', 'holodeck iso.part', 'holodeck.iso_part']) {
      expect([bad, isKindName(bad)]).toEqual([bad, false]);
    }
    expect(engineOfKind(HOLODECK_KINDS.flowNodeType)).toBe('holodeck.flow');
  });

  it('package and engine ids stay lowercase', () => {
    expect(validateHolodeckPackageManifest(manifest({ id: 'holodeck.Aws' }))[0]).toMatch(/^id:/);
  });
});

describe('packageRoles', () => {
  it('derives marketplace facets from the manifest in a fixed order', () => {
    expect(
      packageRoles(
        manifest({
          engine: { id: 'holodeck.iso', apiVersion: '1.0.0', documentFormat: 'f' },
          contributes: ['holodeck.document.check', 'holodeck.importer', 'holodeck.provider', 'holodeck.iso.part', 'holodeck.iso.theme'],
        }),
      ),
    ).toEqual(['engine', 'theme', 'library', 'provider', 'importer', 'check']);
    expect(packageRoles(manifest({ contributes: ['holodeck.iso.theme'] }))).toEqual(['theme']);
  });
});

describe('checkExtensionMatchesManifest', () => {
  const m = manifest({
    contributes: ['holodeck.iso.part', 'holodeck.provider'],
    providers: ['aws.cloudwatch'],
    permissions: { network: ['https://monitoring.*.amazonaws.com'] },
  });
  const provider = (id: string, origins?: string[]) => ({ id, label: id, capabilities: {}, connect: async () => ({}), ...(origins ? { origins } : {}) });

  it('accepts a matching extension (empty declared kinds are fine)', () => {
    expect(
      checkExtensionMatchesManifest(m, {
        id: 'holodeck.aws',
        version: '0.1.0',
        contributions: {
          'holodeck.provider': [provider('aws.cloudwatch', ['https://monitoring.eu-west-1.amazonaws.com'])],
          'holodeck.iso.theme': [],
        },
      }),
    ).toEqual([]);
  });

  it('reports id, version, undeclared kinds, provider ids and origins', () => {
    expect(
      checkExtensionMatchesManifest(m, {
        id: 'other',
        version: '9.9.9',
        contributions: {
          'holodeck.iso.theme': [{ id: 't' }],
          'holodeck.provider': [provider('aws.xray', ['https://evil.example'])],
        },
      }),
    ).toEqual([
      'extension id "other" differs from manifest id "holodeck.aws"',
      'extension version "9.9.9" differs from manifest version "0.1.0"',
      'extension contributes "holodeck.iso.theme" but the manifest does not declare it',
      'provider "aws.xray" is not listed in manifest.providers',
      'provider "aws.xray" origin "https://evil.example" is not in permissions.network',
      'manifest.providers lists "aws.cloudwatch" but the extension has no such provider',
    ]);
  });
});

describe('defineHolodeckPackage', () => {
  it('returns the module unchanged', () => {
    const mod = { createExtension: () => ({ id: 'a', version: '1.0.0', contributions: {} }) };
    expect(defineHolodeckPackage(mod)).toBe(mod);
  });
});

describe('example manifests and JSON Schema stay in sync with the validator', () => {
  const root = join(__dirname, '..', '..');
  const schema = JSON.parse(readFileSync(join(root, 'schema', 'holodeck-package.v1.schema.json'), 'utf8')) as {
    properties: Record<string, unknown>;
    required: string[];
  };

  it('every example holodeck.package.json validates', () => {
    const dir = join(root, 'examples', 'packages');
    const files = readdirSync(dir).filter((f) => f.endsWith('.holodeck.package.json'));
    expect(files.length).toBeGreaterThanOrEqual(3);
    for (const f of files) {
      expect([f, validateHolodeckPackageManifest(JSON.parse(readFileSync(join(dir, f), 'utf8')))]).toEqual([f, []]);
    }
  });

  it('schema properties match the validator field set', () => {
    expect(Object.keys(schema.properties).sort()).toEqual([...HOLODECK_PACKAGE_MANIFEST_FIELDS].sort());
    expect(schema.required.sort()).toEqual(['contributes', 'entry', 'id', 'license', 'name', 'schemaVersion', 'version']);
    expect(validateHolodeckPackageManifest({ ...manifest(), extra: 1 })).toEqual(['extra: unknown field']);
  });
});
