import { describe, expect, it, vi } from 'vitest';
import {
  SIM_PROVIDER_ID,
  createManualSchedule,
  createProviderContext,
  createSimProvider,
  isHolodeckProvider,
  runProviderConformance,
  type HolodeckProvider,
  type ProviderStatus,
  type Sample,
} from './provider';
import { HOLODECK_DOCUMENT_FORMAT } from './document';

async function simSession(now = 0) {
  const manual = createManualSchedule();
  let t = now;
  const provider = createSimProvider({ schedule: manual.schedule, intervalMs: 100 });
  const controller = new AbortController();
  const session = await provider.connect({}, createProviderContext({ now: () => t, signal: controller.signal }));
  return { provider, session, manual, controller, setNow: (v: number) => (t = v) };
}

describe('isHolodeckProvider', () => {
  const base = (): Record<string, unknown> => ({
    id: 'aws.cloudwatch',
    label: 'CloudWatch',
    capabilities: { read: true },
    connect: async () => ({}),
  });
  it('accepts a well-formed provider', () => {
    expect(isHolodeckProvider(base())).toBe(true);
    expect(isHolodeckProvider({ ...base(), secrets: [{ key: 'k', label: 'K' }], origins: ['https://a.b'], configSchema: {} })).toBe(true);
  });
  it.each([
    ['bad id', { id: 'AWS' }],
    ['empty label', { label: '' }],
    ['no connect', { connect: 1 }],
    ['no capabilities', { capabilities: undefined }],
    ['unknown capability', { capabilities: { teleport: true } }],
    ['non-boolean capability', { capabilities: { read: 'yes' } }],
    ['bad secrets', { secrets: [{ key: '' }] }],
    ['secrets not array', { secrets: {} }],
    ['bad origins', { origins: [''] }],
    ['bad configSchema', { configSchema: 'x' }],
  ])('rejects %s', (_name, patch) => {
    expect(isHolodeckProvider({ ...base(), ...patch })).toBe(false);
  });
  it('rejects non-objects', () => {
    expect(isHolodeckProvider(null)).toBe(false);
  });
});

describe('sim provider', () => {
  it('is a valid provider with the documented id and capabilities', () => {
    const p = createSimProvider();
    expect(isHolodeckProvider(p)).toBe(true);
    expect(p.id).toBe(SIM_PROVIDER_ID);
    expect(p.capabilities).toEqual({ read: true, write: true, browse: true, history: true });
  });

  it('evaluates waveforms as pure functions of time', async () => {
    const { session } = await simSession();
    const at = async (source: string, ts: number) => (await session.history!(source, { from: ts, to: ts }))[0]!.value;
    expect(await at('sine:4', 0)).toBeCloseTo(50);
    expect(await at('sine:4', 1000)).toBeCloseTo(100);
    expect(await at('sine:4:-1:1', 3000)).toBeCloseTo(-1);
    expect(await at('ramp:10', 2500)).toBeCloseTo(25);
    expect(await at('ramp:10:100:200', -2500)).toBeCloseTo(175);
    expect(await at('square:2', 500)).toBe(true);
    expect(await at('square:2', 1500)).toBe(false);
    expect(await at('const:42', 0)).toBe(42);
    expect(await at('const:"ok"', 0)).toBe('ok');
    expect(await at('const:true', 0)).toBe(true);
    expect(await at('const:null', 0)).toBeNull();
  });

  it('noise is smooth, bounded, seed-dependent and deterministic', async () => {
    const { session } = await simSession();
    const a = await session.history!('noise:7:10:20:1', { from: 0, to: 5000, stepMs: 50 });
    const b = await session.history!('noise:7:10:20:1', { from: 0, to: 5000, stepMs: 50 });
    const c = await session.history!('noise:8:10:20:1', { from: 0, to: 5000, stepMs: 50 });
    expect(a).toEqual(b);
    expect(a.map((s) => s.value)).not.toEqual(c.map((s) => s.value));
    for (const s of a) {
      expect(s.value as number).toBeGreaterThanOrEqual(10);
      expect(s.value as number).toBeLessThanOrEqual(20);
    }
    // continuity: neighbouring samples 50 ms apart never jump more than the range
    for (let i = 1; i < a.length; i++) expect(Math.abs((a[i]!.value as number) - (a[i - 1]!.value as number))).toBeLessThan(2);
  });

  it('reports malformed sources as bad-quality nulls instead of throwing', async () => {
    const { session } = await simSession();
    const read = await session.read!(['sine:0', 'sine:x', 'noise:1.5', 'const:{', 'const:[1]', 'mem:', 'bogus:1', 'ramp:1:a']);
    expect(read.every((s) => s.value === null && s.quality === 'bad')).toBe(true);
  });

  it('subscribe emits immediately and on every tick until unsubscribed', async () => {
    const { session, manual, setNow } = await simSession(1000);
    const batches: Sample[][] = [];
    const stop = session.subscribe(['ramp:10', 'const:1'], (s) => batches.push([...s]));
    expect(batches).toHaveLength(1);
    expect(batches[0]!.map((s) => s.source)).toEqual(['ramp:10', 'const:1']);
    expect(batches[0]![0]!.ts).toBe(1000);
    setNow(2000);
    manual.tick();
    expect(batches).toHaveLength(2);
    expect(batches[1]![0]!.value).toBeCloseTo(20);
    stop();
    stop();
    manual.tick();
    expect(batches).toHaveLength(2);
    expect(manual.active).toBe(0);
  });

  it('mem sources are writable; others are read-only', async () => {
    const { session } = await simSession();
    expect((await session.read!(['mem:sp']))[0]!.value).toBeNull();
    await session.write!('mem:sp', 12.5);
    expect((await session.read!(['mem:sp']))[0]!.value).toBe(12.5);
    await expect(session.write!('sine:1', 1)).rejects.toThrow(/read-only/);
    await expect(session.write!('nope:1', 1)).rejects.toThrow(/unknown sim source/);
    await expect(session.write!('mem:x', {} as never)).rejects.toThrow(TypeError);
  });

  it('browse lists example leaves at the root only', async () => {
    const { session } = await simSession();
    const root = await session.browse!();
    expect(root.length).toBeGreaterThan(3);
    expect(root.every((n) => n.source === n.path)).toBe(true);
    expect(root.find((n) => n.source === 'mem:value')?.writable).toBe(true);
    expect(await session.browse!('sine:10')).toEqual([]);
  });

  it('history validates its range', async () => {
    const { session } = await simSession();
    await expect(session.history!('sine:1', { from: 10, to: 0 })).rejects.toThrow(RangeError);
    await expect(session.history!('sine:1', { from: 0, to: 1e9, stepMs: 1 })).rejects.toThrow(/100000/);
    expect(await session.history!('sine:1', { from: 0, to: 1000 })).toHaveLength(11);
  });

  it('close stops subscriptions, reports disconnected once, and is idempotent', async () => {
    const { session, manual } = await simSession(5);
    const statuses: ProviderStatus[] = [];
    const off = session.onStatus((s) => statuses.push(s));
    let calls = 0;
    session.subscribe(['const:1'], () => calls++);
    await session.close();
    await session.close();
    manual.tick();
    expect(calls).toBe(1);
    expect(session.status()).toEqual({ state: 'disconnected', since: 5 });
    expect(statuses).toHaveLength(1);
    off();
    // subscribing after close is inert
    let late = 0;
    session.subscribe(['const:1'], () => late++)();
    expect(late).toBe(0);
  });

  it('aborting the context signal closes the session', async () => {
    const { session, controller } = await simSession();
    controller.abort();
    await Promise.resolve();
    expect(session.status().state).toBe('disconnected');
  });

  it('passes the provider conformance kit', async () => {
    const failures: string[] = [];
    await runProviderConformance(
      () => createSimProvider({ intervalMs: 5 }),
      { sources: ['sine:1', 'mem:a'] },
      (ok, message) => {
        if (!ok) failures.push(message);
      },
    );
    expect(failures).toEqual([]);
  });
});

describe('runProviderConformance catches broken providers', () => {
  const collect = async (provider: HolodeckProvider, sources = ['a']) => {
    const failures: string[] = [];
    await runProviderConformance(() => provider, { sources, timeoutMs: 30 }, (ok, m) => {
      if (!ok) failures.push(m);
    });
    return failures;
  };

  it('flags missing capabilities, silent subscriptions, leaky unsubscribe and bad close', async () => {
    let timer: ReturnType<typeof setInterval> | undefined;
    const broken: HolodeckProvider = {
      id: 'broken.provider',
      label: 'Broken',
      capabilities: { history: true },
      async connect() {
        return {
          status: () => ({ state: 'live', since: 0 }),
          onStatus: () => () => {},
          subscribe(_sources, onSamples) {
            // ignores the request, keeps emitting after unsubscribe, wrong source
            timer = setInterval(() => onSamples([{ source: 'zzz', value: 1, ts: 0 }]), 2);
            return () => {};
          },
          async close() {},
        };
      },
    };
    const failures = await collect(broken);
    clearInterval(timer);
    expect(failures).toEqual(
      expect.arrayContaining([
        'declared capability "history" is implemented',
        'sample source "zzz" was requested',
        'every source delivered a sample within 30 ms',
        expect.stringMatching(/^no samples are delivered after unsubscribe/),
        'close() leaves the session disconnected',
      ]),
    );
  });

  it('flags read results that miss sources', async () => {
    const provider: HolodeckProvider = {
      id: 'partial.read',
      label: 'Partial',
      capabilities: { read: true },
      async connect() {
        let state: ProviderStatus = { state: 'live', since: 0 };
        return {
          status: () => state,
          onStatus: () => () => {},
          subscribe(sources, onSamples) {
            onSamples(sources.map((source) => ({ source, value: 1, ts: 1 })));
            return () => {};
          },
          read: async () => [],
          async close() {
            state = { state: 'disconnected', since: 1 };
          },
        };
      },
    };
    expect(await collect(provider)).toEqual(['read returns a sample for every source']);
  });

  it('#25: catches a leaked subscription deterministically through flush', async () => {
    const manual = createManualSchedule();
    const leaky: HolodeckProvider = {
      id: 'leaky.provider',
      label: 'Leaky',
      capabilities: {},
      async connect() {
        let state: ProviderStatus = { state: 'live', since: 0 };
        return {
          status: () => state,
          onStatus: () => () => {},
          subscribe(sources, onSamples) {
            const deliver = () => onSamples(sources.map((source) => ({ source, value: 1, ts: 1 })));
            manual.schedule(deliver, 1000); // never cancelled: the leak
            deliver();
            return () => {};
          },
          async close() {
            state = { state: 'disconnected', since: 1 };
          },
        };
      },
    };
    const failures: string[] = [];
    await runProviderConformance(() => leaky, { sources: ['a'], quietMs: 1, flush: () => manual.tick() }, (ok, m) => {
      if (!ok) failures.push(m);
    });
    expect(failures).toEqual(['no samples are delivered after unsubscribe']);
  });

  it('#25: stretches the quiet window to cover slow-ticking providers', async () => {
    let timer: ReturnType<typeof setInterval> | undefined;
    const slowLeak: HolodeckProvider = {
      id: 'slow.leak',
      label: 'Slow leak',
      capabilities: {},
      async connect() {
        let state: ProviderStatus = { state: 'live', since: 0 };
        return {
          status: () => state,
          onStatus: () => () => {},
          subscribe(sources, onSamples) {
            // first source arrives now, the second only on the next 40 ms tick: two deliveries 40 ms apart
            onSamples([{ source: sources[0]!, value: 1, ts: 1 }]);
            timer = setInterval(() => onSamples(sources.map((source) => ({ source, value: 1, ts: 1 }))), 40);
            return () => {};
          },
          async close() {
            state = { state: 'disconnected', since: 1 };
          },
        };
      },
    };
    const failures: string[] = [];
    await runProviderConformance(() => slowLeak, { sources: ['a', 'b'], quietMs: 1 }, (ok, m) => {
      if (!ok) failures.push(m);
    });
    clearInterval(timer);
    expect(failures).toEqual([expect.stringMatching(/^no samples are delivered after unsubscribe/)]);
  });

  it('sdk#31 review: a tiny first-sample timeout does not shorten the unsubscribe check', async () => {
    let timer: ReturnType<typeof setInterval> | undefined;
    const syncLeak: HolodeckProvider = {
      id: 'sync.leak',
      label: 'Sync leak',
      capabilities: {},
      async connect() {
        let state: ProviderStatus = { state: 'live', since: 0 };
        return {
          status: () => state,
          onStatus: () => () => {},
          subscribe(sources, onSamples) {
            const deliver = () => onSamples(sources.map((source) => ({ source, value: 1, ts: 1 })));
            deliver(); // first sample synchronously, inside a 1 ms first-sample budget
            timer = setInterval(deliver, 5); // never cleared: the leak
            return () => {};
          },
          async close() {
            state = { state: 'disconnected', since: 1 };
          },
        };
      },
    };
    const failures: string[] = [];
    await runProviderConformance(() => syncLeak, { sources: ['a'], timeoutMs: 1, quietMs: 1 }, (ok, m) => {
      if (!ok) failures.push(m);
    });
    clearInterval(timer);
    expect(failures).toEqual(['no samples are delivered after unsubscribe']);
  });

  it('sdk#34 review: an async flush does not shorten the quiet window', async () => {
    let leak: ReturnType<typeof setTimeout> | undefined;
    const lateLeak: HolodeckProvider = {
      id: 'late.leak',
      label: 'Late leak',
      capabilities: {},
      async connect() {
        let state: ProviderStatus = { state: 'live', since: 0 };
        return {
          status: () => state,
          onStatus: () => () => {},
          subscribe(sources, onSamples) {
            onSamples(sources.map((source) => ({ source, value: 1, ts: 1 })));
            // Leak: one more delivery 250 ms after unsubscribe.
            return () => {
              leak = setTimeout(() => onSamples(sources.map((source) => ({ source, value: 2, ts: 2 }))), 250);
            };
          },
          async close() {
            state = { state: 'disconnected', since: 1 };
          },
        };
      },
    };
    const failures: string[] = [];
    let flushes = 0;
    await runProviderConformance(
      () => lateLeak,
      // Only the first flush is slow (200 ms); the second is instant, as in the review's repro.
      { sources: ['a'], quietMs: 100, flush: () => (flushes++ === 0 ? new Promise((resolve) => setTimeout(resolve, 200)) : undefined) },
      (ok, m) => {
        if (!ok) failures.push(m);
      },
    );
    clearTimeout(leak);
    expect(failures).toEqual(['no samples are delivered after unsubscribe']);
  });

  it('#33: an injected wait drives the quiet window deterministically', async () => {
    vi.useFakeTimers();
    try {
      const waits: number[] = [];
      const failures: string[] = [];
      await runProviderConformance(
        () => createSimProvider({ intervalMs: 10 }),
        {
          sources: ['sine:1'],
          wait: async (ms) => {
            waits.push(ms);
            await vi.advanceTimersByTimeAsync(ms);
          },
        },
        (ok, m) => {
          if (!ok) failures.push(m);
        },
      );
      expect(failures).toEqual([]);
      expect(waits).toEqual([100]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('the sim provider passes with a manual schedule and flush', async () => {
    const manual = createManualSchedule();
    const failures: string[] = [];
    await runProviderConformance(() => createSimProvider({ schedule: manual.schedule }), { sources: ['sine:1'], flush: () => manual.tick() }, (ok, m) => {
      if (!ok) failures.push(m);
    });
    expect(failures).toEqual([]);
  });

  it('flags an empty source list', async () => {
    const failures: string[] = [];
    await runProviderConformance(() => createSimProvider(), { sources: [], timeoutMs: 5 }, (ok, m) => {
      if (!ok) failures.push(m);
    });
    expect(failures).toContain('conformance needs at least one source');
  });
});

describe('createProviderContext', () => {
  it('has inert defaults and keeps overrides', async () => {
    const ctx = createProviderContext({ connectionId: 'c1', now: () => 7 });
    expect(ctx.connectionId).toBe('c1');
    expect(ctx.now()).toBe(7);
    expect(await ctx.secret('k')).toBeUndefined();
    expect(ctx.registry.list('x')).toEqual([]);
    expect(ctx.registry.get('x', 'y')).toBeUndefined();
    expect(ctx.signal.aborted).toBe(false);
    expect(() => ctx.log('info', 'hi')).not.toThrow();
  });

  it('deploy-capable providers receive a document', async () => {
    let deployed: unknown;
    const provider: HolodeckProvider = {
      id: 'flow.runner',
      label: 'Runner',
      capabilities: { deploy: true },
      async connect() {
        return {
          status: () => ({ state: 'live', since: 0 }),
          onStatus: () => () => {},
          subscribe: () => () => {},
          deploy: async (doc) => {
            deployed = doc;
            return { ok: true, diagnostics: [], sources: ['n1.out'] };
          },
          close: async () => {},
        };
      },
    };
    const session = await provider.connect({}, createProviderContext());
    const doc = { format: HOLODECK_DOCUMENT_FORMAT, id: 'f', name: 'F', engine: 'holodeck.flow', body: {} } as const;
    expect(await session.deploy!(doc)).toEqual({ ok: true, diagnostics: [], sources: ['n1.out'] });
    expect(deployed).toBe(doc);
  });
});
