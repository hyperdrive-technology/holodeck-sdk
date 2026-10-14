/**
 * Providers: live data for Holodeck documents (contract: docs/PACKAGING.md §6).
 *
 * A provider is a `holodeck.provider` contribution. Connecting it with a
 * document's `ProviderConnection` config yields a `ProviderSession` that
 * streams `Sample`s for provider-defined `source` strings. Every session
 * supports `subscribe`; the other capabilities are optional and declared up
 * front so pickers and toolbars can adapt without connecting.
 *
 * Examples: `aws.cloudwatch` (metrics + alarm state, discovery of resources),
 * `holodeck.http` (JSON over HTTP/WebSocket), `holodeck.flow.local` (runs a
 * flow document: `deploy`), and providers made by host products, such as a
 * PLC runtime. Nothing in this file knows any of those domains.
 */

import { isDottedId, isNonEmptyStr, isObj, isSignalValue, isStr } from './guards.js';
import type { HolodeckDocument } from './document.js';
import { HOLODECK_KINDS, type Contribution, type ContributionKind, type ContributionRegistry } from './registry.js';

/** JSON-safe value carried by a signal. Structured values belong in several signals. */
export type SignalValue = number | string | boolean | null;

export type SignalQuality = 'good' | 'uncertain' | 'bad';

export interface Sample {
  source: string;
  value: SignalValue;
  /** Milliseconds since the Unix epoch when the value was measured. */
  ts: number;
  /** Absent = `good`. */
  quality?: SignalQuality;
}

/**
 * `live`: data flowing. `stale`: connected but values are older than the
 * provider's freshness window. `connecting` / `disconnected` / `error` as named.
 * The same states drive the host's connection badge.
 */
export type ProviderState = 'connecting' | 'live' | 'stale' | 'disconnected' | 'error';

export interface ProviderStatus {
  state: ProviderState;
  message?: string;
  /** Milliseconds since the Unix epoch when `state` was entered. */
  since: number;
}

/** Optional session capabilities. `subscribe` is mandatory and not listed. */
export interface ProviderCapabilities {
  read?: boolean;
  write?: boolean;
  browse?: boolean;
  history?: boolean;
  discover?: boolean;
  deploy?: boolean;
}

export const PROVIDER_CAPABILITIES = ['read', 'write', 'browse', 'history', 'discover', 'deploy'] as const;

/** One entry in a signal picker tree. */
export interface SignalNode {
  /** Path for `browse(path)` to list children. */
  path: string;
  label: string;
  /** Present on leaves: the `source` to bind. */
  source?: string;
  hasChildren?: boolean;
  type?: 'number' | 'string' | 'boolean';
  unit?: string;
  writable?: boolean;
  description?: string;
}

/** Something the provider found that a user may place on a canvas (an EC2 instance, a PLC). */
export interface DiscoveredResource {
  /** Stable key, e.g. an ARN. */
  key: string;
  label: string;
  /** Provider vocabulary, e.g. `aws.ec2.instance`. */
  kind: string;
  group?: string;
  /** Suggested part/block id for the canvas, e.g. `aws.ec2`. */
  partHint?: string;
  /** Suggested bindings: param → source. */
  bindings?: Record<string, string>;
  metadata?: Record<string, string>;
}

export interface HistoryRange {
  from: number;
  to: number;
  /** Desired spacing between samples; providers may return coarser data. */
  stepMs?: number;
}

export interface Diagnostic {
  severity: 'error' | 'warning' | 'info';
  message: string;
  code?: string;
  /** Document object the diagnostic is about. */
  objectId?: string;
  source?: string;
}

export interface DeployResult {
  ok: boolean;
  diagnostics: Diagnostic[];
  /** Sources the deployment now publishes (e.g. block outputs). */
  sources?: string[];
}

export interface ProviderSecretSpec {
  key: string;
  label: string;
  description?: string;
  optional?: boolean;
}

/** Read-only view of the registry, e.g. so a flow runtime can look up block definitions. */
export type RegistryReader = Pick<ContributionRegistry, 'get' | 'list'>;

export interface ProviderContext {
  /** `ProviderConnection.id` this session serves. */
  connectionId: string;
  /** Secret declared in `HolodeckProvider.secrets`, from the host's secret store. */
  secret(key: string): Promise<string | undefined>;
  fetch: typeof fetch;
  now(): number;
  registry: RegistryReader;
  log(level: 'debug' | 'info' | 'warn' | 'error', message: string, data?: unknown): void;
  /** Aborted when the host closes or replaces this connection. */
  signal: AbortSignal;
}

export interface ProviderSession {
  status(): ProviderStatus;
  onStatus(listener: (status: ProviderStatus) => void): () => void;
  /**
   * Deliver samples for `sources` until the returned function is called. The
   * first delivery should include current values when the provider has them.
   */
  subscribe(sources: readonly string[], onSamples: (samples: readonly Sample[]) => void): () => void;
  read?(sources: readonly string[]): Promise<Sample[]>;
  write?(source: string, value: SignalValue): Promise<void>;
  browse?(path?: string): Promise<SignalNode[]>;
  history?(source: string, range: HistoryRange): Promise<Sample[]>;
  discover?(): Promise<DiscoveredResource[]>;
  /** Run a document on the provider (flow runtimes, logic controllers). */
  deploy?(doc: HolodeckDocument): Promise<DeployResult>;
  /** Idempotent. After it resolves `status().state` is `disconnected`. */
  close(): Promise<void>;
}

export interface HolodeckProvider extends Contribution {
  /** Dotted id, e.g. `aws.cloudwatch`. */
  id: string;
  label: string;
  description?: string;
  version?: string;
  capabilities: ProviderCapabilities;
  /** Human description of the `source` syntax, shown in binding editors. */
  sourceSyntax?: string;
  /** JSON Schema of the non-secret `ProviderConnection.config`. */
  configSchema?: Record<string, unknown>;
  secrets?: ProviderSecretSpec[];
  /** Network origins it contacts; must be listed in the package's `permissions.network`. */
  origins?: string[];
  connect(config: Record<string, unknown>, ctx: ProviderContext): Promise<ProviderSession>;
}

export function isHolodeckProvider(item: unknown): item is HolodeckProvider {
  if (!isObj(item) || !isDottedId(item.id) || !isNonEmptyStr(item.label)) return false;
  if (typeof item.connect !== 'function') return false;
  if (!isObj(item.capabilities)) return false;
  for (const [key, value] of Object.entries(item.capabilities)) {
    if (!(PROVIDER_CAPABILITIES as readonly string[]).includes(key) || typeof value !== 'boolean') return false;
  }
  if (item.secrets !== undefined) {
    if (!Array.isArray(item.secrets)) return false;
    if (!item.secrets.every((s) => isObj(s) && isNonEmptyStr(s.key) && isStr(s.label))) return false;
  }
  if (item.origins !== undefined && !(Array.isArray(item.origins) && item.origins.every(isNonEmptyStr))) return false;
  if (item.configSchema !== undefined && !isObj(item.configSchema)) return false;
  return true;
}

// =============================================================================
// Simulated provider: test double, demo data, and the reference implementation
// =============================================================================

export const SIM_PROVIDER_ID = 'holodeck.sim';

/**
 * Deterministic simulated signals. Every value is a pure function of time,
 * so `history` is exact and tests need no randomness.
 *
 *   `sine:<periodS>[:<min>:<max>]`     default range 0..100
 *   `ramp:<periodS>[:<min>:<max>]`     sawtooth
 *   `square:<periodS>`                 true for the first half of each period
 *   `noise:<seed>[:<min>:<max>[:<periodS>]]`   smooth value noise, default period 10 s
 *   `const:<json>`                     e.g. `const:42`, `const:"ok"`, `const:true`
 *   `mem:<name>`                       writable; starts at null
 */
export const SIM_SOURCE_SYNTAX =
  'sine:<periodS>[:<min>:<max>] | ramp:<periodS>[:<min>:<max>] | square:<periodS> | ' +
  'noise:<seed>[:<min>:<max>[:<periodS>]] | const:<json> | mem:<name>';

export interface SimProviderOptions {
  /** Emission interval for subscriptions (default 250 ms). */
  intervalMs?: number;
  /**
   * Timer used for subscriptions. Default `setInterval`. Tests pass a manual
   * scheduler and drive `tick()` themselves.
   */
  schedule?: (tick: () => void, intervalMs: number) => () => void;
}

/** Hash two integers to [0, 1). Mulberry32-style mixing; deterministic across platforms. */
function hash01(seed: number, k: number): number {
  let t = (Math.imul(seed | 0, 0x9e3779b1) ^ Math.imul(k | 0, 0x85ebca6b)) >>> 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

function num(part: string | undefined, fallback: number): number {
  if (part === undefined || part === '') return fallback;
  const n = Number(part);
  return Number.isFinite(n) ? n : NaN;
}

type SimSignal = { evaluate(ts: number): SignalValue; writable: boolean } | { error: string };

function parseSimSource(source: string, memory: Map<string, SignalValue>): SimSignal {
  const [fn = '', ...rest] = source.split(':');
  const fixed = (evaluate: (ts: number) => SignalValue): SimSignal => ({ evaluate, writable: false });
  switch (fn) {
    case 'sine':
    case 'ramp':
    case 'square': {
      const period = num(rest[0], NaN) * 1000;
      const min = num(rest[1], 0);
      const max = num(rest[2], 100);
      if (!(period > 0) || Number.isNaN(min) || Number.isNaN(max)) return { error: `bad ${fn} source "${source}"` };
      const phase = (ts: number) => (((ts % period) + period) % period) / period;
      if (fn === 'square') return fixed((ts) => phase(ts) < 0.5);
      if (fn === 'ramp') return fixed((ts) => min + phase(ts) * (max - min));
      return fixed((ts) => min + ((Math.sin(2 * Math.PI * phase(ts)) + 1) / 2) * (max - min));
    }
    case 'noise': {
      const seed = num(rest[0], NaN);
      const min = num(rest[1], 0);
      const max = num(rest[2], 100);
      const period = num(rest[3], 10) * 1000;
      if (!Number.isInteger(seed) || Number.isNaN(min) || Number.isNaN(max) || !(period > 0)) {
        return { error: `bad noise source "${source}"` };
      }
      return fixed((ts) => {
        const x = ts / period;
        const k = Math.floor(x);
        const f = x - k;
        const smooth = f * f * (3 - 2 * f);
        const v = hash01(seed, k) * (1 - smooth) + hash01(seed, k + 1) * smooth;
        return min + v * (max - min);
      });
    }
    case 'const': {
      try {
        const value: unknown = JSON.parse(source.slice('const:'.length));
        if (!isSignalValue(value)) return { error: `const source "${source}" is not a signal value` };
        return fixed(() => value);
      } catch {
        return { error: `const source "${source}" is not JSON` };
      }
    }
    case 'mem': {
      const name = source.slice('mem:'.length);
      if (!name) return { error: 'mem source needs a name' };
      return { evaluate: () => memory.get(name) ?? null, writable: true };
    }
    default:
      return { error: `unknown sim source "${source}"` };
  }
}

const defaultSchedule = (tick: () => void, intervalMs: number) => {
  const handle = setInterval(tick, intervalMs);
  return () => clearInterval(handle);
};

/**
 * Create the `holodeck.sim` provider. Hosts may install it as demo data; tests
 * use it (with a manual `schedule`) as the reference provider.
 */
export function createSimProvider(options: SimProviderOptions = {}): HolodeckProvider {
  const intervalMs = options.intervalMs ?? 250;
  const schedule = options.schedule ?? defaultSchedule;
  return {
    id: SIM_PROVIDER_ID,
    label: 'Simulated signals',
    description: 'Deterministic waveforms and writable memory for demos and tests.',
    capabilities: { read: true, write: true, browse: true, history: true },
    sourceSyntax: SIM_SOURCE_SYNTAX,
    async connect(_config, ctx) {
      const memory = new Map<string, SignalValue>();
      const statusListeners = new Set<(s: ProviderStatus) => void>();
      const subscriptions = new Set<() => void>();
      let status: ProviderStatus = { state: 'live', since: ctx.now() };
      const setStatus = (next: ProviderStatus) => {
        status = next;
        for (const listener of [...statusListeners]) listener(next);
      };
      const sample = (source: string, ts: number): Sample => {
        const signal = parseSimSource(source, memory);
        if ('error' in signal) return { source, value: null, ts, quality: 'bad' };
        return { source, value: signal.evaluate(ts), ts };
      };
      const closed = () => status.state === 'disconnected';

      const session: ProviderSession = {
        status: () => status,
        onStatus(listener) {
          statusListeners.add(listener);
          return () => statusListeners.delete(listener);
        },
        subscribe(sources, onSamples) {
          if (closed()) return () => {};
          const list = [...sources];
          const emit = () => onSamples(list.map((s) => sample(s, ctx.now())));
          let active = true;
          const cancel = schedule(() => {
            if (active) emit();
          }, intervalMs);
          const stop = () => {
            if (!active) return;
            active = false;
            cancel();
            subscriptions.delete(stop);
          };
          subscriptions.add(stop);
          emit();
          return stop;
        },
        async read(sources) {
          const ts = ctx.now();
          return sources.map((s) => sample(s, ts));
        },
        async write(source, value) {
          const signal = parseSimSource(source, memory);
          if ('error' in signal) throw new Error(signal.error);
          if (!signal.writable) throw new Error(`sim source "${source}" is read-only`);
          if (!isSignalValue(value)) throw new TypeError('value must be a signal value');
          memory.set(source.slice('mem:'.length), value);
        },
        async browse(path) {
          if (path) return [];
          const leaf = (source: string, label: string, type: 'number' | 'boolean', writable = false): SignalNode => ({
            path: source,
            label,
            source,
            type,
            writable,
          });
          return [
            leaf('sine:10', 'Sine, 10 s, 0–100', 'number'),
            leaf('ramp:30', 'Ramp, 30 s, 0–100', 'number'),
            leaf('square:4', 'Square, 4 s', 'boolean'),
            leaf('noise:1', 'Noise, seed 1, 0–100', 'number'),
            leaf('mem:value', 'Writable memory "value"', 'number', true),
          ];
        },
        async history(source, range) {
          if (!(range.to >= range.from)) throw new RangeError('history range: to must be ≥ from');
          const step = Math.max(1, range.stepMs ?? intervalMs);
          const count = Math.floor((range.to - range.from) / step) + 1;
          if (count > 100_000) throw new RangeError('history range: more than 100000 samples requested');
          return Array.from({ length: count }, (_, i) => sample(source, range.from + i * step));
        },
        async close() {
          if (closed()) return;
          for (const stop of [...subscriptions]) stop();
          setStatus({ state: 'disconnected', since: ctx.now() });
        },
      };
      ctx.signal.addEventListener('abort', () => void session.close(), { once: true });
      return session;
    },
  };
}

/** Manual scheduler for tests: `tick()` fires every scheduled callback once. */
export function createManualSchedule(): {
  schedule: NonNullable<SimProviderOptions['schedule']>;
  tick(): void;
  readonly active: number;
} {
  const callbacks = new Set<() => void>();
  return {
    schedule(tick) {
      callbacks.add(tick);
      return () => callbacks.delete(tick);
    },
    tick() {
      for (const callback of [...callbacks]) callback();
    },
    get active() {
      return callbacks.size;
    },
  };
}

// =============================================================================
// Provider context helpers and conformance kit
// =============================================================================

/** A `ProviderContext` with inert defaults; hosts and tests override what they need. */
export function createProviderContext(overrides: Partial<ProviderContext> = {}): ProviderContext {
  const registry: RegistryReader = overrides.registry ?? {
    get: () => undefined,
    list: () => [],
  };
  return {
    connectionId: 'test',
    secret: async () => undefined,
    fetch: (...args) => globalThis.fetch(...args),
    now: () => Date.now(),
    log: () => {},
    signal: new AbortController().signal,
    ...overrides,
    registry,
  };
}

export interface ProviderConformanceOptions {
  config?: Record<string, unknown>;
  /** Sources the provider must serve under this config. At least one. */
  sources: string[];
  context?: Partial<ProviderContext>;
  /** How long to wait for the first samples (default 2000 ms). */
  timeoutMs?: number;
  /**
   * Make the provider's fake backend deliver anything pending right now
   * (advance fake timers, tick a manual schedule, flush a mock socket). Called
   * before and after the quiet window that follows `unsubscribe`, so a leaked
   * or late delivery is caught deterministically. Strongly recommended.
   */
  flush?: () => void | Promise<void>;
  /**
   * Real-time quiet window after `unsubscribe` (default 100 ms). It is
   * stretched to three times the longest gap seen between deliveries, capped
   * at `timeoutMs`, so slow-ticking providers are observed over several ticks.
   */
  quietMs?: number;
}

/**
 * Conformance kit: every provider package runs this against its provider
 * (with a fake backend). Mirrors the registry's `runContributionKindConformance`.
 */
export async function runProviderConformance(
  makeProvider: () => HolodeckProvider,
  options: ProviderConformanceOptions,
  assert: (ok: boolean, message: string) => void,
): Promise<void> {
  const provider = makeProvider();
  assert(isHolodeckProvider(provider), 'provider passes isHolodeckProvider');
  assert(options.sources.length > 0, 'conformance needs at least one source');
  const timeoutMs = options.timeoutMs ?? 2000;
  const controller = new AbortController();
  const session = await provider.connect(
    options.config ?? {},
    createProviderContext({ signal: controller.signal, ...options.context }),
  );
  const states: ProviderState[] = ['connecting', 'live', 'stale', 'disconnected', 'error'];
  assert(states.includes(session.status().state), 'status() returns a known state');
  assert(typeof session.status().since === 'number', 'status().since is a timestamp');

  for (const cap of PROVIDER_CAPABILITIES) {
    if (provider.capabilities[cap]) {
      assert(typeof session[cap] === 'function', `declared capability "${cap}" is implemented`);
    }
  }

  // subscribe delivers a well-formed sample for every requested source
  const seen = new Map<string, Sample>();
  let calls = 0;
  const deliveredAt: number[] = [];
  let resolveAll: () => void = () => {};
  const allSeen = new Promise<void>((resolve) => (resolveAll = resolve));
  const unsubscribe = session.subscribe(options.sources, (samples) => {
    calls++;
    deliveredAt.push(Date.now());
    for (const s of samples) {
      assert(options.sources.includes(s.source), `sample source "${s.source}" was requested`);
      assert(isSignalValue(s.value), `sample value for "${s.source}" is a signal value`);
      assert(typeof s.ts === 'number' && Number.isFinite(s.ts), `sample ts for "${s.source}" is finite`);
      seen.set(s.source, s);
    }
    if (options.sources.every((src) => seen.has(src))) resolveAll();
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = await Promise.race([
    allSeen.then(() => false),
    new Promise<boolean>((resolve) => (timer = setTimeout(() => resolve(true), timeoutMs))),
  ]);
  clearTimeout(timer);
  assert(!timedOut, `every source delivered a sample within ${timeoutMs} ms`);

  // unsubscribe stops delivery: flush the backend, wait out several delivery
  // gaps, flush again; any delivery in between is a leak (#25).
  unsubscribe();
  const after = calls;
  const gaps = deliveredAt.slice(1).map((t, i) => t - (deliveredAt[i] as number));
  const quietMs = Math.min(timeoutMs, Math.max(options.quietMs ?? 100, 3 * Math.max(0, ...gaps)));
  await options.flush?.();
  await new Promise((resolve) => setTimeout(resolve, quietMs));
  await options.flush?.();
  // Message text unchanged from v1.0 so existing consumers matching it keep working.
  assert(calls === after, 'no samples are delivered after unsubscribe');
  unsubscribe(); // idempotent

  if (provider.capabilities.read && session.read) {
    const read = await session.read(options.sources);
    assert(
      options.sources.every((src) => read.some((s) => s.source === src)),
      'read returns a sample for every source',
    );
  }

  await session.close();
  assert(session.status().state === 'disconnected', 'close() leaves the session disconnected');
  await session.close(); // idempotent
  controller.abort();
}

/** Contribution kind for providers; registered by `HolodeckHost`. */
export const PROVIDER_KIND: ContributionKind<HolodeckProvider> = {
  kind: HOLODECK_KINDS.provider,
  validate: isHolodeckProvider,
};
