import { describe, expect, it, vi } from 'vitest';
import type { BindingRef, ProviderConnection } from './document';
import { ProviderHub, ProviderHubError, invertTransform } from './hub';
import {
  PROVIDER_KIND,
  createManualSchedule,
  createSimProvider,
  type HolodeckProvider,
  type ProviderContext,
  type ProviderSession,
  type ProviderStatus,
  type Sample,
} from './provider';
import { ContributionRegistry } from './registry';

interface FakeSession extends ProviderSession {
  emit(samples: Sample[]): void;
  setStatus(state: ProviderStatus['state'], message?: string): void;
  subscribed: string[][];
  closed: boolean;
  config: Record<string, unknown>;
  ctx: ProviderContext;
}

function fakeProvider(
  id = 'test.fake',
  opts: { write?: boolean; delay?: Promise<void>; fail?: unknown; throwSync?: unknown; closeDelay?: Promise<void>; closeThrows?: boolean } = {},
) {
  const sessions: FakeSession[] = [];
  const provider: HolodeckProvider = {
    id,
    label: 'Fake',
    capabilities: opts.write ? { write: true } : {},
    connect(config, ctx) {
      if (opts.throwSync) throw opts.throwSync;
      const make = async (): Promise<ProviderSession> => {
        if (opts.delay) await opts.delay;
        if (opts.fail) throw opts.fail;
        let status: ProviderStatus = { state: 'live', since: 0 };
        const statusListeners = new Set<(s: ProviderStatus) => void>();
        let sink: ((s: readonly Sample[]) => void) | undefined;
        const session: FakeSession = {
          subscribed: [],
          closed: false,
          config,
          ctx,
          status: () => status,
          onStatus(l) {
            statusListeners.add(l);
            return () => statusListeners.delete(l);
          },
          subscribe(sources, onSamples) {
            session.subscribed.push([...sources]);
            sink = onSamples;
            return () => {
              if (sink === onSamples) sink = undefined;
            };
          },
          emit: (samples) => sink?.(samples),
          setStatus(state, message) {
            status = message === undefined ? { state, since: 1 } : { state, message, since: 1 };
            statusListeners.forEach((l) => l(status));
          },
          close() {
            if (opts.closeThrows) throw new Error('close threw');
            const finish = () => {
              session.closed = true;
              sink = undefined;
              status = { state: 'disconnected', since: 2 };
            };
            return opts.closeDelay ? opts.closeDelay.then(finish) : Promise.resolve(finish());
          },
        };
        if (opts.write) session.write = vi.fn(async () => {});
        sessions.push(session);
        return session;
      };
      return make();
    },
  };
  return { provider, sessions };
}

function setup(providers: HolodeckProvider[] = []) {
  const registry = new ContributionRegistry();
  registry.registerKind(PROVIDER_KIND);
  if (providers.length) registry.install({ id: 'pkg.providers', version: '1.0.0', contributions: { 'holodeck.provider': providers } });
  const log = vi.fn();
  const secret = vi.fn(async (connectionId: string, key: string) => `${connectionId}/${key}`);
  const hub = new ProviderHub({ registry, log, secret, now: () => 42 });
  return { registry, hub, log, secret };
}

const conn = (id: string, provider = 'test.fake', config?: Record<string, unknown>): ProviderConnection =>
  config ? { id, provider, config } : { id, provider };
const bind = (objectId: string, param: string, connection: string, source: string, transform?: BindingRef['binding']['transform']): BindingRef => ({
  objectId,
  param,
  binding: transform ? { connection, source, transform } : { connection, source },
});

describe('ProviderHub', () => {
  it('connects, subscribes the bound sources and publishes transformed values per object', async () => {
    const { provider, sessions } = fakeProvider();
    const { hub } = setup([provider]);
    hub.setConnections([conn('prod')]);
    expect(hub.getSnapshot().connections.prod?.status.state).toBe('connecting');
    hub.setBindings([
      bind('web', 'color', 'prod', 'cpu', { kind: 'threshold', below: 'green', steps: [{ at: 80, value: 'red' }] }),
      bind('web', 'label', 'prod', 'cpu', { kind: 'format', template: '{value} %', digits: 0 }),
      bind('db', 'level', 'prod', 'disk'),
    ]);
    await hub.settled();
    expect(hub.getSnapshot().connections.prod).toEqual({ provider: 'test.fake', status: { state: 'live', since: 0 } });
    expect(sessions[0]!.subscribed).toEqual([['cpu', 'disk']]);

    const listener = vi.fn();
    hub.subscribe(listener);
    sessions[0]!.emit([
      { source: 'cpu', value: 91.4, ts: 1 },
      { source: 'disk', value: 0.5, ts: 1, quality: 'uncertain' },
      { source: 'unrequested', value: 1, ts: 1 },
    ]);
    expect(listener).toHaveBeenCalledTimes(1);
    const snap = hub.getSnapshot();
    expect(snap.metrics).toEqual({ web: { color: 'red', label: '91 %' }, db: { level: 0.5 } });
    expect(snap.quality).toEqual({ web: { color: 'good', label: 'good' }, db: { level: 'uncertain' } });
    expect(hub.getSnapshot()).toBe(snap);
  });

  it('keeps object identity for unchanged objects and skips no-op batches', async () => {
    const { provider, sessions } = fakeProvider();
    const { hub } = setup([provider]);
    hub.setConnections([conn('c')]);
    hub.setBindings([bind('a', 'v', 'c', 's1'), bind('b', 'v', 'c', 's2')]);
    await hub.settled();
    sessions[0]!.emit([{ source: 's1', value: 1, ts: 1 }, { source: 's2', value: 2, ts: 1 }]);
    const first = hub.getSnapshot();
    sessions[0]!.emit([{ source: 's2', value: 3, ts: 2 }]);
    const second = hub.getSnapshot();
    expect(second).not.toBe(first);
    expect(second.metrics.a).toBe(first.metrics.a);
    expect(second.metrics.b).toEqual({ v: 3 });
    const listener = vi.fn();
    hub.subscribe(listener);
    sessions[0]!.emit([{ source: 's2', value: 3, ts: 3 }]);
    expect(listener).not.toHaveBeenCalled();
    expect(hub.getSnapshot()).toBe(second);
  });

  it('ignores samples whose value is not a signal value', async () => {
    const { provider, sessions } = fakeProvider();
    const { hub } = setup([provider]);
    hub.setConnections([conn('c')]);
    hub.setBindings([bind('a', 'v', 'c', 's')]);
    await hub.settled();
    sessions[0]!.emit([{ source: 's', value: { nested: true } as never, ts: 1 }]);
    expect(hub.getSnapshot().metrics).toEqual({});
  });

  it('resubscribes only when the bound source set changes, and drops values of removed bindings', async () => {
    const { provider, sessions } = fakeProvider();
    const { hub } = setup([provider]);
    hub.setConnections([conn('c')]);
    hub.setBindings([bind('a', 'v', 'c', 's1')]);
    await hub.settled();
    sessions[0]!.emit([{ source: 's1', value: 1, ts: 1 }]);
    hub.setBindings([bind('a2', 'v', 'c', 's1')]); // same source set
    expect(sessions[0]!.subscribed).toHaveLength(1);
    expect(hub.getSnapshot().metrics).toEqual({ a2: { v: 1 } });
    hub.setBindings([bind('b', 'v', 'c', 's2')]);
    expect(sessions[0]!.subscribed).toEqual([['s1'], ['s2']]);
    expect(hub.getSnapshot().metrics).toEqual({});
    hub.setBindings([]);
    expect(sessions[0]!.subscribed).toHaveLength(2);
    sessions[0]!.emit([{ source: 's2', value: 5, ts: 1 }]);
    expect(hub.getSnapshot().metrics).toEqual({});
  });

  it('lets the last binding of a duplicated object param win', async () => {
    const { provider, sessions } = fakeProvider();
    const { hub } = setup([provider]);
    hub.setConnections([conn('c')]);
    hub.setBindings([bind('a', 'v', 'c', 'first'), bind('a', 'v', 'c', 'second')]);
    await hub.settled();
    expect(sessions[0]!.subscribed).toEqual([['second']]);
  });

  it('reopens on provider or config change, not on key order, and closes removed connections', async () => {
    const one = fakeProvider('test.one');
    const two = fakeProvider('test.two');
    const { hub } = setup([one.provider, two.provider]);
    hub.setConnections([conn('c', 'test.one', { region: 'eu', n: 1 })]);
    hub.setBindings([bind('a', 'v', 'c', 's')]);
    await hub.settled();
    hub.setConnections([conn('c', 'test.one', { n: 1, region: 'eu' })]);
    await hub.settled();
    expect(one.sessions).toHaveLength(1);

    one.sessions[0]!.emit([{ source: 's', value: 1, ts: 1 }]);
    hub.setConnections([conn('c', 'test.one', { region: 'us', n: 1 })]);
    expect(hub.getSnapshot().metrics).toEqual({}); // old session's values are gone
    await hub.settled();
    expect(one.sessions).toHaveLength(2);
    expect(one.sessions[0]!.closed).toBe(true);
    expect(one.sessions[1]!.subscribed).toEqual([['s']]);

    hub.setConnections([conn('c', 'test.two')]);
    await hub.settled();
    expect(one.sessions[1]!.closed).toBe(true);
    expect(two.sessions).toHaveLength(1);

    hub.setConnections([]);
    await hub.settled();
    expect(two.sessions[0]!.closed).toBe(true);
    expect(hub.getSnapshot().connections).toEqual({});
  });

  it('uses the last definition when connection ids repeat', async () => {
    const one = fakeProvider('test.one');
    const two = fakeProvider('test.two');
    const { hub } = setup([one.provider, two.provider]);
    hub.setConnections([conn('c', 'test.one'), conn('c', 'test.two')]);
    await hub.settled();
    expect(one.sessions).toHaveLength(0);
    expect(two.sessions).toHaveLength(1);
    expect(hub.getSnapshot().connections.c?.provider).toBe('test.two');
  });

  it('gives providers a private copy of config, plus secrets and context', async () => {
    const { provider, sessions } = fakeProvider();
    const { hub, secret } = setup([provider]);
    const config = { region: 'eu', nested: { a: 1 } };
    hub.setConnections([conn('prod', 'test.fake', config)]);
    await hub.settled();
    const session = sessions[0]!;
    expect(session.config).toEqual(config);
    (session.config.nested as { a: number }).a = 99;
    expect(config.nested.a).toBe(1);
    expect(await session.ctx.secret('accessKey')).toBe('prod/accessKey');
    expect(secret).toHaveBeenCalledWith('prod', 'accessKey');
    expect(session.ctx.connectionId).toBe('prod');
    expect(session.ctx.now()).toBe(42);
    expect(session.ctx.signal.aborted).toBe(false);
    hub.setConnections([]);
    expect(session.ctx.signal.aborted).toBe(true);
  });

  it('reports a missing provider and connects once its package is installed; uninstall closes it', async () => {
    const { provider, sessions } = fakeProvider();
    const { hub, registry } = setup();
    hub.setConnections([conn('c')]);
    hub.setBindings([bind('a', 'v', 'c', 's')]);
    expect(hub.getSnapshot().connections.c?.status).toEqual({
      state: 'error',
      message: 'provider "test.fake" is not installed',
      since: 42,
    });
    registry.install({ id: 'late.pkg', version: '1.0.0', contributions: { 'holodeck.provider': [provider] } });
    await hub.settled();
    expect(hub.getSnapshot().connections.c?.status.state).toBe('live');
    expect(sessions[0]!.subscribed).toEqual([['s']]);
    sessions[0]!.emit([{ source: 's', value: 1, ts: 1 }]);
    registry.uninstall('late.pkg');
    await hub.settled();
    expect(sessions[0]!.closed).toBe(true);
    expect(hub.getSnapshot().connections.c?.status.state).toBe('error');
    expect(hub.getSnapshot().metrics).toEqual({});
  });

  it('reports connect failures (rejected and thrown) as error status', async () => {
    const rejected = fakeProvider('test.rejects', { fail: new Error('bad credentials') });
    const thrown = fakeProvider('test.throws', { throwSync: 'boom' });
    const { hub, log } = setup([rejected.provider, thrown.provider]);
    hub.setConnections([conn('r', 'test.rejects'), conn('t', 'test.throws')]);
    await hub.settled();
    const { connections } = hub.getSnapshot();
    expect(connections.r?.status).toMatchObject({ state: 'error', message: 'bad credentials' });
    expect(connections.t?.status).toMatchObject({ state: 'error', message: 'boom' });
    expect(log).toHaveBeenCalledWith('warn', 'connection "r" failed', expect.any(Error));
  });

  it('closes a session that arrives after its connection was superseded', async () => {
    let release: () => void = () => {};
    const delay = new Promise<void>((r) => (release = r));
    const slow = fakeProvider('test.slow', { delay });
    const { hub } = setup([slow.provider]);
    hub.setConnections([conn('c', 'test.slow')]);
    hub.setConnections([]);
    release();
    await hub.settled();
    expect(slow.sessions).toHaveLength(1);
    expect(slow.sessions[0]!.closed).toBe(true);
  });

  it('mirrors session status changes', async () => {
    const { provider, sessions } = fakeProvider();
    const { hub } = setup([provider]);
    hub.setConnections([conn('c')]);
    await hub.settled();
    const listener = vi.fn();
    hub.subscribe(listener);
    sessions[0]!.setStatus('stale', 'no data for 5 min');
    expect(hub.getSnapshot().connections.c?.status).toEqual({ state: 'stale', message: 'no data for 5 min', since: 1 });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('keeps notifying other listeners when one throws', async () => {
    const { provider } = fakeProvider();
    const { hub, log } = setup([provider]);
    const good = vi.fn();
    hub.subscribe(() => {
      throw new Error('render failed');
    });
    hub.subscribe(good);
    hub.setConnections([conn('c')]);
    expect(good).toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith('error', 'ProviderHub listener threw', expect.any(Error));
  });

  it('unsubscribed listeners are no longer called', () => {
    const { hub } = setup();
    const listener = vi.fn();
    const off = hub.subscribe(listener);
    off();
    hub.setConnections([]);
    expect(listener).not.toHaveBeenCalled();
  });

  describe('write', () => {
    it('writes through the binding, inverting scale transforms', async () => {
      const { provider, sessions } = fakeProvider('test.fake', { write: true });
      const { hub } = setup([provider]);
      hub.setConnections([conn('c')]);
      hub.setBindings([
        bind('slider', 'value', 'c', 'sp', { kind: 'scale', inMin: 0, inMax: 100, outMin: 0, outMax: 1 }),
        bind('btn', 'on', 'c', 'cmd'),
        bind('lamp', 'color', 'c', 'state', { kind: 'map', cases: {} }),
      ]);
      await hub.settled();
      await hub.write('slider', 'value', 0.25);
      await hub.write('btn', 'on', true);
      expect(sessions[0]!.write).toHaveBeenNthCalledWith(1, 'sp', 25);
      expect(sessions[0]!.write).toHaveBeenNthCalledWith(2, 'cmd', true);
      await expect(hub.write('lamp', 'color', 'red')).rejects.toMatchObject({ code: 'NOT_INVERTIBLE' });
      await expect(hub.write('slider', 'value', 'x')).rejects.toThrow(TypeError);
      await expect(hub.write('btn', 'on', {} as never)).rejects.toThrow(TypeError);
      await expect(hub.write('nobody', 'x', 1)).rejects.toMatchObject({ code: 'UNBOUND' });
    });

    it('refuses read-only providers and unconnected connections', async () => {
      const { provider } = fakeProvider();
      const { hub } = setup([provider]);
      hub.setConnections([conn('c'), conn('ghost', 'test.missing')]);
      hub.setBindings([bind('a', 'v', 'c', 's'), bind('b', 'v', 'ghost', 's')]);
      await expect(hub.write('a', 'v', 1)).rejects.toMatchObject({ code: 'NOT_CONNECTED' });
      await hub.settled();
      await expect(hub.write('a', 'v', 1)).rejects.toMatchObject({ code: 'NOT_WRITABLE' });
      await expect(hub.write('b', 'v', 1)).rejects.toBeInstanceOf(ProviderHubError);
    });
  });

  it('exposes the live session for browse/history/deploy UIs', async () => {
    const { provider, sessions } = fakeProvider();
    const { hub } = setup([provider]);
    hub.setConnections([conn('c')]);
    expect(hub.session('c')).toBeUndefined();
    await hub.settled();
    expect(hub.session('c')).toBe(sessions[0]);
  });

  it('dispose closes every session, silences listeners and rejects further use', async () => {
    const { provider, sessions } = fakeProvider();
    const { hub, registry } = setup([provider]);
    hub.setConnections([conn('a'), conn('b')]);
    await hub.settled();
    const listener = vi.fn();
    hub.subscribe(listener);
    await hub.dispose();
    await hub.dispose();
    expect(sessions.every((s) => s.closed)).toBe(true);
    registry.uninstall('pkg.providers');
    expect(listener).not.toHaveBeenCalled();
    expect(() => hub.setConnections([])).toThrow(ProviderHubError);
    expect(() => hub.setBindings([])).toThrow(/disposed/);
    await expect(hub.write('a', 'b', 1)).rejects.toMatchObject({ code: 'DISPOSED' });
  });

  it('works end to end with the sim provider', async () => {
    const manual = createManualSchedule();
    let now = 0;
    const registry = new ContributionRegistry();
    registry.registerKind(PROVIDER_KIND);
    registry.install({
      id: 'holodeck.sim',
      version: '1.0.0',
      contributions: { 'holodeck.provider': [createSimProvider({ schedule: manual.schedule })] },
    });
    const hub = new ProviderHub({ registry, now: () => now });
    hub.setConnections([conn('demo', 'holodeck.sim')]);
    hub.setBindings([bind('tank', 'level', 'demo', 'ramp:10', { kind: 'scale', inMin: 0, inMax: 100, outMin: 0, outMax: 1 })]);
    await hub.settled();
    expect(hub.getSnapshot().metrics.tank?.level).toBe(0);
    now = 5000;
    manual.tick();
    expect(hub.getSnapshot().metrics.tank?.level).toBeCloseTo(0.5);
    await hub.dispose();
    expect(manual.active).toBe(0);
  });
});

describe('ProviderHub disposal waits for every close (GPT review sdk#23 r2 P2)', () => {
  const gate = () => {
    let open: () => void = () => {};
    const promise = new Promise<void>((r) => (open = r));
    return { promise, open };
  };
  const resolved = async (p: Promise<unknown>) => {
    let done = false;
    void p.then(() => (done = true));
    for (let i = 0; i < 5; i++) await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    return done;
  };

  it('awaits a slow close of a connection removed before dispose', async () => {
    const closing = gate();
    const { provider, sessions } = fakeProvider('test.fake', { closeDelay: closing.promise });
    const { hub } = setup([provider]);
    hub.setConnections([conn('c')]);
    await hub.settled();
    hub.setConnections([]);
    const disposed = hub.dispose();
    expect(await resolved(disposed)).toBe(false);
    closing.open();
    await disposed;
    expect(sessions[0]!.closed).toBe(true);
  });

  it('awaits the close of a session whose connect was still pending at dispose', async () => {
    const connecting = gate();
    const closing = gate();
    const { provider, sessions } = fakeProvider('test.fake', { delay: connecting.promise, closeDelay: closing.promise });
    const { hub } = setup([provider]);
    hub.setConnections([conn('c')]);
    const disposed = hub.dispose();
    connecting.open();
    expect(await resolved(disposed)).toBe(false);
    expect(sessions).toHaveLength(1);
    closing.open();
    await disposed;
    expect(sessions[0]!.closed).toBe(true);
  });

  it('logs a close() that throws synchronously and still disposes', async () => {
    const { provider } = fakeProvider('test.fake', { closeThrows: true });
    const { hub, log } = setup([provider]);
    hub.setConnections([conn('c')]);
    await hub.settled();
    await hub.dispose();
    expect(log).toHaveBeenCalledWith('warn', 'closing "c" failed', expect.any(Error));
  });
});

describe('ProviderHub session setup failures (GPT review sdk#23 r3 P2)', () => {
  const broken = (fail: 'status' | 'onStatus'): { provider: HolodeckProvider; closed: () => boolean } => {
    let closed = false;
    return {
      closed: () => closed,
      provider: {
        id: 'test.broken',
        label: 'Broken',
        capabilities: {},
        async connect() {
          return {
            status: () => {
              if (fail === 'status') throw new Error('status exploded');
              return { state: 'live', since: 0 };
            },
            onStatus: () => {
              if (fail === 'onStatus') throw new Error('onStatus exploded');
              return () => {};
            },
            subscribe: () => () => {},
            close: async () => {
              closed = true;
            },
          };
        },
      },
    };
  };

  it.each(['status', 'onStatus'] as const)('a throwing %s() closes the session, reports error and settles', async (fail) => {
    const b = broken(fail);
    const { hub, log } = setup([b.provider]);
    hub.setConnections([conn('c', 'test.broken')]);
    hub.setBindings([bind('a', 'v', 'c', 's')]);
    await hub.settled();
    expect(hub.getSnapshot().connections.c?.status).toMatchObject({ state: 'error', message: `session setup failed: ${fail} exploded` });
    expect(hub.session('c')).toBeUndefined();
    await hub.dispose();
    expect(b.closed()).toBe(true);
    expect(log).toHaveBeenCalledWith('warn', 'connection "c" setup failed', expect.any(Error));
  });
});

describe('ProviderHub sessions removed around setup (GPT review sdk#23 r4 P2)', () => {
  const eager = (onStatusCall?: () => void) => {
    const calls = { closed: 0, unsubscribed: 0 };
    const provider: HolodeckProvider = {
      id: 'test.eager',
      label: 'Eager',
      capabilities: {},
      async connect() {
        return {
          status: () => {
            onStatusCall?.();
            return { state: 'connecting', since: 0 };
          },
          onStatus: (listener) => {
            listener({ state: 'live', since: 1 }); // delivered synchronously, during setup
            return () => calls.unsubscribed++;
          },
          subscribe: () => () => {},
          close: async () => {
            calls.closed++;
          },
        };
      },
    };
    return { provider, calls };
  };

  it('immediate status + a listener that removes the connection: session closed and unsubscribed', async () => {
    const { provider, calls } = eager();
    const { hub } = setup([provider]);
    let removed = false;
    hub.subscribe(() => {
      if (!removed && hub.getSnapshot().connections.c?.status.state === 'live') {
        removed = true;
        hub.setConnections([]);
      }
    });
    hub.setConnections([conn('c', 'test.eager')]);
    await hub.settled();
    await hub.dispose();
    expect(removed).toBe(true);
    expect(calls).toEqual({ closed: 1, unsubscribed: 1 });
  });

  it('a connection removed by a re-entrant call during setup is still closed and unsubscribed', async () => {
    let hub!: ProviderHub;
    const { provider, calls } = eager(() => hub.setConnections([]));
    ({ hub } = setup([provider]));
    hub.setConnections([conn('c', 'test.eager')]);
    await hub.settled();
    expect(hub.getSnapshot().connections).toEqual({});
    await hub.dispose();
    expect(calls).toEqual({ closed: 1, unsubscribed: 1 });
  });
});

describe('ProviderHub sweep: synchronous subscribe and caller-owned input (GPT review sdk#23 r5)', () => {
  /** A provider whose subscribe() delivers synchronously and tracks live handles. */
  const syncProvider = () => {
    const live = new Map<number, readonly string[]>();
    let next = 0;
    const provider: HolodeckProvider = {
      id: 'test.sync',
      label: 'Sync',
      capabilities: {},
      async connect() {
        return {
          status: () => ({ state: 'live', since: 0 }),
          onStatus: () => () => {},
          subscribe(sources, onSamples) {
            const token = ++next;
            live.set(token, [...sources]);
            onSamples(sources.map((source) => ({ source, value: source.length, ts: 1 })));
            return () => live.delete(token);
          },
          close: async () => {},
        };
      },
    };
    return { provider, live };
  };

  it('P2: rebinding from a listener during the first synchronous sample leaves exactly the newest subscription', async () => {
    const { provider, live } = syncProvider();
    const { hub } = setup([provider]);
    let rebound = false;
    hub.subscribe(() => {
      if (rebound || !hub.getSnapshot().metrics.a) return;
      rebound = true;
      hub.setBindings([bind('b', 'v', 'c', 'second')]);
    });
    hub.setConnections([conn('c', 'test.sync')]);
    hub.setBindings([bind('a', 'v', 'c', 'first')]);
    await hub.settled();
    expect(rebound).toBe(true);
    expect([...live.values()]).toEqual([['second']]);
    expect(hub.getSnapshot().metrics).toEqual({ b: { v: 6 } });
    await hub.dispose();
  });

  it('P2: removing the connection from a listener during the first synchronous sample leaves no subscription', async () => {
    const { provider, live } = syncProvider();
    const { hub } = setup([provider]);
    hub.subscribe(() => {
      if (hub.getSnapshot().metrics.a) hub.setConnections([]);
    });
    hub.setConnections([conn('c', 'test.sync')]);
    hub.setBindings([bind('a', 'v', 'c', 'first')]);
    await hub.settled();
    expect(live.size).toBe(0);
    await hub.dispose();
  });

  it('snapshots connections, bindings and options; later edits to the caller objects change nothing', async () => {
    const { provider, sessions } = fakeProvider();
    let clock = 5;
    const options = { registry: new ContributionRegistry(), now: () => clock };
    options.registry.registerKind(PROVIDER_KIND);
    options.registry.install({ id: 'p', version: '1.0.0', contributions: { 'holodeck.provider': [provider] } });
    const hub = new ProviderHub(options);
    const connection = { id: 'c', provider: 'test.fake', config: { region: 'eu' } };
    const ref = bind('a', 'v', 'c', 's', { kind: 'scale', inMin: 0, inMax: 10, outMin: 0, outMax: 1 });
    hub.setConnections([connection]);
    hub.setBindings([ref]);
    await hub.settled();
    connection.provider = 'test.other';
    connection.config.region = 'us';
    (ref.binding as { source: string }).source = 'elsewhere';
    (ref.binding.transform as { inMax: number }).inMax = 1000;
    options.now = () => 999;
    clock = 6;
    sessions[0]!.emit([{ source: 's', value: 5, ts: 1 }]);
    expect(hub.getSnapshot().metrics).toEqual({ a: { v: 0.5 } });
    expect(hub.getSnapshot().connections.c?.provider).toBe('test.fake');
    expect(sessions[0]!.config).toEqual({ region: 'eu' });
    hub.setConnections([connection]); // re-sent after mutation: provider changed → reopen is now explicit
    expect(hub.getSnapshot().connections.c?.status).toMatchObject({ state: 'error', since: 6 });
    await hub.dispose();
  });

  it('rejects malformed connections and bindings with one TypeError', () => {
    const { hub } = setup();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => hub.setConnections([{ id: 'c', provider: 'p', config: cyclic }])).toThrow(/cycle/);
    expect(() => hub.setConnections([{ id: '', provider: 'p' }])).toThrow(TypeError);
    expect(() => hub.setConnections([{ id: 'c', provider: 'p', config: [] as never }])).toThrow(/config/);
    expect(() =>
      hub.setBindings([
        bind('a', 'v', 'c', ''),
        { objectId: '', param: 'v', binding: { connection: 'c', source: 's' } },
        bind('b', 'v', 'c', 's', { kind: 'scale' } as never),
      ]),
    ).toThrow(/invalid bindings:\n- bindings\[0\][\s\S]*bindings\[1\][\s\S]*bindings\[2\]\.transform/);
  });

  it('snapshots are frozen; provider status objects are copied and validated', async () => {
    let status: Record<string, unknown> = { state: 'live', since: 1 };
    let listener: ((s: never) => void) | undefined;
    const provider: HolodeckProvider = {
      id: 'test.status',
      label: 'Status',
      capabilities: {},
      async connect() {
        return {
          status: () => status as never,
          onStatus: (l) => ((listener = l as never), () => {}),
          subscribe: (sources, onSamples) => (onSamples(sources.map((source) => ({ source, value: 1, ts: 1 }))), () => {}),
          close: async () => {},
        };
      },
    };
    const { hub } = setup([provider]);
    hub.setConnections([conn('c', 'test.status')]);
    hub.setBindings([bind('a', 'v', 'c', 's')]);
    await hub.settled();
    const snap = hub.getSnapshot();
    expect(Object.isFrozen(snap) && Object.isFrozen(snap.metrics) && Object.isFrozen(snap.metrics.a)).toBe(true);
    expect(() => {
      (snap.metrics.a as Record<string, unknown>).v = 2;
    }).toThrow(TypeError);
    expect(() => {
      (snap.connections as Record<string, unknown>).x = 1;
    }).toThrow(TypeError);
    status.state = 'error'; // provider mutates its own object later
    expect(hub.getSnapshot().connections.c?.status.state).toBe('live');
    status = { nonsense: true };
    listener!(status as never);
    expect(hub.getSnapshot().connections.c?.status).toMatchObject({ state: 'error', message: 'provider returned an invalid status' });
    await hub.dispose();
  });
});

describe('ProviderHub re-sweep: provider objects and every stored status (GPT review sdk#23 r6)', () => {
  /** A provider driven by the test: `emit` delivers, `handles` counts live subscriptions. */
  const scripted = (opts: { unsubscribeThrows?: boolean; subscribeThrowsOnce?: boolean; statusUnsubThrows?: boolean } = {}) => {
    const live = new Map<number, readonly string[]>();
    let sink: ((s: readonly Sample[]) => void) | undefined;
    let next = 0;
    let statusOffCalls = 0;
    let failNext = opts.subscribeThrowsOnce ?? false;
    const provider: HolodeckProvider = {
      id: 'test.scripted',
      label: 'Scripted',
      capabilities: {},
      async connect() {
        return {
          status: () => ({ state: 'live', since: 0 }),
          onStatus: () => () => {
            statusOffCalls++;
            if (opts.statusUnsubThrows) throw new Error('status unsubscribe threw');
          },
          subscribe(sources, onSamples) {
            if (failNext) {
              failNext = false;
              throw new Error('subscribe threw');
            }
            const token = ++next;
            live.set(token, [...sources]);
            sink = onSamples;
            return () => {
              live.delete(token);
              if (opts.unsubscribeThrows) throw new Error('unsubscribe threw');
            };
          },
          close: async () => {},
        };
      },
    };
    return { provider, live, emit: (samples: unknown) => sink?.(samples as readonly Sample[]), statusOffCalls: () => statusOffCalls };
  };

  it('P2: a provider reusing and mutating its Sample object cannot change stored values without a delivery', async () => {
    const p = scripted();
    const { hub } = setup([p.provider]);
    hub.setConnections([conn('c', 'test.scripted')]);
    hub.setBindings([bind('a', 'v', 'c', 's')]);
    await hub.settled();
    const reused = { source: 's', value: 10 as number, ts: 1 };
    p.emit([reused]);
    reused.value = 99;
    expect(hub.getSnapshot().metrics.a).toEqual({ v: 10 });
    hub.setBindings([bind('a', 'v', 'c', 's'), bind('b', 'v', 'c', 's')]); // recompute from stored samples
    expect(hub.getSnapshot().metrics).toEqual({ a: { v: 10 }, b: { v: 10 } });
    p.emit([reused]);
    expect(hub.getSnapshot().metrics.a).toEqual({ v: 99 });
  });

  it('ignores malformed deliveries and maps unknown quality to uncertain', async () => {
    const p = scripted();
    const { hub, log } = setup([p.provider]);
    hub.setConnections([conn('c', 'test.scripted')]);
    hub.setBindings([bind('a', 'v', 'c', 's')]);
    await hub.settled();
    p.emit({ source: 's', value: 1 });
    expect(log).toHaveBeenCalledWith('warn', 'provider for "c" delivered a non-array', expect.anything());
    p.emit([null, { source: 's' }, { source: 's', value: 2, ts: 1, quality: 'excellent' }]);
    expect(hub.getSnapshot().metrics.a).toEqual({ v: 2 });
    expect(hub.getSnapshot().quality.a).toEqual({ v: 'uncertain' });
  });

  it('P2: an unsubscribe that throws during a → b still subscribes b', async () => {
    const p = scripted({ unsubscribeThrows: true });
    const { hub, log } = setup([p.provider]);
    hub.setConnections([conn('c', 'test.scripted')]);
    hub.setBindings([bind('x', 'v', 'c', 'a')]);
    await hub.settled();
    hub.setBindings([bind('x', 'v', 'c', 'b')]);
    expect([...p.live.values()]).toEqual([['b']]);
    expect(log).toHaveBeenCalledWith('warn', 'unsubscribing "c" failed', expect.any(Error));
  });

  it('P2: a failed subscribe is retried by the next setBindings with the same sources', async () => {
    const p = scripted({ subscribeThrowsOnce: true });
    const { hub } = setup([p.provider]);
    hub.setConnections([conn('c', 'test.scripted')]);
    await hub.settled();
    hub.setBindings([bind('x', 'v', 'c', 'b')]);
    expect(hub.getSnapshot().connections.c?.status).toMatchObject({ state: 'error', message: 'subscribe failed: subscribe threw' });
    expect(p.live.size).toBe(0);
    hub.setBindings([bind('x', 'v', 'c', 'b')]);
    expect([...p.live.values()]).toEqual([['b']]);
  });

  it('closing a connection runs the status unsubscribe even when the sample unsubscribe throws', async () => {
    const p = scripted({ unsubscribeThrows: true });
    const { hub } = setup([p.provider]);
    hub.setConnections([conn('c', 'test.scripted')]);
    hub.setBindings([bind('x', 'v', 'c', 'a')]);
    await hub.settled();
    hub.setConnections([]);
    expect(p.statusOffCalls()).toBe(1);
    expect(p.live.size).toBe(0);
  });

  it('P2: every status in a snapshot is frozen, including connecting, missing-provider and failure paths', async () => {
    const slow = fakeProvider('test.slow', { delay: new Promise(() => {}) });
    const failing = fakeProvider('test.fails', { fail: new Error('nope') });
    const { hub } = setup([slow.provider, failing.provider]);
    expect(Object.isFrozen(hub.getSnapshot().metrics) && Object.isFrozen(hub.getSnapshot().quality)).toBe(true);
    hub.setConnections([conn('pending', 'test.slow'), conn('missing', 'test.none'), conn('failed', 'test.fails')]);
    const before = hub.getSnapshot().connections;
    expect(before.pending?.status.state).toBe('connecting');
    expect(before.missing?.status.state).toBe('error');
    for (const entry of Object.values(before)) {
      expect(Object.isFrozen(entry) && Object.isFrozen(entry.status)).toBe(true);
      expect(() => {
        (entry.status as { state: string }).state = 'live';
      }).toThrow(TypeError);
    }
    await new Promise((r) => setTimeout(r, 0));
    expect(Object.isFrozen(hub.getSnapshot().connections.failed?.status)).toBe(true);
    expect(hub.getSnapshot().connections.failed?.status.state).toBe('error');
  });

  it('write capability is captured when the connection opens', async () => {
    const { provider, sessions } = fakeProvider('test.fake', { write: true });
    const { hub } = setup([provider]);
    hub.setConnections([conn('c')]);
    hub.setBindings([bind('a', 'v', 'c', 's')]);
    await hub.settled();
    (provider.capabilities as { write?: boolean }).write = false; // later edits to the provider object do not matter
    await hub.write('a', 'v', 1);
    expect(sessions[0]!.write).toHaveBeenCalledWith('s', 1);
  });
});

describe('ProviderHub with hostile ids (GPT review sdk#23 P1)', () => {
  it('never writes through __proto__ object ids, params or connection ids', async () => {
    const { provider, sessions } = fakeProvider();
    const { hub } = setup([provider]);
    hub.setConnections([conn('__proto__')]);
    hub.setBindings([bind('__proto__', 'polluted', '__proto__', 's'), bind('a', 'constructor', '__proto__', 's')]);
    await hub.settled();
    sessions[0]!.emit([{ source: 's', value: 1, ts: 1 }]);
    hub.setBindings([bind('__proto__', 'polluted', '__proto__', 's'), bind('a', 'constructor', '__proto__', 's')]); // recomputeAll
    const probe: Record<string, unknown> = {};
    expect(probe.polluted).toBeUndefined();
    expect(Object.prototype).not.toHaveProperty('polluted');
    const snap = hub.getSnapshot();
    expect(Object.keys(snap.metrics).sort()).toEqual(['__proto__', 'a']);
    expect(Object.getOwnPropertyDescriptor(snap.metrics, '__proto__')?.value).toEqual({ polluted: 1 });
    expect(Object.getOwnPropertyDescriptor(snap.metrics.a, 'constructor')?.value).toBe(1);
    expect(Object.keys(snap.connections)).toEqual(['__proto__']);
    await hub.dispose();
  });

  it('does not treat inherited members as existing params', async () => {
    const { provider, sessions } = fakeProvider();
    const { hub } = setup([provider]);
    hub.setConnections([conn('c')]);
    hub.setBindings([bind('a', 'toString', 'c', 's')]);
    await hub.settled();
    const listener = vi.fn();
    hub.subscribe(listener);
    sessions[0]!.emit([{ source: 's', value: 5, ts: 1 }]);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(hub.getSnapshot().metrics.a).toEqual({ toString: 5 });
  });
});

describe('ProviderHub follow-ups (#24, #27)', () => {
  it('#24: ids and sources containing NUL cannot collide', async () => {
    const { provider, sessions } = fakeProvider('test.fake', { write: true });
    const { hub } = setup([provider]);
    hub.setConnections([conn('c')]);
    hub.setBindings([bind('a\u0000b', 'c', 'c', 's1'), bind('a', 'b\u0000c', 'c', 's2')]);
    await hub.settled();
    sessions[0]!.emit([{ source: 's1', value: 1, ts: 1 }, { source: 's2', value: 2, ts: 1 }]);
    expect(hub.getSnapshot().metrics).toEqual({ 'a\u0000b': { c: 1 }, a: { 'b\u0000c': 2 } });
    await hub.write('a', 'b\u0000c', 5);
    expect(sessions[0]!.write).toHaveBeenCalledWith('s2', 5);
    // source lists ['x\u0000y'] and ['x', 'y'] are different subscriptions
    hub.setBindings([bind('o', 'p', 'c', 'x\u0000y')]);
    hub.setBindings([bind('o', 'p', 'c', 'x'), bind('o', 'q', 'c', 'y')]);
    expect(sessions[0]!.subscribed.slice(-2)).toEqual([['x\u0000y'], ['x', 'y']]);
  });

  it('#27: a successful retry restores the session status; a genuine provider error is kept', async () => {
    let failNext = true;
    let providerState: ProviderStatus = { state: 'live', since: 0 };
    const provider: HolodeckProvider = {
      id: 'test.transitions',
      label: 'Transitions only',
      capabilities: {},
      async connect() {
        return {
          status: () => providerState,
          onStatus: () => () => {}, // emits only on transitions; none happen here
          subscribe() {
            if (failNext) {
              failNext = false;
              throw new Error('flaky');
            }
            return () => {};
          },
          close: async () => {},
        };
      },
    };
    const { hub } = setup([provider]);
    hub.setConnections([conn('c', 'test.transitions')]);
    await hub.settled();
    hub.setBindings([bind('a', 'v', 'c', 's')]);
    expect(hub.getSnapshot().connections.c?.status.state).toBe('error');
    hub.setBindings([bind('a', 'v', 'c', 's')]);
    expect(hub.getSnapshot().connections.c?.status).toEqual({ state: 'live', since: 0 });

    failNext = true;
    hub.setBindings([bind('a', 'v', 'c', 't')]);
    providerState = { state: 'error', message: 'throttled', since: 3 };
    hub.setBindings([bind('a', 'v', 'c', 't')]);
    expect(hub.getSnapshot().connections.c?.status).toEqual({ state: 'error', message: 'throttled', since: 3 });
  });
});

describe('invertTransform', () => {
  it('passes values through without a transform and keeps null', () => {
    expect(invertTransform(undefined, 3)).toBe(3);
    expect(invertTransform({ kind: 'map', cases: {} }, null)).toBeNull();
  });
  it('inverts scale, clamping unless clamp is false', () => {
    const t = { kind: 'scale', inMin: 10, inMax: 20, outMin: 0, outMax: 1 } as const;
    expect(invertTransform(t, 0.5)).toBe(15);
    expect(invertTransform(t, 2)).toBe(20);
    expect(invertTransform({ ...t, clamp: false }, 2)).toBe(30);
    expect(invertTransform({ ...t, outMin: 1, outMax: 1 }, 5)).toBe(10);
  });
  it('sdk#31 review: finite extrapolation near the limits can be written through', () => {
    const t = { kind: 'scale', inMin: 0, inMax: 1, outMin: 1e308, outMax: 1.1e308, clamp: false } as const;
    expect(invertTransform(t, 1e308 + 2 * (1.1e308 - 1e308))).toBeCloseTo(2, 10);
    expect(invertTransform({ kind: 'scale', inMin: 0, inMax: 1, outMin: 0, outMax: Number.MIN_VALUE }, Number.MIN_VALUE)).toBe(1);
  });

  it('#32: inverse stays finite when only the offset overflows', () => {
    expect(invertTransform({ kind: 'scale', inMin: 0, inMax: 1, outMin: -1e308, outMax: -9e307, clamp: false }, 1e308)).toBeCloseTo(20, 10);
  });

  it('#28: stays finite for wide ranges and rejects values that cannot map', () => {
    const wide = { kind: 'scale', inMin: -1e308, inMax: 1e308, outMin: 0, outMax: 1 } as const;
    expect(invertTransform(wide, 0.5)).toBe(0);
    expect(invertTransform(wide, 1)).toBe(1e308);
    expect(() => invertTransform({ ...wide, clamp: false }, 1e300)).toThrow(/finite/);
    expect(() => invertTransform(wide, Number.NaN)).toThrow(/finite number/);
  });
});
