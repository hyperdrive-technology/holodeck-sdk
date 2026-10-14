/**
 * ProviderHub: turns a document's connections + bindings into live values per
 * object parameter (contract: docs/PACKAGING.md §6.3).
 *
 *   hub.setConnections(doc.connections)      open / close / reopen sessions by diff
 *   hub.setBindings(engine.collectBindings(doc.body))
 *   hub.subscribe(render); hub.getSnapshot()  React: useSyncExternalStore
 *   → snapshot.metrics[objectId][param]       transformed value for the engine
 *
 * One hub per open document. Engines never see providers or sources; they get
 * the same `metrics` map whether values come from AWS, a PLC or a flow run.
 *
 * Behaviour:
 * - Providers are resolved from the registry (`holodeck.provider`). A
 *   connection whose provider is not installed is in `error` state and
 *   reconnects automatically when the package is installed. Uninstalling the
 *   provider closes its sessions.
 * - Each connection gets one subscription covering every bound source; it is
 *   replaced when the bound set changes. Samples for unrequested sources are
 *   ignored.
 * - A changed `config` or `provider` closes the old session and opens a new
 *   one. Results of superseded `connect` calls are closed on arrival.
 * - Snapshots are immutable and structurally shared: unchanged objects keep
 *   their identity, and `getSnapshot()` returns the same reference until
 *   something changes.
 * - When the same `objectId.param` is bound twice, the last binding wins.
 */

import { applyTransform, type BindingRef, type ProviderConnection, type ValueTransform } from './document.js';
import { isSignalValue } from './guards.js';
import type {
  HolodeckProvider,
  ProviderContext,
  ProviderSession,
  ProviderStatus,
  Sample,
  SignalQuality,
  SignalValue,
} from './provider.js';
import { HOLODECK_KINDS, type ContributionRegistry } from './registry.js';

export interface ConnectionState {
  provider: string;
  status: ProviderStatus;
}

export type ObjectValues<T> = Readonly<Record<string, Readonly<Record<string, T>>>>;

export interface HubSnapshot {
  /** objectId → param → transformed value. Absent until the first sample. */
  metrics: ObjectValues<SignalValue>;
  /** objectId → param → quality of the latest sample. */
  quality: ObjectValues<SignalQuality>;
  /** connectionId → provider + status. */
  connections: Readonly<Record<string, ConnectionState>>;
}

export interface ProviderHubOptions {
  registry: ContributionRegistry;
  /** Host secret store lookup. Default: no secrets. */
  secret?: (connectionId: string, key: string) => Promise<string | undefined>;
  fetch?: typeof fetch;
  now?: () => number;
  log?: ProviderContext['log'];
}

interface Target {
  objectId: string;
  param: string;
  transform: ValueTransform | undefined;
}

interface Slot {
  def: ProviderConnection;
  key: string;
  provider: HolodeckProvider | undefined;
  controller: AbortController;
  session: ProviderSession | undefined;
  status: ProviderStatus;
  offStatus: (() => void) | undefined;
  unsubscribe: (() => void) | undefined;
  subscribedKey: string | undefined;
  closed: boolean;
}

/** JSON with sorted object keys, so equal configs compare equal. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.keys(value as Record<string, unknown>)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

const refKey = (objectId: string, param: string) => `${objectId}\u0000${param}`;

/**
 * Object ids, params and connection ids come from documents, so they can be
 * `__proto__`, `constructor` and so on. Every dictionary keyed by them has a
 * null prototype: assignment then always creates an own property (never
 * reaches `Object.prototype`), and lookups never see inherited members.
 */
function dict<T>(entries?: Readonly<Record<string, T>>): Record<string, T> {
  const out = Object.create(null) as Record<string, T>;
  if (entries) for (const key of Object.keys(entries)) out[key] = entries[key] as T;
  return out;
}

const hasOwn = (o: object, key: string) => Object.prototype.hasOwnProperty.call(o, key);

export class ProviderHubError extends Error {
  constructor(
    message: string,
    public readonly code: 'DISPOSED' | 'UNBOUND' | 'NOT_CONNECTED' | 'NOT_WRITABLE' | 'NOT_INVERTIBLE',
  ) {
    super(message);
    this.name = 'ProviderHubError';
  }
}

export class ProviderHub {
  private readonly options: ProviderHubOptions;
  private readonly slots = new Map<string, Slot>();
  /** connectionId → source → targets */
  private bySource = new Map<string, Map<string, Target[]>>();
  /** objectId\0param → binding ref (last wins) */
  private byTarget = new Map<string, BindingRef>();
  /** connectionId → source → latest sample */
  private readonly latest = new Map<string, Map<string, Sample>>();
  private metrics: ObjectValues<SignalValue> = dict();
  private quality: ObjectValues<SignalQuality> = dict();
  private snapshot: HubSnapshot | undefined;
  private readonly listeners = new Set<() => void>();
  private readonly pending = new Set<Promise<void>>();
  private readonly offRegistry: () => void;
  private disposed = false;

  constructor(options: ProviderHubOptions) {
    this.options = options;
    this.offRegistry = options.registry.subscribe(() => this.onRegistryChange());
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /** Open, close or reopen sessions so they match `connections`. */
  setConnections(connections: readonly ProviderConnection[]): void {
    this.assertLive();
    // Duplicate ids: the last definition wins (validated documents have none).
    const next = new Map(connections.map((c) => [c.id, c]));
    for (const [id, slot] of [...this.slots]) {
      const def = next.get(id);
      if (!def || this.connectionKey(def) !== slot.key) void this.closeSlot(id, slot);
      else slot.def = def; // same provider + config: keep the session, take the new label
    }
    for (const def of next.values()) {
      if (!this.slots.has(def.id)) this.openSlot(def);
    }
    this.recomputeAll();
    this.publish();
  }

  /** Replace the bound set (normally `engine.collectBindings(doc.body)`). */
  setBindings(refs: readonly BindingRef[]): void {
    this.assertLive();
    const byTarget = new Map<string, BindingRef>();
    for (const ref of refs) byTarget.set(refKey(ref.objectId, ref.param), ref);
    const bySource = new Map<string, Map<string, Target[]>>();
    for (const ref of byTarget.values()) {
      const { connection, source, transform } = ref.binding;
      let sources = bySource.get(connection);
      if (!sources) bySource.set(connection, (sources = new Map()));
      let targets = sources.get(source);
      if (!targets) sources.set(source, (targets = []));
      targets.push({ objectId: ref.objectId, param: ref.param, transform });
    }
    this.byTarget = byTarget;
    this.bySource = bySource;
    for (const slot of this.slots.values()) this.resubscribe(slot);
    this.recomputeAll();
    this.publish();
  }

  getSnapshot = (): HubSnapshot => {
    if (!this.snapshot) {
      const connections = dict<ConnectionState>();
      for (const [id, slot] of this.slots) connections[id] = { provider: slot.def.provider, status: slot.status };
      this.snapshot = { metrics: this.metrics, quality: this.quality, connections };
    }
    return this.snapshot;
  };

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** The live session of a connection, for browse / history / discover / deploy UIs. */
  session(connectionId: string): ProviderSession | undefined {
    return this.slots.get(connectionId)?.session;
  }

  /** Resolves when every in-flight `connect` has settled. */
  async settled(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }

  /**
   * Write through a binding. `scale` transforms are inverted (so a 0–1 slider
   * bound with scale 0–100 writes 0–100); other transforms are not invertible.
   */
  async write(objectId: string, param: string, value: SignalValue): Promise<void> {
    this.assertLive();
    const ref = this.byTarget.get(refKey(objectId, param));
    if (!ref) throw new ProviderHubError(`${objectId}.${param} is not bound`, 'UNBOUND');
    const slot = this.slots.get(ref.binding.connection);
    const session = slot?.session;
    if (!slot || !session) {
      throw new ProviderHubError(`connection "${ref.binding.connection}" is not connected`, 'NOT_CONNECTED');
    }
    if (!slot.provider?.capabilities.write || !session.write) {
      throw new ProviderHubError(`provider "${slot.def.provider}" does not support write`, 'NOT_WRITABLE');
    }
    if (!isSignalValue(value)) throw new TypeError('value must be a signal value');
    await session.write(ref.binding.source, invertTransform(ref.binding.transform, value));
  }

  /** Close every session. The hub cannot be reused. */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.offRegistry();
    const closing = [...this.slots].map(([id, slot]) => this.closeSlot(id, slot));
    this.listeners.clear();
    await Promise.allSettled(closing);
    await this.settled();
  }

  // ---------------------------------------------------------------------------
  // Connections
  // ---------------------------------------------------------------------------

  private connectionKey(def: ProviderConnection): string {
    return `${def.provider}\u0000${stableStringify(def.config ?? {})}`;
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private log: ProviderContext['log'] = (level, message, data) => this.options.log?.(level, message, data);

  private openSlot(def: ProviderConnection): void {
    const provider = this.options.registry.get<HolodeckProvider>(HOLODECK_KINDS.provider, def.provider);
    const slot: Slot = {
      def,
      key: this.connectionKey(def),
      provider,
      controller: new AbortController(),
      session: undefined,
      status: provider
        ? { state: 'connecting', since: this.now() }
        : { state: 'error', message: `provider "${def.provider}" is not installed`, since: this.now() },
      offStatus: undefined,
      unsubscribe: undefined,
      subscribedKey: undefined,
      closed: false,
    };
    this.slots.set(def.id, slot);
    if (!provider) return;

    const ctx: ProviderContext = {
      connectionId: def.id,
      secret: (key) => this.options.secret?.(def.id, key) ?? Promise.resolve(undefined),
      fetch: this.options.fetch ?? ((...args) => globalThis.fetch(...args)),
      now: () => this.now(),
      registry: this.options.registry,
      log: this.log,
      signal: slot.controller.signal,
    };
    // Providers get a private copy: they must not be able to mutate the document.
    const config = JSON.parse(stableStringify(def.config ?? {})) as Record<string, unknown>;
    let connecting: Promise<ProviderSession>;
    try {
      connecting = Promise.resolve(provider.connect(config, ctx));
    } catch (error) {
      connecting = Promise.reject(error);
    }
    const settled = connecting.then(
      (session) => this.onConnected(def.id, slot, session),
      (error: unknown) => {
        if (!this.isCurrent(def.id, slot)) return;
        slot.status = { state: 'error', message: errorMessage(error), since: this.now() };
        this.log('warn', `connection "${def.id}" failed`, error);
        this.publish();
      },
    );
    this.pending.add(settled);
    void settled.finally(() => this.pending.delete(settled));
  }

  private onConnected(id: string, slot: Slot, session: ProviderSession): void {
    if (!this.isCurrent(id, slot)) {
      // Superseded while connecting (config changed, removed, or hub disposed).
      void session.close().catch((error: unknown) => this.log('warn', `closing superseded "${id}" failed`, error));
      return;
    }
    slot.session = session;
    slot.status = session.status();
    slot.offStatus = session.onStatus((status) => {
      if (!this.isCurrent(id, slot)) return;
      slot.status = status;
      this.publish();
    });
    this.resubscribe(slot);
    this.publish();
  }

  private isCurrent(id: string, slot: Slot): boolean {
    return !this.disposed && !slot.closed && this.slots.get(id) === slot;
  }

  private closeSlot(id: string, slot: Slot): Promise<void> {
    slot.closed = true;
    this.slots.delete(id);
    this.latest.delete(id);
    slot.controller.abort();
    try {
      slot.unsubscribe?.();
      slot.offStatus?.();
    } catch (error) {
      this.log('warn', `unsubscribing "${id}" failed`, error);
    }
    const session = slot.session;
    slot.session = undefined;
    if (!session) return Promise.resolve();
    return session.close().catch((error: unknown) => this.log('warn', `closing "${id}" failed`, error));
  }

  private onRegistryChange(): void {
    if (this.disposed) return;
    let changed = false;
    for (const [id, slot] of [...this.slots]) {
      const provider = this.options.registry.get<HolodeckProvider>(HOLODECK_KINDS.provider, slot.def.provider);
      if (provider !== slot.provider) {
        void this.closeSlot(id, slot);
        this.openSlot(slot.def);
        changed = true;
      }
    }
    if (changed) {
      this.recomputeAll();
      this.publish();
    }
  }

  // ---------------------------------------------------------------------------
  // Subscriptions and values
  // ---------------------------------------------------------------------------

  private resubscribe(slot: Slot): void {
    const session = slot.session;
    if (!session || slot.closed) return;
    const id = slot.def.id;
    const sources = [...(this.bySource.get(id)?.keys() ?? [])].sort();
    const key = sources.join('\u0000');
    if (key === slot.subscribedKey) return;
    slot.unsubscribe?.();
    slot.unsubscribe = undefined;
    slot.subscribedKey = key;
    const latest = this.latest.get(id);
    if (latest) for (const source of [...latest.keys()]) if (!sources.includes(source)) latest.delete(source);
    if (!sources.length) return;
    try {
      slot.unsubscribe = session.subscribe(sources, (samples) => this.onSamples(id, slot, samples));
    } catch (error) {
      slot.status = { state: 'error', message: `subscribe failed: ${errorMessage(error)}`, since: this.now() };
      this.log('warn', `subscribe on "${id}" failed`, error);
    }
  }

  private onSamples(id: string, slot: Slot, samples: readonly Sample[]): void {
    if (!this.isCurrent(id, slot)) return;
    const sources = this.bySource.get(id);
    if (!sources) return;
    let latest = this.latest.get(id);
    if (!latest) this.latest.set(id, (latest = new Map()));
    let metrics: Record<string, Readonly<Record<string, SignalValue>>> | undefined;
    let quality: Record<string, Readonly<Record<string, SignalQuality>>> | undefined;
    for (const sample of samples) {
      const targets = sources.get(sample.source);
      if (!targets || !isSignalValue(sample.value)) continue;
      latest.set(sample.source, sample);
      for (const t of targets) {
        const value = applyTransform(t.transform, sample.value);
        const q = sample.quality ?? 'good';
        const current = (metrics ?? this.metrics)[t.objectId];
        if (!current || !hasOwn(current, t.param) || !Object.is(current[t.param], value)) {
          metrics ??= dict(this.metrics);
          const next = dict(current);
          next[t.param] = value;
          metrics[t.objectId] = next;
        }
        const currentQ = (quality ?? this.quality)[t.objectId];
        if (!currentQ || currentQ[t.param] !== q) {
          quality ??= dict(this.quality);
          const next = dict(currentQ);
          next[t.param] = q;
          quality[t.objectId] = next;
        }
      }
    }
    if (metrics) this.metrics = metrics;
    if (quality) this.quality = quality;
    if (metrics || quality) this.publish();
  }

  /** Rebuild values from the latest samples, keeping unchanged objects' identity. */
  private recomputeAll(): void {
    const metrics = dict<Record<string, SignalValue>>();
    const quality = dict<Record<string, SignalQuality>>();
    for (const ref of this.byTarget.values()) {
      const sample = this.latest.get(ref.binding.connection)?.get(ref.binding.source);
      if (!sample) continue;
      (metrics[ref.objectId] ??= dict())[ref.param] = applyTransform(ref.binding.transform, sample.value);
      (quality[ref.objectId] ??= dict())[ref.param] = sample.quality ?? 'good';
    }
    const nextMetrics = shareStructure(this.metrics, metrics);
    const nextQuality = shareStructure(this.quality, quality);
    if (nextMetrics !== this.metrics || nextQuality !== this.quality) {
      this.metrics = nextMetrics;
      this.quality = nextQuality;
    }
  }

  private publish(): void {
    this.snapshot = undefined;
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch (error) {
        this.log('error', 'ProviderHub listener threw', error);
      }
    }
  }

  private assertLive(): void {
    if (this.disposed) throw new ProviderHubError('ProviderHub is disposed', 'DISPOSED');
  }
}

/** Keep `prev`'s object identities wherever `next` is equal; return `prev` if nothing changed. */
function shareStructure<T>(prev: ObjectValues<T>, next: Record<string, Record<string, T>>): ObjectValues<T> {
  let changed = Object.keys(prev).length !== Object.keys(next).length;
  const out = dict<Readonly<Record<string, T>>>();
  for (const objectId of Object.keys(next)) {
    const params = next[objectId] as Record<string, T>;
    const old = hasOwn(prev, objectId) ? prev[objectId] : undefined;
    const same =
      old !== undefined &&
      Object.keys(old).length === Object.keys(params).length &&
      Object.keys(params).every((k) => hasOwn(old, k) && Object.is(old[k], params[k]));
    out[objectId] = same ? old : params;
    if (!same) changed = true;
  }
  return changed ? out : prev;
}

/** Inverse of `applyTransform` for writes. Only `scale` (and no transform) is invertible. */
export function invertTransform(transform: ValueTransform | undefined, value: SignalValue): SignalValue {
  if (!transform || value === null) return value;
  if (transform.kind !== 'scale') {
    throw new ProviderHubError(`a "${transform.kind}" binding cannot be written through`, 'NOT_INVERTIBLE');
  }
  if (typeof value !== 'number') throw new TypeError('writing through a scale binding needs a number');
  const outSpan = transform.outMax - transform.outMin;
  const t = outSpan === 0 ? 0 : (value - transform.outMin) / outSpan;
  const clamped = transform.clamp === false ? t : Math.min(1, Math.max(0, t));
  return transform.inMin + clamped * (transform.inMax - transform.inMin);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
