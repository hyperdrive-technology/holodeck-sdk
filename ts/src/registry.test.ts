import { describe, expect, it } from 'vitest';
import {
  ContributionRegistry,
  ContributionRegistryError,
  packToExtension,
  runContributionKindConformance,
  type Contribution,
  type ContributionKind,
} from './index.js';

interface Part extends Contribution {
  label: string;
}

const partKind: ContributionKind<Part> = {
  kind: 'test.part',
  validate: (item): item is Part => typeof (item as Part).label === 'string',
};

const tank: Part = { id: 'tank', label: 'Tank' };
const valve: Part = { id: 'valve', label: 'Valve' };

describe('ContributionRegistry', () => {
  it('passes the conformance kit', () => {
    runContributionKindConformance(() => new ContributionRegistry(), partKind, [tank, valve], (ok, msg) => {
      expect(ok, msg).toBe(true);
    });
  });

  it('rejects a duplicate kind', () => {
    const r = new ContributionRegistry();
    r.registerKind(partKind);
    expect(() => r.registerKind(partKind)).toThrow(ContributionRegistryError);
  });

  it('rejects an item that fails validation and keeps the install atomic', () => {
    const r = new ContributionRegistry();
    r.registerKind(partKind);
    r.registerKind<Contribution>({ kind: 'test.theme' });
    expect(() =>
      r.install({
        id: 'bad',
        version: '1',
        contributions: {
          'test.theme': [{ id: 't1' }],
          'test.part': [{ id: 'nolabel' } as Part],
        },
      }),
    ).toThrow(/failed validation/);
    expect(r.list('test.theme')).toHaveLength(0);
    expect(r.installedExtensions()).toHaveLength(0);
  });

  it('rejects installing the same extension twice', () => {
    const r = new ContributionRegistry();
    r.install({ id: 'x', version: '1', contributions: {} });
    expect(() => r.install({ id: 'x', version: '1', contributions: {} })).toThrow(/already installed/);
  });

  it('reports the owner of a contribution and calls kind hooks', () => {
    const installed: string[] = [];
    const uninstalled: string[] = [];
    const r = new ContributionRegistry();
    r.registerKind<Part>({
      ...partKind,
      onInstall: (items, ext) => installed.push(`${ext}:${items.map((i) => i.id).join('+')}`),
      onUninstall: (items, ext) => uninstalled.push(`${ext}:${items.map((i) => i.id).join('+')}`),
    });
    r.install({ id: 'brewery', version: '1', contributions: { 'test.part': [tank, valve] } });
    expect(r.ownerOf('test.part', 'tank')).toBe('brewery');
    r.uninstall('brewery');
    expect(installed).toEqual(['brewery:tank+valve']);
    expect(uninstalled).toEqual(['brewery:tank+valve']);
    expect(r.ownerOf('test.part', 'tank')).toBeUndefined();
  });

  it('unregistering a kind stops routing and makes items pending again', () => {
    const r = new ContributionRegistry();
    const off = r.registerKind(partKind);
    r.install({ id: 'brewery', version: '1', contributions: { 'test.part': [tank] } });
    off();
    expect(r.hasKind('test.part')).toBe(false);
    expect(r.pending()['test.part']).toEqual([tank]);
  });
});

describe('packToExtension', () => {
  it('maps a SceneComponentPack onto flow / scene3d kinds', () => {
    const render = () => null;
    const ext = packToExtension({
      id: 'acme.pack',
      version: '2.0.0',
      paletteItems: [{ id: 'acme:pump', nodeType: 'acme:pump', label: 'Pump' }],
      nodeTypes: { 'acme:pump': render },
      edgeTypes: { 'acme:pipe': render },
      objectRenderers: { 'acme:pump': { nodeType: 'acme:pump', render } },
    });
    expect(ext.id).toBe('acme.pack');
    expect(ext.contributions['holodeck.flow.palette']).toEqual([
      { id: 'acme:pump', nodeType: 'acme:pump', label: 'Pump' },
    ]);
    expect(ext.contributions['holodeck.flow.nodeType']).toEqual([{ id: 'acme:pump', component: render }]);
    expect(ext.contributions['holodeck.flow.edgeType']).toEqual([{ id: 'acme:pipe', component: render }]);
    expect(ext.contributions['holodeck.scene3d.renderer']).toEqual([{ id: 'acme:pump', nodeType: 'acme:pump', render }]);
  });
});
