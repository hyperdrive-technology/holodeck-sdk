import { describe, expect, it, vi } from 'vitest';
import {
  ContributionRegistry,
  ContributionRegistryError,
  packToExtension,
  runContributionKindConformance,
  type Contribution,
  type ContributionKind,
  type HolodeckExtension,
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

  it('keeps failed replay untouched and can retry after removing the invalid extension', () => {
    const r = new ContributionRegistry();
    const good = { id: 'good', version: '1', contributions: { 'test.part': [tank] } };
    const bad = { id: 'bad', version: '1', contributions: { 'test.part': [{ id: 'nolabel' }] } };
    r.install(good);
    r.install(bad);
    const pending = r.pending();
    const onInstall = vi.fn();
    const listener = vi.fn();
    r.subscribe(listener);

    expect(() => r.registerKind({ ...partKind, onInstall })).toThrow(/failed validation/);
    expect(r.hasKind(partKind.kind)).toBe(false);
    expect(r.list(partKind.kind)).toEqual([]);
    expect(r.ownerOf(partKind.kind, tank.id)).toBeUndefined();
    expect(r.pending()).toEqual(pending);
    expect(r.installedExtensions()).toEqual([good, bad]);
    expect(onInstall).not.toHaveBeenCalled();
    expect(listener).not.toHaveBeenCalled();

    r.uninstall('bad');
    const off = r.registerKind({ ...partKind, onInstall });
    expect(r.list(partKind.kind)).toEqual([tank]);
    expect(r.ownerOf(partKind.kind, tank.id)).toBe('good');
    expect(r.pending()).toEqual({});
    expect(onInstall).toHaveBeenCalledTimes(1);
    expect(onInstall).toHaveBeenCalledWith([tank], 'good');
    off();
    expect(r.pending()).toEqual({ 'test.part': [tank] });
  });

  it('keeps replay atomic when a validator throws', () => {
    const r = new ContributionRegistry();
    r.install({ id: 'good', version: '1', contributions: { 'test.part': [tank] } });
    r.install({ id: 'bad', version: '1', contributions: { 'test.part': [valve] } });
    const onInstall = vi.fn();
    const error = new Error('validator failed');
    expect(() => r.registerKind<Part>({
      ...partKind,
      validate: (item): item is Part => {
        if ((item as Part).id === valve.id) throw error;
        return true;
      },
      onInstall,
    })).toThrow(error);
    expect(r.hasKind(partKind.kind)).toBe(false);
    expect(r.installedExtensions()).toHaveLength(2);
    expect(r.pending()).toEqual({ 'test.part': [tank, valve] });
    expect(onInstall).not.toHaveBeenCalled();
    r.registerKind(partKind);
    expect(r.list(partKind.kind)).toEqual([tank, valve]);
  });

  it('notifies subscribers after all pending contributions are replayed', () => {
    const r = new ContributionRegistry();
    r.install({ id: 'first', version: '1', contributions: { 'test.part': [tank] } });
    r.install({ id: 'second', version: '1', contributions: { 'test.part': [valve] } });
    const snapshots: unknown[] = [];
    r.subscribe((change) => snapshots.push({
      change,
      items: r.list(partKind.kind),
      owners: [r.ownerOf(partKind.kind, tank.id), r.ownerOf(partKind.kind, valve.id)],
      pending: r.pending(),
    }));
    const onInstall = vi.fn(() => expect(r.list(partKind.kind)).toEqual([tank, valve]));
    r.registerKind({ ...partKind, onInstall });
    expect(onInstall).toHaveBeenCalledTimes(2);
    expect(snapshots).toEqual([{
      change: { type: 'kind-registered', kind: partKind.kind },
      items: [tank, valve],
      owners: ['first', 'second'],
      pending: {},
    }]);
  });

  it.each(['install', 'uninstall'] as const)('commits every kind before %s hooks and collects their errors', (operation) => {
    const r = new ContributionRegistry();
    const firstError = new Error('part hook failed');
    const secondError = new Error('theme hook failed');
    const firstHook = vi.fn((): void => {
      expect(r.list(partKind.kind)).toEqual(operation === 'install' ? [tank] : []);
      expect(r.list('test.theme')).toEqual(operation === 'install' ? [{ id: 'theme' }] : []);
      expect(r.ownerOf(partKind.kind, tank.id)).toBe(operation === 'install' ? 'pack' : undefined);
      expect(r.ownerOf('test.theme', 'theme')).toBe(operation === 'install' ? 'pack' : undefined);
      expect(r.installedExtensions()).toHaveLength(operation === 'install' ? 1 : 0);
      expect(r.pending()).toEqual(operation === 'install' ? { 'test.future': [{ id: 'future' }] } : {});
      throw firstError;
    });
    const secondHook = vi.fn((): void => { throw secondError; });
    const hookName = operation === 'install' ? 'onInstall' : 'onUninstall';
    r.registerKind({ ...partKind, [hookName]: firstHook });
    r.registerKind({ kind: 'test.theme', [hookName]: secondHook });
    const ext: HolodeckExtension = {
      id: 'pack', version: '1', contributions: {
        'test.part': [tank], 'test.theme': [{ id: 'theme' }], 'test.future': [{ id: 'future' }],
      },
    };
    if (operation === 'uninstall') r.install(ext);
    const listener = vi.fn(() => expect(r.list('test.theme')).toHaveLength(operation === 'install' ? 1 : 0));
    const unsubscribe = r.subscribe(listener);

    let failure: unknown;
    try {
      if (operation === 'install') r.install(ext);
      else r.uninstall(ext.id);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([firstError, secondError]);
    expect(firstHook).toHaveBeenCalledTimes(1);
    expect(secondHook).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({
      type: operation === 'install' ? 'installed' : 'uninstalled',
      extensionId: ext.id, kinds: ['test.part', 'test.theme'],
    });
    unsubscribe();
    if (operation === 'install') {
      expect(() => r.install(ext)).toThrow(/already installed/);
      r.uninstall(ext.id);
    } else {
      expect(() => r.uninstall(ext.id)).toThrow(/not installed/);
    }
    expect(r.installedExtensions()).toEqual([]);
    expect(r.list(partKind.kind)).toEqual([]);
    expect(r.list('test.theme')).toEqual([]);
    expect(r.ownerOf(partKind.kind, tank.id)).toBeUndefined();
    expect(r.ownerOf('test.theme', 'theme')).toBeUndefined();
    expect(r.pending()).toEqual({});
    // All ID reservations, including pending kinds, have been released.
    firstHook.mockImplementation(() => {});
    secondHook.mockImplementation(() => {});
    r.install({ ...ext, id: 'replacement' });
  });

  it('commits replay before hooks and still notifies subscribers when a replay hook throws', () => {
    const r = new ContributionRegistry();
    r.install({ id: 'first', version: '1', contributions: { 'test.part': [tank] } });
    r.install({ id: 'second', version: '1', contributions: { 'test.part': [valve] } });
    const error = new Error('replay hook failed');
    const onInstall = vi.fn((_items: Part[], extensionId: string) => {
      expect(r.list(partKind.kind)).toEqual([tank, valve]);
      if (extensionId === 'first') throw error;
    });
    const listener = vi.fn(() => expect(r.list(partKind.kind)).toEqual([tank, valve]));
    const unsubscribe = r.subscribe(listener);
    let failure: unknown;
    try { r.registerKind({ ...partKind, onInstall }); } catch (caught) { failure = caught; }
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([error]);
    expect(onInstall).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({ type: 'kind-registered', kind: partKind.kind });
    expect(r.hasKind(partKind.kind)).toBe(true);
    expect(r.ownerOf(partKind.kind, tank.id)).toBe('first');
    expect(r.ownerOf(partKind.kind, valve.id)).toBe('second');
    expect(r.pending()).toEqual({});
    unsubscribe();
    r.uninstall('first');
    r.uninstall('second');
    expect(r.list(partKind.kind)).toEqual([]);
  });

  it('rejects duplicate IDs within a pending kind without reserving earlier IDs', () => {
    const r = new ContributionRegistry();
    const listener = vi.fn();
    r.subscribe(listener);
    expect(() => r.install({ id: 'bad', version: '1', contributions: {
      'test.other': [{ id: 'other' }], 'test.part': [tank, tank],
    } })).toThrow(expect.objectContaining({ code: 'DUPLICATE_ID' }));
    expect(r.installedExtensions()).toEqual([]);
    expect(r.pending()).toEqual({});
    expect(listener).not.toHaveBeenCalled();
    r.install({ id: 'good', version: '1', contributions: {
      'test.other': [{ id: 'other' }], 'test.part': [tank],
    } });
    expect(r.pending()).toEqual({ 'test.other': [{ id: 'other' }], 'test.part': [tank] });
  });

  it('rejects duplicate pending IDs across extensions at install time', () => {
    const r = new ContributionRegistry();
    const original = { id: 'original', version: '1', contributions: { 'test.part': [tank] } };
    r.install(original);
    expect(() => r.install({ id: 'duplicate', version: '1', contributions: {
      'test.part': [valve, tank],
    } })).toThrow(expect.objectContaining({ code: 'DUPLICATE_ID' }));
    expect(r.installedExtensions()).toEqual([original]);
    expect(r.pending()).toEqual({ 'test.part': [tank] });
    r.install({ id: 'second', version: '1', contributions: { 'test.part': [valve] } });
    r.registerKind(partKind);
    expect(r.list(partKind.kind)).toEqual([tank, valve]);
  });

  it.each([null, 42, {}, { id: 42 }])('rejects malformed pending contributions: %j', (item) => {
    const r = new ContributionRegistry();
    expect(() => r.install({ id: 'bad', version: '1', contributions: {
      'test.part': [item as unknown as Contribution],
    } })).toThrow(expect.objectContaining({ code: 'INVALID_ITEM' }));
    expect(r.installedExtensions()).toEqual([]);
    expect(r.pending()).toEqual({});
  });

  it('retains pending ID reservations across unregister and releases them on uninstall', () => {
    const r = new ContributionRegistry();
    const off = r.registerKind(partKind);
    r.install({ id: 'original', version: '1', contributions: { 'test.part': [tank] } });
    off();
    const replacement = { id: 'replacement', version: '1', contributions: { 'test.part': [tank] } };
    expect(() => r.install(replacement)).toThrow(expect.objectContaining({ code: 'DUPLICATE_ID' }));
    r.uninstall('original');
    r.install(replacement);
    r.registerKind(partKind);
    expect(r.ownerOf(partKind.kind, tank.id)).toBe('replacement');
  });

  it('does not reserve pending IDs when a registered kind rejects the install', () => {
    const r = new ContributionRegistry();
    const onInstall = vi.fn();
    r.registerKind({ ...partKind, onInstall });
    expect(() => r.install({ id: 'pack', version: '1', contributions: {
      'test.future': [{ id: 'future' }], 'test.part': [{ id: 'nolabel' }],
    } })).toThrow(expect.objectContaining({ code: 'INVALID_ITEM' }));
    expect(r.pending()).toEqual({});
    expect(r.installedExtensions()).toEqual([]);
    expect(onInstall).not.toHaveBeenCalled();
    r.install({ id: 'pack', version: '1', contributions: {
      'test.future': [{ id: 'future' }], 'test.part': [tank],
    } });
    expect(r.pending()).toEqual({ 'test.future': [{ id: 'future' }] });
    expect(r.list(partKind.kind)).toEqual([tank]);
  });

  it('allows the same ID in different kinds', () => {
    const r = new ContributionRegistry();
    r.registerKind(partKind);
    r.install({ id: 'part', version: '1', contributions: { 'test.part': [tank] } });
    r.install({ id: 'theme', version: '1', contributions: { 'test.theme': [{ id: tank.id }] } });
    r.registerKind({ kind: 'test.theme' });
    expect(r.ownerOf(partKind.kind, tank.id)).toBe('part');
    expect(r.ownerOf('test.theme', tank.id)).toBe('theme');
  });

  it('collects hook and subscriber failures without preventing later notifications', () => {
    const r = new ContributionRegistry();
    const hookError = new Error('hook failed');
    const subscriberError = new Error('subscriber failed');
    r.registerKind({ ...partKind, onInstall: () => { throw hookError; } });
    r.subscribe(() => { throw subscriberError; });
    const listener = vi.fn(() => expect(r.list(partKind.kind)).toEqual([tank]));
    r.subscribe(listener);
    let failure: unknown;
    try {
      r.install({ id: 'pack', version: '1', contributions: { 'test.part': [tank] } });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([hookError, subscriberError]);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(r.ownerOf(partKind.kind, tank.id)).toBe('pack');
    expect(r.installedExtensions()).toHaveLength(1);
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
