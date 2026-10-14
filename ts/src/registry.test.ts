import { describe, expect, it, vi } from 'vitest';
import {
  ContributionRegistry,
  ContributionRegistryError,
  KindRegistrationError,
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

  it('snapshots pending membership before the review append/replay/install/uninstall sequence', () => {
    const r = new ContributionRegistry();
    const original = { id: 'original' };
    const added = { id: 'added' };
    const ext = { id: 'first', version: '1', contributions: { part: [original] } };
    r.install(ext);
    ext.contributions.part.push(added);
    r.registerKind({ kind: 'part' });
    const replayed = r.list('part');
    const replayedOwner = r.ownerOf('part', added.id);

    r.install({ id: 'second', version: '1', contributions: { part: [added] } });
    expect(r.ownerOf('part', added.id)).toBe('second');
    r.uninstall('second');

    // The append was never installed, so replay cannot publish an unreserved ID.
    expect(replayed).toEqual([original]);
    expect(replayedOwner).toBeUndefined();
    expect(r.list('part')).toEqual([original]);
    expect(r.ownerOf('part', original.id)).toBe('first');
    expect(() => r.install({ id: 'duplicate', version: '1', contributions: { part: [original] } }))
      .toThrow(expect.objectContaining({ code: 'DUPLICATE_ID' }));
  });

  it('captures routing IDs and membership while preserving original user objects', () => {
    const r = new ContributionRegistry();
    const item = { id: 'original', label: 'Original' };
    const ext: HolodeckExtension = {
      id: 'first', version: '1', contributions: { 'test.part': [item] },
    };
    r.install(ext);
    ext.id = 'changed';
    ext.version = '2';
    item.id = 'changed';
    item.label = 'Changed';
    ext.contributions['test.part'] = [{ id: 'replacement' }];
    ext.contributions['test.other'] = [{ id: 'other' }];

    expect(r.installedExtensions()[0]).toBe(ext);
    expect(r.pending()[partKind.kind]![0]).toBe(item);
    const off = r.registerKind(partKind);
    expect(r.get(partKind.kind, 'original')).toBe(item);
    expect(r.get(partKind.kind, 'changed')).toBeUndefined();
    expect(r.ownerOf(partKind.kind, 'original')).toBe('first');
    expect(r.list('test.other')).toEqual([]);
    off();
    expect(() => r.install({ id: 'duplicate', version: '1', contributions: {
      'test.part': [{ id: 'original' }],
    } })).toThrow(expect.objectContaining({ code: 'DUPLICATE_ID' }));
    r.uninstall('first');
    r.install({ id: 'replacement', version: '1', contributions: {
      'test.part': [{ id: 'original', label: 'Replacement' }],
    } });
    r.registerKind(partKind);
    expect(r.ownerOf(partKind.kind, 'original')).toBe('replacement');
  });

  it.each(['active', 'pending'] as const)('isolates %s bookkeeping from mutations through queries', (state) => {
    const r = new ContributionRegistry();
    if (state === 'active') r.registerKind(partKind);
    const original = { id: 'original', label: 'Original' };
    const ext = { id: 'first', version: '1', contributions: { 'test.part': [original] } };
    r.install(ext);
    const stored = r.installedExtensions()[0]!;
    expect(stored).toBe(ext);
    const items = stored.contributions[partKind.kind]!;
    stored.id = 'changed';
    stored.contributions[partKind.kind] = [];
    items.push({ id: 'added' });
    const exposed = state === 'active' ? r.get<Part>(partKind.kind, original.id)! : r.pending()[partKind.kind]![0]!;
    expect(exposed).toBe(original);
    exposed.id = 'changed';
    (exposed as Part).label = 'Changed';
    // Query result arrays themselves can be changed without touching membership.
    if (state === 'active') (r.list(partKind.kind) as Contribution[]).splice(0);
    else r.pending()[partKind.kind]!.splice(0);
    (r.installedExtensions() as HolodeckExtension[]).splice(0);
    if (state === 'pending') r.registerKind(partKind);
    expect(r.list(partKind.kind)).toEqual([original]);
    expect(r.get(partKind.kind, 'original')).toBe(original);
    expect(r.ownerOf(partKind.kind, 'original')).toBe('first');
    expect(() => r.install({ id: 'duplicate', version: '1', contributions: {
      'test.part': [{ id: 'original', label: 'Duplicate' }],
    } })).toThrow(expect.objectContaining({ code: 'DUPLICATE_ID' }));
    r.uninstall('first');
    expect(r.list(partKind.kind)).toEqual([]);
    r.install({ id: 'replacement', version: '1', contributions: {
      'test.part': [{ id: 'original', label: 'Replacement' }],
    } });
  });

  it('keeps registered kind definitions stable for validation, hooks and unregister', () => {
    const r = new ContributionRegistry();
    const onInstall = vi.fn();
    const def = { ...partKind, onInstall };
    const off = r.registerKind(def);
    def.kind = 'changed';
    def.validate = (_item): _item is Part => true;
    def.onInstall = vi.fn();
    expect(() => r.install({ id: 'bad', version: '1', contributions: {
      'test.part': [{ id: 'invalid' }],
    } })).toThrow(expect.objectContaining({ code: 'INVALID_ITEM' }));
    expect(r.install({ id: 'good', version: '1', contributions: { 'test.part': [tank] } }).installed)
      .toEqual({ 'test.part': [tank.id] });
    expect(onInstall).toHaveBeenCalledWith([tank], 'good');
    expect(def.onInstall).not.toHaveBeenCalled();
    off();
    expect(r.hasKind(partKind.kind)).toBe(false);
    expect(r.pending()).toEqual({ 'test.part': [tank] });
  });

  it.each(['active', 'pending'] as const)('isolates %s hook array mutations from stored membership', (state) => {
    const r = new ContributionRegistry();
    const onInstall = vi.fn((items: Contribution[]) => {
      items.splice(0, items.length, { id: 'added' });
    });
    let off: () => void;
    if (state === 'active') off = r.registerKind({ ...partKind, onInstall });
    r.install({ id: 'first', version: '1', contributions: { 'test.part': [tank] } });
    if (state === 'pending') off = r.registerKind({ ...partKind, onInstall });
    expect(onInstall).toHaveBeenCalledTimes(1);
    expect(r.list(partKind.kind)).toEqual([tank]);
    expect(() => r.install({ id: 'duplicate', version: '1', contributions: { 'test.part': [tank] } }))
      .toThrow(expect.objectContaining({ code: 'DUPLICATE_ID' }));
    off!();
    expect(r.pending()).toEqual({ 'test.part': [tank] });
    r.registerKind(partKind);
    expect(r.list(partKind.kind)).toEqual([tank]);
    r.uninstall('first');
    expect(r.list(partKind.kind)).toEqual([]);
  });

  it('uses one snapshot when a validator mutates later input kinds', () => {
    const r = new ContributionRegistry();
    const ext = { id: 'first', version: '1', contributions: {
      'test.part': [{ id: 'part', label: 'Part' }], future: [{ id: 'future' }],
    } };
    r.registerKind<Part>({ ...partKind, validate: (_item): _item is Part => {
      ext.id = 'changed';
      ext.contributions.future[0]!.id = 'changed';
      ext.contributions.future.push({ id: 'added' });
      return true;
    } });
    const result = r.install(ext);
    expect(result.extensionId).toBe('first');
    expect(r.pending()).toEqual({ future: [ext.contributions.future[0]] });
    expect(r.ownerOf(partKind.kind, 'part')).toBe('first');
    r.registerKind({ kind: 'future' });
    expect(r.ownerOf('future', 'future')).toBe('first');
    expect(() => r.install({ id: 'duplicate', version: '1', contributions: { future: [{ id: 'future' }] } }))
      .toThrow(expect.objectContaining({ code: 'DUPLICATE_ID' }));
  });

  it('keeps IDs stable when validation mutates an item and rejects the install', () => {
    const r = new ContributionRegistry();
    r.registerKind<Part>({ ...partKind, validate: (item): item is Part => {
      (item as Part).id = 'changed';
      return false;
    } });
    const item = { id: 'original', label: 'Original' };
    expect(() => r.install({ id: 'first', version: '1', contributions: {
      future: [{ id: 'future' }], 'test.part': [item],
    } })).toThrow(expect.objectContaining({ code: 'INVALID_ITEM' }));
    expect(item.id).toBe('changed');
    expect(r.installedExtensions()).toEqual([]);
    expect(r.list(partKind.kind)).toEqual([]);
    expect(r.pending()).toEqual({});
    r.install({ id: 'replacement', version: '1', contributions: { future: [{ id: 'future' }] } });
    expect(r.pending()).toEqual({ future: [{ id: 'future' }] });
  });

  it.each(['active', 'pending'] as const)('preserves %s class kind validators and lifecycle methods', (state) => {
    class PartKind implements ContributionKind<Part> {
      kind = 'test.part';
      #requiredField = 'label';
      validated: unknown[] = [];
      installed: Array<{ items: Part[]; extensionId: string }> = [];
      uninstalled: Array<{ items: Part[]; extensionId: string }> = [];

      validate(item: unknown): item is Part {
        this.validated.push(item);
        return typeof (item as Record<string, unknown>)[this.#requiredField] === 'string';
      }

      onInstall(items: Part[], extensionId: string): void {
        this.installed.push({ items, extensionId });
      }

      onUninstall(items: Part[], extensionId: string): void {
        this.uninstalled.push({ items, extensionId });
      }
    }

    const r = new ContributionRegistry();
    const def = new PartKind();
    const bad = { id: 'bad', version: '1', contributions: { 'test.part': [{ id: 'invalid' }] } };
    const good = { id: 'good', version: '1', contributions: { 'test.part': [tank] } };
    let off: () => void;
    if (state === 'active') {
      off = r.registerKind(def);
      expect(() => r.install(bad)).toThrow(expect.objectContaining({ code: 'INVALID_ITEM' }));
      r.install(good);
    } else {
      r.install(bad);
      expect(() => r.registerKind(def)).toThrow(expect.objectContaining({ code: 'INVALID_ITEM' }));
      expect(r.hasKind('test.part')).toBe(false);
      r.uninstall('bad');
      r.install(good);
      off = r.registerKind(def);
    }
    expect(def.validated).toEqual([bad.contributions['test.part'][0], tank]);
    expect(def.installed).toEqual([{ items: [tank], extensionId: 'good' }]);
    expect(def.installed[0]!.items[0]).toBe(tank);
    // Replacing contract methods must not change the captured callbacks or name.
    def.kind = 'changed';
    def.validate = (_item): _item is Part => true;
    def.onInstall = vi.fn();
    def.onUninstall = vi.fn();
    expect(() => r.install(bad)).toThrow(expect.objectContaining({ code: 'INVALID_ITEM' }));
    r.uninstall('good');
    expect(def.uninstalled).toEqual([{ items: [tank], extensionId: 'good' }]);
    expect(def.uninstalled[0]!.items[0]).toBe(tank);
    expect(def.onUninstall).not.toHaveBeenCalled();
    r.install(good);
    expect(def.installed).toHaveLength(2);
    expect(def.onInstall).not.toHaveBeenCalled();
    off();
    expect(r.hasKind('test.part')).toBe(false);
    expect(r.pending()['test.part']![0]).toBe(tank);
  });

  it.each(['active', 'pending'] as const)('preserves %s class animator behavior and identity', (state) => {
    // Mirrors IsoAnimator / IsoAnimatorContext in Holodeck's
    // packages/editor-2.5d-react/src/registry/types.ts, with a minimal node fixture.
    interface AnimatorContext {
      node: { visible: boolean };
      value: unknown;
      dt: number;
      elapsed: number;
      settings: Record<string, unknown>;
    }
    interface Animator extends Contribution {
      label: string;
      param: string;
      apply(ctx: AnimatorContext): void;
    }
    class VisibilityAnimator implements Animator {
      id = 'visible';
      param = 'enabled';
      #applications = 0;
      get label(): string { return 'Visibility'; }
      get applications(): number { return this.#applications; }
      apply({ node, value }: AnimatorContext): void {
        this.#applications++;
        node.visible = Boolean(value);
      }
    }

    const r = new ContributionRegistry();
    const kind: ContributionKind<Animator> = {
      kind: 'holodeck.iso.animator',
      // The required fields checked by Holodeck's isIsoAnimator validator.
      validate: (item): item is Animator => {
        const animator = item as Animator;
        return typeof animator.id === 'string' && animator.id.length > 0
          && typeof animator.label === 'string'
          && typeof animator.param === 'string' && animator.param.length > 0
          && typeof animator.apply === 'function';
      },
      onInstall: vi.fn(),
      onUninstall: vi.fn(),
    };
    const animator = new VisibilityAnimator();
    const ext = { id: 'animators', version: '1', contributions: { [kind.kind]: [animator] } };
    let off: () => void;
    if (state === 'active') off = r.registerKind(kind);
    r.install(ext);
    expect(r.installedExtensions()[0]).toBe(ext);
    if (state === 'pending') {
      expect(r.pending()[kind.kind]![0]).toBe(animator);
      off = r.registerKind(kind);
    }
    const installed = r.get<Animator>(kind.kind, animator.id)!;
    expect(installed).toBe(animator);
    expect(r.list(kind.kind)[0]).toBe(animator);
    expect(vi.mocked(kind.onInstall!).mock.calls[0]![0][0]).toBe(animator);
    const node = { visible: false };
    installed.apply({ node, value: true, dt: 0.1, elapsed: 1, settings: {} });
    expect(node.visible).toBe(true);
    expect(animator.applications).toBe(1);
    off!();
    expect(r.pending()[kind.kind]![0]).toBe(animator);
    r.registerKind(kind);
    expect(r.get(kind.kind, animator.id)).toBe(animator);
    r.uninstall('animators');
    expect(vi.mocked(kind.onUninstall!).mock.calls[0]![0][0]).toBe(animator);
    expect(r.list(kind.kind)).toEqual([]);
  });

  it('only replays own contribution kinds, including names inherited by ordinary objects', () => {
    const r = new ContributionRegistry();
    r.install({ id: 'empty', version: '1', contributions: {} });
    const off = r.registerKind({ kind: 'constructor' });
    expect(r.list('constructor')).toEqual([]);
    off();
    const contributions = Object.fromEntries([
      ['constructor', [{ id: 'constructor-item' }]],
      ['__proto__', [{ id: 'prototype-item' }]],
    ]);
    r.install({ id: 'first', version: '1', contributions });
    expect(r.pending()).toEqual(contributions);
    r.registerKind({ kind: 'constructor' });
    r.registerKind({ kind: '__proto__' });
    expect(r.ownerOf('constructor', 'constructor-item')).toBe('first');
    expect(r.ownerOf('__proto__', 'prototype-item')).toBe('first');
    r.uninstall('first');
    const result = r.install({ id: 'replacement', version: '1', contributions });
    expect(Object.keys(result.installed)).toEqual(['constructor', '__proto__']);
    expect(result.installed['__proto__']).toEqual(['prototype-item']);
    expect(r.ownerOf('__proto__', 'prototype-item')).toBe('replacement');
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

  it('exposes unregister on the error when replay hooks or subscribers fail (#19)', () => {
    const r = new ContributionRegistry();
    r.install({ id: 'ext.a', version: '1', contributions: { 'test.part': [tank] } });
    const hookError = new Error('hook');
    const subError = new Error('sub');
    r.subscribe((c) => {
      if (c.type === 'kind-registered') throw subError;
    });
    let failure: unknown;
    try {
      r.registerKind<Part>({ ...partKind, onInstall: () => { throw hookError; } });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure).toBeInstanceOf(KindRegistrationError);
    expect((failure as KindRegistrationError).errors).toEqual([hookError, subError]);
    expect(r.hasKind('test.part')).toBe(true);

    const changes: string[] = [];
    r.subscribe((c) => changes.push(c.type));
    (failure as KindRegistrationError).unregister();
    expect(r.hasKind('test.part')).toBe(false);
    expect(changes).toEqual(['kind-unregistered']);
    expect(r.pending()['test.part']).toEqual([tank]);
    // Idempotent, and the kind can be registered again.
    (failure as KindRegistrationError).unregister();
    expect(() => r.registerKind(partKind)).toThrow(KindRegistrationError);
  });

  it('rejects a nested registerKind for the same kind during replay validation (#20)', () => {
    const r = new ContributionRegistry();
    r.install({ id: 'ext.a', version: '1', contributions: { 'test.part': [tank] } });
    let inner: unknown;
    const reentrant: ContributionKind<Part> = {
      kind: 'test.part',
      validate(item): item is Part {
        try {
          r.registerKind(partKind);
        } catch (error) {
          inner = error;
        }
        return true;
      },
    };
    const unregister = r.registerKind(reentrant);
    expect(inner).toBeInstanceOf(ContributionRegistryError);
    expect((inner as ContributionRegistryError).code).toBe('DUPLICATE_KIND');
    expect(r.list('test.part')).toEqual([tank]);
    unregister();
    expect(r.hasKind('test.part')).toBe(false);
  });

  it('allows registering a kind again after a failed replay validation (#20)', () => {
    const r = new ContributionRegistry();
    r.install({ id: 'ext.a', version: '1', contributions: { 'test.part': [{ id: 'bad' }] } });
    expect(() => r.registerKind(partKind)).toThrow(ContributionRegistryError);
    expect(() => r.registerKind({ kind: 'test.part' })).not.toThrow();
  });
});
