import { describe, expect, it, vi } from 'vitest';
import { HOLODECK_DOCUMENT_FORMAT, type HolodeckDocument } from './document';
import { validateEngine, type HolodeckEngine } from './engine';
import { HolodeckHost, HolodeckHostError, USER_OWNER } from './host';
import { HOLODECK_PACKAGE_SCHEMA, defineHolodeckPackage, type HolodeckPackageManifest } from './package';
import { createSimProvider } from './provider';
import { ContributionRegistry, type Contribution, type ContributionKind, type HolodeckExtension } from './registry';

const partKind: ContributionKind<Contribution & { label: string }> = {
  kind: 'holodeck.iso.part',
  validate: (x): x is Contribution & { label: string } => typeof (x as { label?: unknown }).label === 'string',
};
const themeKind: ContributionKind = { kind: 'holodeck.iso.theme' };

const isoEngine = (apiVersion = '1.2.0'): HolodeckEngine<{ objects: Array<{ id: string; bindings?: Record<string, { connection: string; source: string }> }> }> => ({
  id: 'holodeck.iso',
  label: 'Iso',
  apiVersion,
  documentFormat: 'holodeck.iso.scene.v1',
  kinds: [partKind, themeKind],
  collectBindings: (body) =>
    body.objects.flatMap((o) => Object.entries(o.bindings ?? {}).map(([param, binding]) => ({ objectId: o.id, param, binding }))),
  validateBody: (body) => (Array.isArray((body as { objects?: unknown }).objects) ? [] : ['objects: must be an array']),
});

const manifest = (over: Partial<HolodeckPackageManifest> = {}): HolodeckPackageManifest => ({
  schemaVersion: HOLODECK_PACKAGE_SCHEMA,
  id: 'holodeck.cloud',
  name: 'Cloud',
  version: '0.1.0',
  license: 'MIT',
  contributes: ['holodeck.iso.part'],
  engines: { 'holodeck.iso': '^1.0' },
  entry: 'dist/index.js',
  assets: 'assets',
  ...over,
});

const ext = (id: string, version: string, contributions: HolodeckExtension['contributions']): HolodeckExtension => ({
  id,
  version,
  contributions,
});

describe('HolodeckHost', () => {
  it('registers the host kinds once and adopts them on a shared registry', () => {
    const registry = new ContributionRegistry();
    const a = new HolodeckHost({ name: 'a', registry });
    expect(['holodeck.provider', 'holodeck.importer', 'holodeck.document.check'].every((k) => a.registry.hasKind(k))).toBe(true);
    expect(() => new HolodeckHost({ name: 'b', registry })).not.toThrow();
    expect(new HolodeckHost({ name: 'c' }).registry).not.toBe(registry);
  });

  describe('engines', () => {
    it('registers an engine and its kinds; unregistering removes only kinds it registered', () => {
      const host = new HolodeckHost({ name: 't' });
      host.registry.registerKind(themeKind); // pre-engine code registered this kind itself
      const off = host.registerEngine(isoEngine());
      expect(host.engine('holodeck.iso')?.apiVersion).toBe('1.2.0');
      expect(host.engines()).toHaveLength(1);
      expect(host.registry.hasKind('holodeck.iso.part')).toBe(true);
      off();
      off();
      expect(host.engine('holodeck.iso')).toBeUndefined();
      expect(host.registry.hasKind('holodeck.iso.part')).toBe(false);
      expect(host.registry.hasKind('holodeck.iso.theme')).toBe(true);
    });

    it('rejects invalid and duplicate engines', () => {
      const host = new HolodeckHost({ name: 't' });
      expect(() => host.registerEngine({ ...isoEngine(), kinds: [{ kind: 'holodeck.flow.block' }] })).toThrow(
        expect.objectContaining({ code: 'INVALID_ENGINE' }),
      );
      host.registerEngine(isoEngine());
      expect(() => host.registerEngine(isoEngine())).toThrow(expect.objectContaining({ code: 'DUPLICATE_ENGINE' }));
    });

    it('refuses an engine whose apiVersion breaks an installed package', async () => {
      const host = new HolodeckHost({ name: 't' });
      await host.installPackage(manifest(), ext('holodeck.cloud', '0.1.0', { 'holodeck.iso.part': [{ id: 'server', label: 'S' } as Contribution] }));
      expect(() => host.registerEngine(isoEngine('2.0.0'))).toThrow(
        expect.objectContaining({ code: 'ENGINE_INCOMPATIBLE', details: ['holodeck.cloud needs holodeck.iso ^1.0'] }),
      );
      expect(host.registry.hasKind('holodeck.iso.part')).toBe(false);
    });

    it('undoes its kinds when a pending item fails validation on registration', async () => {
      const host = new HolodeckHost({ name: 't' });
      await host.installPackage(
        manifest({ contributes: ['holodeck.iso.part', 'holodeck.iso.theme'] }),
        ext('holodeck.cloud', '0.1.0', { 'holodeck.iso.theme': [{ id: 'light' }], 'holodeck.iso.part': [{ id: 'bad' }] }),
      );
      expect(() => host.registerEngine({ ...isoEngine(), kinds: [themeKind, partKind] })).toThrow();
      expect(host.registry.hasKind('holodeck.iso.theme')).toBe(false);
      expect(host.engine('holodeck.iso')).toBeUndefined();
    });

    it('validateEngine reports every descriptor problem', () => {
      expect(validateEngine(isoEngine())).toEqual([]);
      expect(validateEngine(null)).toEqual(['engine: must be an object']);
      expect(
        validateEngine({ id: 'Iso', label: '', apiVersion: '1', documentFormat: '', kinds: 'x', collectBindings: 1, validateBody: 'x' }),
      ).toHaveLength(7);
      expect(validateEngine({ ...isoEngine(), kinds: [partKind, partKind, { kind: 7 }] })).toEqual([
        'kinds[1]: "holodeck.iso.part" is listed twice',
        'kinds[2]: must be a contribution kind named like "holodeck.iso.part"',
      ]);
    });
  });

  describe('packages', () => {
    it('installs from an entry module with an asset resolver and reports pending engines', async () => {
      const host = new HolodeckHost({ name: 'studio' });
      const seen: string[] = [];
      const module = defineHolodeckPackage({
        manifest: manifest(),
        createExtension: async (ctx) => {
          seen.push(ctx.host, ctx.assetUrl('models/server.glb'));
          return ext('holodeck.cloud', '0.1.0', { 'holodeck.iso.part': [{ id: 'server', label: 'Server' } as Contribution] });
        },
      });
      const report = await host.installPackage(manifest(), module, {
        manifestUrl: 'https://cdn.example/holodeck-cloud/0.1.0/holodeck.package.json',
        owner: 'acme.bundle',
      });
      expect(seen).toEqual(['studio', 'https://cdn.example/holodeck-cloud/0.1.0/assets/models/server.glb']);
      expect(report).toEqual({
        packageId: 'holodeck.cloud',
        shared: false,
        install: { extensionId: 'holodeck.cloud', installed: {}, pending: ['holodeck.iso.part'] },
        unresolvedEngines: ['holodeck.iso'],
      });
      expect(host.package('holodeck.cloud')).toEqual({ manifest: manifest(), owners: ['acme.bundle'] });
      host.registerEngine(isoEngine());
      expect(host.registry.list('holodeck.iso.part')).toHaveLength(1);
    });

    it('uses an explicit assetBase, and errors when a package asks for assets without one', async () => {
      const host = new HolodeckHost({ name: 't' });
      const urls: string[] = [];
      await host.installPackage(
        manifest(),
        { createExtension: (ctx) => (urls.push(ctx.assetUrl('a.svg')), ext('holodeck.cloud', '0.1.0', {})) },
        { assetBase: 'https://x/assets' },
      );
      expect(urls).toEqual(['https://x/assets/a.svg']);
      await expect(
        host.installPackage(manifest({ id: 'holodeck.b' }), { createExtension: (ctx) => (ctx.assetUrl('a.svg'), ext('holodeck.b', '0.1.0', {})) }),
      ).rejects.toThrow(/no assetBase or manifestUrl/);
      expect(host.package('holodeck.b')).toBeUndefined();
    });

    it('rejects invalid manifests, duplicates and concurrent installs of the same id', async () => {
      const host = new HolodeckHost({ name: 't' });
      await expect(host.installPackage({ id: 'x' }, ext('x', '1.0.0', {}))).rejects.toMatchObject({ code: 'INVALID_MANIFEST' });
      let release: () => void = () => {};
      const gate = new Promise<void>((r) => (release = r));
      const first = host.installPackage(manifest(), { createExtension: async () => (await gate, ext('holodeck.cloud', '0.1.0', {})) });
      await expect(host.installPackage(manifest(), ext('holodeck.cloud', '0.1.0', {}))).rejects.toMatchObject({ code: 'DUPLICATE_PACKAGE' });
      release();
      await first;
      await expect(host.installPackage(manifest(), ext('holodeck.cloud', '0.1.0', {}))).rejects.toMatchObject({ code: 'DUPLICATE_PACKAGE' });
    });

    it('checks requires (missing and wrong version)', async () => {
      const host = new HolodeckHost({ name: 't' });
      const aws = manifest({ id: 'holodeck.aws', requires: { 'holodeck.cloud': '^0.2' } });
      await expect(host.installPackage(aws, ext('holodeck.aws', '0.1.0', {}))).rejects.toMatchObject({
        code: 'MISSING_REQUIREMENT',
        details: ['holodeck.cloud ^0.2 is not installed'],
      });
      await host.installPackage(manifest(), ext('holodeck.cloud', '0.1.0', {}));
      await expect(host.installPackage(aws, ext('holodeck.aws', '0.1.0', {}))).rejects.toMatchObject({
        details: ['holodeck.cloud ^0.2 is required, 0.1.0 is installed'],
      });
      expect(host.package('holodeck.aws')).toBeUndefined();
    });

    it('rejects packages for an incompatible registered engine', async () => {
      const host = new HolodeckHost({ name: 't' });
      host.registerEngine(isoEngine('2.0.0'));
      await expect(host.installPackage(manifest(), ext('holodeck.cloud', '0.1.0', {}))).rejects.toMatchObject({
        code: 'ENGINE_INCOMPATIBLE',
        details: ['holodeck.iso ^1.0 is required, 2.0.0 is registered'],
      });
    });

    it('rejects extensions that disagree with the manifest, including an embedded manifest', async () => {
      const host = new HolodeckHost({ name: 't' });
      await expect(
        host.installPackage(manifest(), ext('holodeck.cloud', '0.1.0', { 'holodeck.iso.theme': [{ id: 't' }] })),
      ).rejects.toMatchObject({ code: 'MANIFEST_MISMATCH' });
      await expect(
        host.installPackage(manifest(), {
          manifest: manifest({ version: '0.2.0' }),
          createExtension: () => ext('holodeck.cloud', '0.1.0', {}),
        }),
      ).rejects.toMatchObject({ details: ['the entry module embeds a manifest for a different id or version'] });
    });

    it('propagates registry errors without recording the package', async () => {
      const host = new HolodeckHost({ name: 't' });
      host.registerEngine(isoEngine());
      await expect(
        host.installPackage(manifest(), ext('holodeck.cloud', '0.1.0', { 'holodeck.iso.part': [{ id: 'nolabel' }] })),
      ).rejects.toMatchObject({ code: 'INVALID_ITEM' });
      expect(host.packages()).toEqual([]);
    });

    it('records a package whose install committed even though a hook threw', async () => {
      const host = new HolodeckHost({ name: 't' });
      host.registry.registerKind({
        kind: 'holodeck.iso.part',
        onInstall: () => {
          throw new Error('hook');
        },
        onUninstall: () => {
          throw new Error('unhook');
        },
      });
      await expect(host.installPackage(manifest(), ext('holodeck.cloud', '0.1.0', { 'holodeck.iso.part': [{ id: 'x' }] }))).rejects.toBeInstanceOf(
        AggregateError,
      );
      expect(host.package('holodeck.cloud')).toBeDefined();
      expect(() => host.uninstallPackage('holodeck.cloud')).toThrow(AggregateError);
      expect(host.package('holodeck.cloud')).toBeUndefined();
    });

    it('uninstall refuses while required, and for unknown ids', async () => {
      const host = new HolodeckHost({ name: 't' });
      await host.installPackage(manifest(), ext('holodeck.cloud', '0.1.0', {}));
      await host.installPackage(manifest({ id: 'holodeck.aws', requires: { 'holodeck.cloud': '^0.1' } }), ext('holodeck.aws', '0.1.0', {}));
      expect(() => host.uninstallPackage('holodeck.cloud')).toThrow(
        expect.objectContaining({ code: 'REQUIRED_BY', details: ['holodeck.aws requires holodeck.cloud'] }),
      );
      expect(host.uninstallPackage('holodeck.aws')).toEqual({ removed: ['holodeck.aws'], kept: [] });
      expect(host.uninstallPackage('holodeck.cloud')).toEqual({ removed: ['holodeck.cloud'], kept: [] });
      expect(host.packages()).toEqual([]);
      expect(() => host.uninstallPackage('holodeck.cloud')).toThrow(expect.objectContaining({ code: 'UNKNOWN_PACKAGE' }));
    });

    it('uninstallOwnedBy removes an owner set dependents-first', async () => {
      const host = new HolodeckHost({ name: 'hyperdrive-ui' });
      const owner = 'acme.extension';
      await host.installPackage(manifest(), ext('holodeck.cloud', '0.1.0', {}), { owner });
      await host.installPackage(manifest({ id: 'acme.a', requires: { 'holodeck.cloud': '*' } }), ext('acme.a', '0.1.0', {}), { owner });
      await host.installPackage(manifest({ id: 'acme.b', requires: { 'acme.a': '*' } }), ext('acme.b', '0.1.0', {}), { owner });
      expect(host.uninstallOwnedBy(owner)).toEqual({ removed: ['acme.b', 'acme.a', 'holodeck.cloud'], kept: [] });
      expect(host.packages()).toEqual([]);
      expect(host.uninstallOwnedBy('nobody')).toEqual({ removed: [], kept: [] });
    });

    it('shares a package between the user and extensions; it leaves with its last owner', async () => {
      const host = new HolodeckHost({ name: 't' });
      expect((await host.installPackage(manifest(), ext('holodeck.cloud', '0.1.0', {}))).shared).toBe(false);
      const a = await host.installPackage(manifest(), ext('holodeck.cloud', '0.1.0', {}), { owner: 'ext.a', range: '^0.1' });
      // r5 P2: a shared install reports the same pending engines a fresh one would
      expect(a).toEqual({ packageId: 'holodeck.cloud', shared: true, unresolvedEngines: ['holodeck.iso'] });
      await host.installPackage(manifest(), ext('holodeck.cloud', '0.1.0', {}), { owner: 'ext.b' });
      expect(host.package('holodeck.cloud')?.owners).toEqual([USER_OWNER, 'ext.a', 'ext.b']);
      expect(host.uninstallOwnedBy('ext.a')).toEqual({ removed: [], kept: ['holodeck.cloud'] });
      expect(host.uninstallPackage('holodeck.cloud')).toEqual({ removed: [], kept: ['holodeck.cloud'] });
      expect(host.registry.installedExtensions().map((e) => e.id)).toEqual(['holodeck.cloud']);
      expect(host.uninstallOwnedBy('ext.b')).toEqual({ removed: ['holodeck.cloud'], kept: [] });
      expect(host.registry.installedExtensions()).toEqual([]);
    });

    it('two extensions embedding the same pair: removing one keeps both packages', async () => {
      const host = new HolodeckHost({ name: 't' });
      const y = manifest({ id: 'holodeck.y', requires: { 'holodeck.cloud': '^0.1' } });
      for (const owner of ['ext.a', 'ext.b']) {
        await host.installPackage(manifest(), ext('holodeck.cloud', '0.1.0', {}), { owner });
        await host.installPackage(y, ext('holodeck.y', '0.1.0', {}), { owner });
      }
      expect(host.uninstallOwnedBy('ext.a')).toEqual({ removed: [], kept: ['holodeck.cloud', 'holodeck.y'] });
      expect(host.uninstallOwnedBy('ext.b')).toEqual({ removed: ['holodeck.y', 'holodeck.cloud'], kept: [] });
    });

    it('keeps an ownerless package alive while an installed package requires it', async () => {
      const host = new HolodeckHost({ name: 't' });
      await host.installPackage(manifest(), ext('holodeck.cloud', '0.1.0', {}), { owner: 'ext.a' });
      await host.installPackage(manifest({ id: 'user.y', requires: { 'holodeck.cloud': '*' } }), ext('user.y', '0.1.0', {}));
      expect(host.uninstallOwnedBy('ext.a')).toEqual({ removed: [], kept: ['holodeck.cloud'] });
      expect(host.package('holodeck.cloud')?.owners).toEqual([]);
      expect(() => host.uninstallPackage('holodeck.cloud')).toThrow(expect.objectContaining({ code: 'NOT_OWNER' }));
      expect(host.uninstallPackage('user.y')).toEqual({ removed: ['user.y', 'holodeck.cloud'], kept: [] });
    });

    it('refuses a user uninstall of a package only extensions own', async () => {
      const host = new HolodeckHost({ name: 't' });
      await host.installPackage(manifest(), ext('holodeck.cloud', '0.1.0', {}), { owner: 'ext.a' });
      expect(() => host.uninstallPackage('holodeck.cloud')).toThrow(
        expect.objectContaining({ code: 'NOT_OWNER', details: ['owned by ext.a'] }),
      );
    });

    it('reports VERSION_CONFLICT instead of upgrading or installing side by side', async () => {
      const host = new HolodeckHost({ name: 't' });
      await host.installPackage(manifest(), ext('holodeck.cloud', '0.1.0', {}));
      const v2 = manifest({ version: '2.1.0' });
      await expect(host.installPackage(v2, ext('holodeck.cloud', '2.1.0', {}), { owner: 'ext.a', range: '^2.0' })).rejects.toMatchObject({
        code: 'VERSION_CONFLICT',
        details: [`holodeck.cloud 0.1.0 is installed (owners: ${USER_OWNER})`, 'ext.a needs holodeck.cloud ^2.0'],
      });
      await expect(host.installPackage(v2, ext('holodeck.cloud', '2.1.0', {}), { owner: 'ext.b' })).rejects.toMatchObject({
        code: 'VERSION_CONFLICT',
        details: [`holodeck.cloud 0.1.0 is installed (owners: ${USER_OWNER})`, 'ext.b needs holodeck.cloud 2.1.0'],
      });
      expect(host.package('holodeck.cloud')?.owners).toEqual([USER_OWNER]);
      await expect(
        host.installPackage(manifest({ id: 'holodeck.new' }), ext('holodeck.new', '0.1.0', {}), { owner: 'ext.a', range: '^1.0' }),
      ).rejects.toMatchObject({ code: 'VERSION_CONFLICT', details: ['ext.a needs holodeck.new ^1.0, offered 0.1.0'] });
      await expect(host.installPackage(manifest({ id: 'holodeck.new' }), ext('holodeck.new', '0.1.0', {}), { range: 'latest' })).rejects.toMatchObject({
        code: 'INVALID_MANIFEST',
      });
    });

    it('rejects the same owner installing a package twice', async () => {
      const host = new HolodeckHost({ name: 't' });
      await host.installPackage(manifest(), ext('holodeck.cloud', '0.1.0', {}), { owner: 'ext.a' });
      await expect(host.installPackage(manifest(), ext('holodeck.cloud', '0.1.0', {}), { owner: 'ext.a' })).rejects.toMatchObject({
        code: 'DUPLICATE_PACKAGE',
        details: ['ext.a already owns holodeck.cloud 0.1.0'],
      });
    });

    it('uninstallOwnedBy finishes the set and reports hook failures together', async () => {
      const host = new HolodeckHost({ name: 't' });
      host.registry.registerKind({
        kind: 'holodeck.iso.part',
        onUninstall: () => {
          throw new Error('unhook');
        },
      });
      await host.installPackage(manifest(), ext('holodeck.cloud', '0.1.0', { 'holodeck.iso.part': [{ id: 'a' }] }), { owner: 'o' });
      await host.installPackage(manifest({ id: 'holodeck.x' }), ext('holodeck.x', '0.1.0', { 'holodeck.iso.part': [{ id: 'b' }] }), { owner: 'o' });
      expect(() => host.uninstallOwnedBy('o')).toThrow(AggregateError);
      expect(host.packages()).toEqual([]);
    });
  });

  describe('GPT review sdk#23 regressions', () => {
    const gated = (id: string, version = '0.1.0') => {
      let release: () => void = () => {};
      const gate = new Promise<void>((r) => (release = r));
      const theExt = ext(id, version, {});
      return { module: { createExtension: async () => (await gate, theExt) }, release, ext: theExt };
    };

    it('P1: rechecks requires after an async factory (dependency removed meanwhile)', async () => {
      const host = new HolodeckHost({ name: 't' });
      await host.installPackage(manifest(), ext('holodeck.cloud', '0.1.0', {}));
      const g = gated('holodeck.aws');
      const pending = host.installPackage(manifest({ id: 'holodeck.aws', requires: { 'holodeck.cloud': '^0.1' } }), g.module);
      host.uninstallPackage('holodeck.cloud');
      g.release();
      await expect(pending).rejects.toMatchObject({ code: 'MISSING_REQUIREMENT', details: ['holodeck.cloud ^0.1 is not installed'] });
      expect(host.package('holodeck.aws')).toBeUndefined();
      expect(host.registry.installedExtensions()).toEqual([]);
    });

    it('P1: rechecks engine compatibility after an async factory (incompatible engine registered meanwhile)', async () => {
      const host = new HolodeckHost({ name: 't' });
      const g = gated('holodeck.cloud');
      const pending = host.installPackage(manifest(), g.module);
      host.registerEngine(isoEngine('2.0.0'));
      g.release();
      await expect(pending).rejects.toMatchObject({
        code: 'ENGINE_INCOMPATIBLE',
        details: ['holodeck.iso ^1.0 is required, 2.0.0 is registered'],
      });
      expect(host.package('holodeck.cloud')).toBeUndefined();
    });

    it('P1: never claims an extension installed outside the host', async () => {
      const registry = new ContributionRegistry();
      const foreign = ext('holodeck.cloud', '9.9.9', {});
      registry.install(foreign);
      const host = new HolodeckHost({ name: 't', registry });
      await expect(host.installPackage(manifest(), ext('holodeck.cloud', '0.1.0', {}))).rejects.toMatchObject({
        code: 'DUPLICATE_PACKAGE',
      });
      expect(host.package('holodeck.cloud')).toBeUndefined();
      expect(() => host.uninstallPackage('holodeck.cloud')).toThrow(expect.objectContaining({ code: 'UNKNOWN_PACKAGE' }));
      expect(host.uninstallOwnedBy(USER_OWNER).removed).toEqual([]);
      expect(registry.installedExtensions()).toEqual([foreign]);
    });

    it('P1: an outside install racing an async factory is not recorded either', async () => {
      const registry = new ContributionRegistry();
      const host = new HolodeckHost({ name: 't', registry });
      const g = gated('holodeck.cloud');
      const pending = host.installPackage(manifest(), g.module);
      const foreign = ext('holodeck.cloud', '9.9.9', {});
      registry.install(foreign);
      g.release();
      await expect(pending).rejects.toMatchObject({ code: 'DUPLICATE_PACKAGE' });
      expect(host.package('holodeck.cloud')).toBeUndefined();
      expect(registry.installedExtensions()).toEqual([foreign]);
    });

    it('P2: a throwing replay hook unwinds every kind of the engine, and a retry uses the new definitions', async () => {
      const host = new HolodeckHost({ name: 't' });
      await host.installPackage(
        manifest({ contributes: ['holodeck.iso.part', 'holodeck.iso.theme'] }),
        ext('holodeck.cloud', '0.1.0', { 'holodeck.iso.theme': [{ id: 'light' }], 'holodeck.iso.part': [{ id: 'p', label: 'P' } as Contribution] }),
      );
      const throwingTheme: ContributionKind = {
        kind: 'holodeck.iso.theme',
        onInstall: () => {
          throw new Error('replay hook');
        },
      };
      expect(() => host.registerEngine({ ...isoEngine(), kinds: [partKind, throwingTheme] })).toThrow(AggregateError);
      expect(host.engine('holodeck.iso')).toBeUndefined();
      expect(host.registry.hasKind('holodeck.iso.part')).toBe(false);
      expect(host.registry.hasKind('holodeck.iso.theme')).toBe(false);
      const seen: string[] = [];
      const goodTheme: ContributionKind = { kind: 'holodeck.iso.theme', onInstall: (items) => seen.push(...items.map((i) => i.id)) };
      host.registerEngine({ ...isoEngine(), kinds: [partKind, goodTheme] });
      expect(seen).toEqual(['light']);
      expect(host.registry.list('holodeck.iso.part')).toHaveLength(1);
    });
  });

  describe('GPT review sdk#23 r2 regressions', () => {
    it('P1: an engine and packages may use the exported camelCase flow kinds', async () => {
      const host = new HolodeckHost({ name: 't' });
      const flowEngine: HolodeckEngine = {
        id: 'holodeck.flow',
        label: 'Flow',
        apiVersion: '1.0.0',
        documentFormat: 'holodeck.flow.graph.v1',
        kinds: [{ kind: 'holodeck.flow.nodeType' }, { kind: 'holodeck.flow.edgeType' }],
      };
      expect(validateEngine(flowEngine)).toEqual([]);
      host.registerEngine(flowEngine);
      await host.installPackage(
        manifest({ id: 'acme.nodes', contributes: ['holodeck.flow.nodeType', 'holodeck.flow.edgeType'], engines: { 'holodeck.flow': '^1.0' } }),
        ext('acme.nodes', '0.1.0', { 'holodeck.flow.nodeType': [{ id: 'acme:block' }], 'holodeck.flow.edgeType': [{ id: 'acme:wire' }] }),
      );
      expect(host.registry.list('holodeck.flow.nodeType')).toHaveLength(1);
    });

    it('P2: an install hook cannot remove a package the committing package requires', async () => {
      const host = new HolodeckHost({ name: 't' });
      await host.installPackage(manifest(), ext('holodeck.cloud', '0.1.0', {}));
      let hookError: unknown;
      host.registry.registerKind({
        kind: 'holodeck.iso.theme',
        onInstall: (_items, extensionId) => {
          if (extensionId !== 'holodeck.aws') return;
          try {
            host.uninstallPackage('holodeck.cloud');
          } catch (error) {
            hookError = error;
          }
        },
      });
      await host.installPackage(
        manifest({ id: 'holodeck.aws', contributes: ['holodeck.iso.theme'], requires: { 'holodeck.cloud': '^0.1' } }),
        ext('holodeck.aws', '0.1.0', { 'holodeck.iso.theme': [{ id: 'aws-theme' }] }),
      );
      expect(hookError).toMatchObject({ code: 'BUSY' });
      expect(host.package('holodeck.cloud')).toBeDefined();
      expect(host.package('holodeck.aws')).toBeDefined();
    });

    it('P2: an uninstall hook cannot install a package requiring the one being removed, or share or re-remove it', async () => {
      const host = new HolodeckHost({ name: 't' });
      const attempts: Array<Promise<unknown>> = [];
      const sync: unknown[] = [];
      host.registry.registerKind({
        kind: 'holodeck.iso.theme',
        onUninstall: (_items, extensionId) => {
          if (extensionId !== 'holodeck.cloud') return;
          attempts.push(
            host.installPackage(
              manifest({ id: 'holodeck.aws', requires: { 'holodeck.cloud': '^0.1' }, contributes: ['holodeck.iso.part'] }),
              ext('holodeck.aws', '0.1.0', {}),
            ),
            host.installPackage(manifest({ contributes: ['holodeck.iso.theme'] }), ext('holodeck.cloud', '0.1.0', {}), { owner: 'ext.x' }),
          );
          try {
            host.uninstallPackage('holodeck.cloud');
          } catch (error) {
            sync.push(error);
          }
        },
      });
      await host.installPackage(manifest({ contributes: ['holodeck.iso.theme'] }), ext('holodeck.cloud', '0.1.0', { 'holodeck.iso.theme': [{ id: 't' }] }));
      expect(host.uninstallPackage('holodeck.cloud')).toEqual({ removed: ['holodeck.cloud'], kept: [] });
      const [requiring, sharing] = await Promise.allSettled(attempts);
      expect(requiring).toMatchObject({ status: 'rejected', reason: { code: 'BUSY' } });
      expect(sharing).toMatchObject({ status: 'rejected', reason: { code: 'BUSY' } });
      expect(sync).toEqual([expect.objectContaining({ code: 'BUSY' })]);
      expect(host.packages()).toEqual([]);
      expect(host.registry.installedExtensions()).toEqual([]);
    });

    it('P2: unregistering an engine removes every kind even when a callback throws; a replacement validator applies', async () => {
      const host = new HolodeckHost({ name: 't' });
      const off = host.registerEngine(isoEngine());
      host.registry.subscribe((change) => {
        if (change.type === 'kind-unregistered' && change.kind === 'holodeck.iso.part') throw new Error('subscriber');
      });
      expect(() => off()).toThrow(AggregateError);
      expect(host.engine('holodeck.iso')).toBeUndefined();
      expect(host.registry.hasKind('holodeck.iso.part')).toBe(false);
      expect(host.registry.hasKind('holodeck.iso.theme')).toBe(false);
      // A pending item that the replacement's validator rejects must now be validated, not silently adopted.
      await host.installPackage(manifest(), ext('holodeck.cloud', '0.1.0', { 'holodeck.iso.part': [{ id: 'nolabel' }] }));
      expect(() => host.registerEngine(isoEngine())).toThrow(expect.objectContaining({ code: 'INVALID_ITEM' }));
    });

    it('P2: rollback runs every cleanup and reports cleanup failures with the original error', async () => {
      const host = new HolodeckHost({ name: 't' });
      await host.installPackage(
        manifest({ contributes: ['holodeck.iso.part', 'holodeck.iso.theme'] }),
        ext('holodeck.cloud', '0.1.0', { 'holodeck.iso.part': [{ id: 'nolabel' }] }),
      );
      host.registry.subscribe((change) => {
        if (change.type === 'kind-unregistered') throw new Error('cleanup subscriber');
      });
      let thrown: unknown;
      try {
        host.registerEngine({ ...isoEngine(), kinds: [themeKind, partKind] });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(AggregateError);
      expect((thrown as AggregateError).errors[0]).toMatchObject({ code: 'INVALID_ITEM' });
      expect(host.registry.hasKind('holodeck.iso.theme')).toBe(false);
      expect(host.engine('holodeck.iso')).toBeUndefined();
    });
  });

  describe('GPT review sdk#23 r3 regressions (host mutation lock)', () => {
    it('P1: an install hook cannot register an engine incompatible with the committing package', async () => {
      const host = new HolodeckHost({ name: 't' });
      let hookError: unknown;
      host.registry.registerKind({
        kind: 'holodeck.iso.theme',
        onInstall: () => {
          try {
            host.registerEngine(isoEngine('2.0.0'));
          } catch (error) {
            hookError = error;
          }
        },
      });
      await host.installPackage(manifest({ contributes: ['holodeck.iso.theme'] }), ext('holodeck.cloud', '0.1.0', { 'holodeck.iso.theme': [{ id: 't' }] }));
      expect(hookError).toMatchObject({ code: 'BUSY' });
      expect(host.engine('holodeck.iso')).toBeUndefined();
      expect(() => host.registerEngine(isoEngine('2.0.0'))).toThrow(expect.objectContaining({ code: 'ENGINE_INCOMPATIBLE' }));
    });

    it('P1: an engine replay hook cannot install a package incompatible with the registering engine', async () => {
      const host = new HolodeckHost({ name: 't' });
      await host.installPackage(manifest({ contributes: ['holodeck.iso.theme'] }), ext('holodeck.cloud', '0.1.0', { 'holodeck.iso.theme': [{ id: 't' }] }));
      let attempt: Promise<unknown> | undefined;
      const theme: ContributionKind = {
        kind: 'holodeck.iso.theme',
        onInstall: () => {
          attempt = host.installPackage(manifest({ id: 'holodeck.v3', engines: { 'holodeck.iso': '^3.0' } }), ext('holodeck.v3', '0.1.0', {}));
        },
      };
      host.registerEngine({ ...isoEngine('1.2.0'), kinds: [partKind, theme] });
      await expect(attempt).rejects.toMatchObject({ code: 'BUSY' });
      expect(host.package('holodeck.v3')).toBeUndefined();
    });

    it('P2: a subscriber cannot replace an engine during its teardown; every old kind is removed first', () => {
      const host = new HolodeckHost({ name: 't' });
      const off = host.registerEngine(isoEngine());
      let replaceError: unknown;
      const unsubscribe = host.registry.subscribe((change) => {
        if (change.type !== 'kind-unregistered' || change.kind !== 'holodeck.iso.part') return;
        try {
          host.registerEngine(isoEngine('1.3.0'));
        } catch (error) {
          replaceError = error;
        }
      });
      off();
      unsubscribe();
      expect(replaceError).toMatchObject({ code: 'BUSY' });
      expect(host.registry.hasKind('holodeck.iso.part')).toBe(false);
      expect(host.registry.hasKind('holodeck.iso.theme')).toBe(false);
      host.registerEngine(isoEngine('1.3.0'));
      expect(host.engine('holodeck.iso')?.apiVersion).toBe('1.3.0');
      expect(host.registry.hasKind('holodeck.iso.theme')).toBe(true);
    });

    it('P2: an install hook cannot release the committing package\'s owner', async () => {
      const host = new HolodeckHost({ name: 't' });
      let hookError: unknown;
      host.registry.registerKind({
        kind: 'holodeck.iso.theme',
        onInstall: () => {
          try {
            host.uninstallOwnedBy('ext.a');
          } catch (error) {
            hookError = error;
          }
        },
      });
      await host.installPackage(manifest({ contributes: ['holodeck.iso.theme'] }), ext('holodeck.cloud', '0.1.0', { 'holodeck.iso.theme': [{ id: 't' }] }), {
        owner: 'ext.a',
      });
      expect(hookError).toMatchObject({ code: 'BUSY' });
      expect(host.uninstallOwnedBy('ext.a')).toEqual({ removed: ['holodeck.cloud'], kept: [] });
    });

    it('P2: removing an owner cancels its installs still awaiting their entry module', async () => {
      const host = new HolodeckHost({ name: 't' });
      let release: () => void = () => {};
      const gate = new Promise<void>((r) => (release = r));
      const pending = host.installPackage(manifest(), { createExtension: async () => (await gate, ext('holodeck.cloud', '0.1.0', {})) }, { owner: 'ext.a' });
      expect(host.uninstallOwnedBy('ext.a')).toEqual({ removed: [], kept: [] });
      release();
      await expect(pending).rejects.toMatchObject({ code: 'CANCELLED', details: ['its owner ext.a was removed meanwhile'] });
      expect(host.packages()).toEqual([]);
      expect(host.registry.installedExtensions()).toEqual([]);
      // a different owner's pending install is unaffected
      const other = host.installPackage(manifest(), { createExtension: async () => ext('holodeck.cloud', '0.1.0', {}) }, { owner: 'ext.b' });
      host.uninstallOwnedBy('ext.a');
      await expect(other).resolves.toMatchObject({ shared: false });
    });

    it('read-only calls are allowed inside hooks', async () => {
      const host = new HolodeckHost({ name: 't' });
      const seen: number[] = [];
      host.registry.registerKind({ kind: 'holodeck.iso.theme', onInstall: () => seen.push(host.packages().length, host.engines().length) });
      await host.installPackage(manifest({ contributes: ['holodeck.iso.theme'] }), ext('holodeck.cloud', '0.1.0', { 'holodeck.iso.theme': [{ id: 't' }] }));
      expect(seen).toEqual([0, 0]);
    });
  });

  describe('GPT review sdk#23 r4 regressions (manifest snapshots)', () => {
    it('P1: mutating the caller\'s manifest after install changes nothing', async () => {
      const host = new HolodeckHost({ name: 't' });
      const m = manifest({ requires: undefined });
      await host.installPackage(m, ext('holodeck.cloud', '0.1.0', {}));
      m.version = '2.5.0';
      m.engines = { 'holodeck.iso': '^9.0' };
      await expect(
        host.installPackage(manifest({ version: '2.5.0' }), ext('holodeck.cloud', '2.5.0', {}), { owner: 'ext.a', range: '^2.0' }),
      ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
      expect(host.package('holodeck.cloud')?.manifest.version).toBe('0.1.0');
      expect(() => host.registerEngine(isoEngine('1.2.0'))).not.toThrow();
    });

    it('P1: records returned by package()/packages() are frozen', async () => {
      const host = new HolodeckHost({ name: 't' });
      await host.installPackage(manifest(), ext('holodeck.cloud', '0.1.0', {}));
      const record = host.package('holodeck.cloud')!;
      expect(() => {
        (record.manifest as { version: string }).version = '2.5.0';
      }).toThrow(TypeError);
      expect(() => {
        (record.manifest.engines as Record<string, string>)['holodeck.iso'] = '^9.0';
      }).toThrow(TypeError);
      expect(() => (record.owners as string[]).push('ext.evil')).toThrow(TypeError);
      expect(() => {
        (record as { owners: string[] }).owners = [];
      }).toThrow(TypeError);
      expect(host.packages()[0]!.manifest.version).toBe('0.1.0');
      await expect(
        host.installPackage(manifest({ version: '2.5.0' }), ext('holodeck.cloud', '2.5.0', {}), { owner: 'ext.a', range: '^2.0' }),
      ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    });

    it('P1: requirements are snapshotted too', async () => {
      const host = new HolodeckHost({ name: 't' });
      await host.installPackage(manifest(), ext('holodeck.cloud', '0.1.0', {}));
      const aws = manifest({ id: 'holodeck.aws', requires: { 'holodeck.cloud': '^0.1' } });
      await host.installPackage(aws, ext('holodeck.aws', '0.1.0', {}));
      delete aws.requires;
      expect(() => host.uninstallPackage('holodeck.cloud')).toThrow(expect.objectContaining({ code: 'REQUIRED_BY' }));
    });

    it('rejects manifests that are not plain data', async () => {
      const host = new HolodeckHost({ name: 't' });
      await expect(host.installPackage({ ...manifest(), keywords: [() => 'x'] }, ext('holodeck.cloud', '0.1.0', {}))).rejects.toMatchObject({
        code: 'INVALID_MANIFEST',
      });
    });
  });

  describe('GPT review sdk#23 r5 sweep (captured registrations)', () => {
    it('P2: mutating an engine descriptor after registration changes neither lookups, compat nor teardown', async () => {
      const host = new HolodeckHost({ name: 't' });
      const descriptor = isoEngine('1.2.0') as HolodeckEngine & { kinds: ContributionKind[] };
      const off = host.registerEngine(descriptor);
      descriptor.id = 'holodeck.other';
      descriptor.apiVersion = '9.0.0';
      descriptor.kinds.push({ kind: 'holodeck.other.thing' });
      const registered = host.engine('holodeck.iso')!;
      expect(registered.apiVersion).toBe('1.2.0');
      expect(Object.isFrozen(registered) && Object.isFrozen(registered.kinds)).toBe(true);
      expect(() => {
        (registered as { apiVersion: string }).apiVersion = '3.0.0';
      }).toThrow(TypeError);
      await host.installPackage(manifest(), ext('holodeck.cloud', '0.1.0', {}));
      off();
      expect(host.engine('holodeck.iso')).toBeUndefined();
      expect(host.registry.hasKind('holodeck.iso.part')).toBe(false);
      expect(host.registry.hasKind('holodeck.iso.theme')).toBe(false);
      // collectBindings stays bound to the original descriptor
      host.registerEngine(isoEngine());
      expect(host.engine('holodeck.iso')!.collectBindings!({ objects: [{ id: 'o', bindings: { v: { connection: 'c', source: 's' } } }] })).toHaveLength(1);
    });

    it('P2: a shared install reports engines that are still unresolved, and none once registered', async () => {
      const host = new HolodeckHost({ name: 't' });
      await host.installPackage(manifest(), ext('holodeck.cloud', '0.1.0', {}));
      expect((await host.installPackage(manifest(), ext('holodeck.cloud', '0.1.0', {}), { owner: 'ext.a' })).unresolvedEngines).toEqual([
        'holodeck.iso',
      ]);
      host.registerEngine(isoEngine());
      expect((await host.installPackage(manifest(), ext('holodeck.cloud', '0.1.0', {}), { owner: 'ext.b' })).unresolvedEngines).toEqual([]);
    });

    it('extension objects and module manifests are read once', async () => {
      const host = new HolodeckHost({ name: 't' });
      const theExt = ext('holodeck.cloud', '0.1.0', {});
      await host.installPackage(manifest(), theExt);
      theExt.id = 'renamed';
      theExt.version = '9.9.9';
      expect(host.registry.installedExtensions().map((e) => [e.id, e.version])).toEqual([['holodeck.cloud', '0.1.0']]);
      expect(host.uninstallPackage('holodeck.cloud').removed).toEqual(['holodeck.cloud']);

      const module = {
        manifest: manifest({ id: 'holodeck.b' }),
        createExtension: async () => {
          module.manifest = manifest({ id: 'holodeck.b', version: '7.0.0' }); // swapped during the await
          return ext('holodeck.b', '0.1.0', {});
        },
      };
      await expect(host.installPackage(manifest({ id: 'holodeck.b' }), module)).resolves.toMatchObject({ shared: false });
    });
  });

  describe('documents', () => {
    const doc = (body: unknown, engine = 'holodeck.iso'): HolodeckDocument => ({
      format: HOLODECK_DOCUMENT_FORMAT,
      id: 'd',
      name: 'D',
      engine,
      connections: [{ id: 'demo', provider: 'holodeck.sim' }],
      body,
    });

    it('runs engine body validation, installed checks, and warns about unknown engines', async () => {
      const host = new HolodeckHost({ name: 't' });
      host.registerEngine(isoEngine());
      await host.installPackage(
        manifest({ id: 'acme.lint', contributes: ['holodeck.document.check'] }),
        ext('acme.lint', '0.1.0', {
          'holodeck.document.check': [
            { id: 'acme.named', label: 'Named', engines: ['*'], check: (d: HolodeckDocument) => (d.name ? [] : [{ severity: 'warning', message: 'unnamed' }]) } as Contribution,
          ],
        }),
      );
      expect(await host.checkDocument(doc({ objects: [] }))).toEqual([]);
      expect(await host.checkDocument({ ...doc({}), name: '' })).toEqual([
        { check: 'holodeck.iso.body', severity: 'error', code: 'INVALID_BODY', message: 'objects: must be an array' },
        { check: 'acme.named', severity: 'warning', message: 'unnamed' },
      ]);
      expect(await host.checkDocument(doc({}, 'holodeck.flow'))).toEqual([
        { check: 'holodeck.host', severity: 'warning', code: 'UNKNOWN_ENGINE', message: 'engine "holodeck.flow" is not registered' },
      ]);
    });

    it('drives live values from a document end to end: engine bindings → hub → sim provider', async () => {
      const host = new HolodeckHost({ name: 't' });
      const engine = isoEngine();
      host.registerEngine(engine);
      await host.installPackage(
        manifest({ id: 'holodeck.sim', contributes: ['holodeck.provider'], providers: ['holodeck.sim'] }),
        ext('holodeck.sim', '0.1.0', { 'holodeck.provider': [createSimProvider({ schedule: () => () => {} })] }),
      );
      const d = doc({ objects: [{ id: 'web', bindings: { label: { connection: 'demo', source: 'const:"OK"' } } }] });
      const hub = host.createProviderHub({ now: () => 0 });
      const listener = vi.fn();
      hub.subscribe(listener);
      hub.setConnections(d.connections ?? []);
      hub.setBindings(engine.collectBindings!(d.body as Parameters<NonNullable<typeof engine.collectBindings>>[0]));
      await hub.settled();
      expect(hub.getSnapshot().metrics).toEqual({ web: { label: 'OK' } });
      expect(listener).toHaveBeenCalled();
      await hub.dispose();
    });
  });

  it('HolodeckHostError lists details in its message', () => {
    const e = new HolodeckHostError('bad', 'INVALID_MANIFEST', ['a', 'b']);
    expect(e.message).toBe('bad:\n- a\n- b');
    expect(new HolodeckHostError('plain', 'UNKNOWN_PACKAGE').message).toBe('plain');
  });
});
