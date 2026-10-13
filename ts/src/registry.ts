/**
 * Contribution registry — the in-memory side of "install a library in one click".
 *
 * An editor (2.5D iso, 2D flow, 3D viewer, or a host app such as Hyperdrive)
 * registers the *kinds* of contribution it can receive. An extension bundles
 * contributions of many kinds; installing it routes each kind to whoever
 * registered it. Kinds nobody has registered yet are kept as `pending`, so a
 * brewery pack can carry FBD blocks even when only the iso editor is mounted.
 *
 * Design rules (see core/docs/EXTENSIONS_AND_LIBRARIES.md):
 * - Duplicate contribution ids within a kind are an error, never an override.
 * - `install` and pending replay validate everything before publishing state.
 *   Validation failures leave the registry untouched, including pending IDs.
 * - Lifecycle hooks and subscribers run after the entire operation commits.
 *   Callback failures are collected in an AggregateError; state stays committed.
 * - User objects retain their identity and behavior. Only internal membership,
 *   routing IDs and bound kind callbacks are captured for registry bookkeeping.
 * - No IEC / Hyperdrive semantics here; this file is domain-neutral.
 */

import type { HolodeckComponent, SceneComponentPack } from './index.js';

export interface Contribution {
  /** Unique within its kind across all installed extensions. */
  id: string;
}

export interface ContributionKind<T extends Contribution = Contribution> {
  /** Dotted kind name, e.g. `holodeck.iso.part`. */
  kind: string;
  /** Check run at install time, or on late registration for pending items. */
  validate?: (item: unknown) => item is T;
  /** Called after the entire operation commits; failures are aggregated without rollback. */
  onInstall?: (items: T[], extensionId: string) => void;
  /** Called after the entire uninstall commits; failures are aggregated without rollback. */
  onUninstall?: (items: T[], extensionId: string) => void;
}

export interface HolodeckExtension {
  /** e.g. `hyperdrive.brewery` */
  id: string;
  version: string;
  label?: string;
  description?: string;
  /** kind → contributions */
  contributions: Record<string, Contribution[]>;
}

export interface InstallResult {
  extensionId: string;
  /** kind → ids that were routed to a registered kind */
  installed: Record<string, string[]>;
  /** kinds carried by the extension that no editor has registered (yet) */
  pending: string[];
}

export type RegistryChange =
  | { type: 'kind-registered'; kind: string }
  | { type: 'kind-unregistered'; kind: string }
  | { type: 'installed'; extensionId: string; kinds: string[] }
  | { type: 'uninstalled'; extensionId: string; kinds: string[] };

export class ContributionRegistryError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'DUPLICATE_KIND'
      | 'DUPLICATE_ID'
      | 'INVALID_ITEM'
      | 'DUPLICATE_EXTENSION'
      | 'UNKNOWN_EXTENSION',
  ) {
    super(message);
    this.name = 'ContributionRegistryError';
  }
}

interface KindSlot {
  def: ContributionKind;
  kind: string;
  validate: ((item: unknown) => boolean) | undefined;
  onInstall: ((items: Contribution[], extensionId: string) => void) | undefined;
  onUninstall: ((items: Contribution[], extensionId: string) => void) | undefined;
  /** id → item */
  items: Map<string, Contribution>;
  /** id → owning extension */
  owners: Map<string, string>;
}

interface ContributionEntry {
  readonly id: string;
  readonly item: Contribution;
}

interface ContributionGroup {
  readonly kind: string;
  readonly items: readonly ContributionEntry[];
}

interface ExtensionSlot {
  readonly ext: HolodeckExtension;
  readonly id: string;
  readonly contributions: readonly ContributionGroup[];
}

export class ContributionRegistry {
  private readonly kinds = new Map<string, KindSlot>();
  /** extensionId → original extension with captured routing and membership. */
  private readonly extensions = new Map<string, ExtensionSlot>();
  /** kind → (id → owning extension), including kinds that are still pending. */
  private readonly reservedIds = new Map<string, Map<string, string>>();
  private readonly listeners = new Set<(change: RegistryChange) => void>();

  /** Register a kind, atomically validating pending replay. Returns an unregister function. */
  registerKind<T extends Contribution>(def: ContributionKind<T>): () => void {
    // Bind methods to the original definition, including prototype methods and
    // their instance state. Capture routing separately from the mutable object.
    const kind = def.kind;
    if (this.kinds.has(kind)) {
      throw new ContributionRegistryError(`kind "${kind}" is already registered`, 'DUPLICATE_KIND');
    }
    const slot: KindSlot = {
      def: def as unknown as ContributionKind,
      kind,
      validate: def.validate?.bind(def),
      onInstall: def.onInstall?.bind(def) as KindSlot['onInstall'],
      onUninstall: def.onUninstall?.bind(def) as KindSlot['onUninstall'],
      items: new Map(), owners: new Map(),
    };
    const replay: Array<[readonly ContributionEntry[], string]> = [];
    // The slot is private staging state until ALL pending extensions validate.
    // Neither publishing the kind nor calling hooks is safe inside this loop:
    // a later invalid extension must leave pending state intact for a retry.
    for (const ext of this.extensions.values()) {
      const items = ext.contributions.find((group) => group.kind === kind)?.items;
      if (items?.length) {
        this.validateItems(kind, items, ext.id, slot.owners, slot.validate);
        this.commitItems(slot, items, ext.id);
        replay.push([items, ext.id]);
      }
    }
    this.kinds.set(kind, slot);
    // Reservations must describe exactly the replay that was committed, even
    // after unregister/register cycles. Failed validation never reaches here.
    if (slot.owners.size) this.reservedIds.set(kind, new Map(slot.owners));
    else this.reservedIds.delete(kind);
    this.emit(
      { type: 'kind-registered', kind },
      replay.map(([items, extensionId]) => () => slot.onInstall?.(items.map(({ item }) => item), extensionId)),
    );

    return () => {
      if (this.kinds.get(kind) !== slot) return;
      this.kinds.delete(kind);
      this.emit({ type: 'kind-unregistered', kind });
    };
  }

  hasKind(kind: string): boolean {
    return this.kinds.has(kind);
  }

  /** Install an extension. Validation is atomic; callback errors leave the install committed. */
  install(ext: HolodeckExtension): InstallResult {
    // Snapshot every kind before validators run: a validator can close over and
    // mutate the caller's extension, including contributions in a later kind.
    const snapshot = this.snapshotExtension(ext);
    const extensionId = snapshot.id;
    if (this.extensions.has(extensionId)) {
      throw new ContributionRegistryError(`extension "${extensionId}" is already installed`, 'DUPLICATE_EXTENSION');
    }
    const routed: Array<[KindSlot, readonly ContributionEntry[]]> = [];
    const pending: string[] = [];
    for (const { kind, items } of snapshot.contributions) {
      const slot = this.kinds.get(kind);
      // Basic shape and uniqueness apply even without an editor. Only the
      // kind-specific validator is deferred until that editor registers.
      this.validateItems(kind, items, extensionId, this.reservedIds.get(kind), slot?.validate, slot?.owners);
      if (!slot) {
        pending.push(kind);
        continue;
      }
      routed.push([slot, items]);
    }

    this.extensions.set(extensionId, snapshot);
    for (const { kind, items } of snapshot.contributions) {
      const owners = this.reservedIds.get(kind) ?? new Map<string, string>();
      for (const { id } of items) owners.set(id, extensionId);
      this.reservedIds.set(kind, owners);
    }
    const installed: Record<string, string[]> = Object.create(null);
    for (const [slot, items] of routed) {
      this.commitItems(slot, items, extensionId);
      installed[slot.kind] = items.map(({ id }) => id);
    }
    this.emit(
      { type: 'installed', extensionId, kinds: Object.keys(installed) },
      routed.map(([slot, items]) => () => slot.onInstall?.(items.map(({ item }) => item), extensionId)),
    );
    return { extensionId, installed, pending };
  }

  /** Remove an extension completely before callbacks; callback errors do not restore it. */
  uninstall(extensionId: string): void {
    const ext = this.extensions.get(extensionId);
    if (!ext) {
      throw new ContributionRegistryError(`extension "${extensionId}" is not installed`, 'UNKNOWN_EXTENSION');
    }
    this.extensions.delete(extensionId);
    const kinds: string[] = [];
    const hooks: Array<() => void> = [];
    for (const slot of this.kinds.values()) {
      const removed: Contribution[] = [];
      for (const [id, owner] of slot.owners) {
        if (owner === extensionId) {
          removed.push(slot.items.get(id)!);
          slot.items.delete(id);
          slot.owners.delete(id);
        }
      }
      if (removed.length) {
        kinds.push(slot.kind);
        hooks.push(() => slot.onUninstall?.(removed, extensionId));
      }
    }
    for (const [kind, owners] of this.reservedIds) {
      for (const [id, owner] of owners) {
        if (owner === extensionId) owners.delete(id);
      }
      if (!owners.size) this.reservedIds.delete(kind);
    }
    this.emit({ type: 'uninstalled', extensionId, kinds }, hooks);
  }

  /** A fresh array containing the original contribution objects. */
  list<T extends Contribution>(kind: string): readonly T[] {
    const slot = this.kinds.get(kind);
    return slot ? (Array.from(slot.items.values()) as T[]) : [];
  }

  /** The original contribution object, addressed by its ID captured at install. */
  get<T extends Contribution>(kind: string, id: string): T | undefined {
    return this.kinds.get(kind)?.items.get(id) as T | undefined;
  }

  /** Which extension contributed `id` to `kind`. */
  ownerOf(kind: string, id: string): string | undefined {
    return this.kinds.get(kind)?.owners.get(id);
  }

  /** A fresh array containing the original extensions; mutations do not change membership. */
  installedExtensions(): readonly HolodeckExtension[] {
    return Array.from(this.extensions.values(), ({ ext }) => ext);
  }

  /** Contributions whose kind no editor has registered. */
  pending(): Record<string, Contribution[]> {
    const out: Record<string, Contribution[]> = Object.create(null);
    for (const ext of this.extensions.values()) {
      for (const { kind, items } of ext.contributions) {
        if (!this.kinds.has(kind) && items.length) {
          (out[kind] ??= []).push(...items.map(({ item }) => item));
        }
      }
    }
    return out;
  }

  subscribe(listener: (change: RegistryChange) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private snapshotExtension(ext: HolodeckExtension): ExtensionSlot {
    const id = ext.id;
    // Freeze only our bookkeeping. User instances must retain their prototypes,
    // private fields and mutability, while later array/ID edits cannot affect replay.
    const contributions = Object.entries(ext.contributions).map(([kind, items]) => Object.freeze({
      kind,
      items: Object.freeze(items.map((item) => Object.freeze({ id: item?.id, item }))),
    }));
    return Object.freeze({ ext, id, contributions: Object.freeze(contributions) });
  }

  private validateItems(
    kind: string,
    items: readonly ContributionEntry[],
    extensionId: string,
    owners?: ReadonlyMap<string, string>,
    validate?: (item: unknown) => boolean,
    activeOwners?: ReadonlyMap<string, string>,
  ): void {
    const seen = new Set<string>();
    for (const { id, item } of items) {
      if (!item || typeof item !== 'object' || typeof id !== 'string') {
        throw new ContributionRegistryError(
          `extension "${extensionId}" has a ${kind} contribution without a string id`,
          'INVALID_ITEM',
        );
      }
      if (seen.has(id) || owners?.has(id) || activeOwners?.has(id)) {
        const owner = owners?.get(id) ?? activeOwners?.get(id) ?? extensionId;
        throw new ContributionRegistryError(
          `${kind} "${id}" from "${extensionId}" conflicts with "${owner}"`,
          'DUPLICATE_ID',
        );
      }
      if (validate && !validate(item)) {
        throw new ContributionRegistryError(
          `${kind} "${id}" from "${extensionId}" failed validation`,
          'INVALID_ITEM',
        );
      }
      seen.add(id);
    }
  }

  private commitItems(slot: KindSlot, items: readonly ContributionEntry[], extensionId: string): void {
    for (const { id, item } of items) {
      slot.items.set(id, item);
      slot.owners.set(id, extensionId);
    }
  }

  private emit(change: RegistryChange, hooks: Array<() => void> = []): void {
    // Error policy: commit all internal state first, then run every hook and
    // subscriber, collecting failures. Rollback cannot undo callback side
    // effects, so an AggregateError reports a COMMITTED operation, not a failed
    // validation. Callers must inspect state rather than retry that operation.
    // Snapshot subscribers so a throwing callback cannot prevent delivery to
    // the others, and subscription changes apply to subsequent notifications.
    const callbacks = [...hooks, ...Array.from(this.listeners, (listener) => () => listener(change))];
    const errors: unknown[] = [];
    for (const callback of callbacks) {
      try {
        callback();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length) {
      throw new AggregateError(errors, `registry ${change.type} committed, but callbacks failed`);
    }
  }
}

/**
 * Conformance kit: every editor that registers a kind runs this against its
 * kind definition with two distinct sample items. Mirrors Hyperdrive's
 * "contract + impl + test double + conformance" rule.
 */
export function runContributionKindConformance<T extends Contribution>(
  makeRegistry: () => ContributionRegistry,
  kindDef: ContributionKind<T>,
  samples: [T, T],
  assert: (ok: boolean, message: string) => void,
): void {
  const [a, b] = samples;
  assert(a.id !== b.id, 'samples must have distinct ids');

  // install routes items and lists them
  {
    const r = makeRegistry();
    r.registerKind(kindDef);
    const res = r.install({ id: 'ext.a', version: '1', contributions: { [kindDef.kind]: [a, b] } });
    assert(res.installed[kindDef.kind]?.length === 2, 'install routes both items');
    assert(r.list<T>(kindDef.kind).length === 2, 'list returns installed items');
    const installed = r.get<T>(kindDef.kind, a.id);
    assert(installed === a && installed === r.list<T>(kindDef.kind)[0], 'get and list return the original item');
  }
  // duplicate id rejected and registry untouched
  {
    const r = makeRegistry();
    r.registerKind(kindDef);
    r.install({ id: 'ext.a', version: '1', contributions: { [kindDef.kind]: [a] } });
    let threw = false;
    try {
      r.install({ id: 'ext.b', version: '1', contributions: { [kindDef.kind]: [b, a] } });
    } catch {
      threw = true;
    }
    assert(threw, 'duplicate id throws');
    assert(r.list(kindDef.kind).length === 1, 'failed install leaves registry untouched');
    assert(r.installedExtensions().length === 1, 'failed install is not recorded');
  }
  // uninstall removes
  {
    const r = makeRegistry();
    r.registerKind(kindDef);
    r.install({ id: 'ext.a', version: '1', contributions: { [kindDef.kind]: [a] } });
    r.uninstall('ext.a');
    assert(r.list(kindDef.kind).length === 0, 'uninstall removes items');
  }
  // pending replays when the kind registers later
  {
    const r = makeRegistry();
    const res = r.install({ id: 'ext.a', version: '1', contributions: { [kindDef.kind]: [a] } });
    assert(res.pending.includes(kindDef.kind), 'unregistered kind is pending');
    r.registerKind(kindDef);
    assert(r.list(kindDef.kind).length === 1, 'late kind registration replays pending items');
    assert(Object.keys(r.pending()).length === 0, 'nothing pending after replay');
  }
  // subscribe fires
  {
    const r = makeRegistry();
    const seen: string[] = [];
    r.subscribe((c) => seen.push(c.type));
    r.registerKind(kindDef);
    r.install({ id: 'ext.a', version: '1', contributions: { [kindDef.kind]: [a] } });
    r.uninstall('ext.a');
    assert(
      seen.join(',') === 'kind-registered,installed,uninstalled',
      `subscribe sees register/install/uninstall (got ${seen.join(',')})`,
    );
  }
}

// =============================================================================
// WELL-KNOWN KINDS shared by the Holodeck editors (string constants only; the
// item shapes live with the editor that registers the kind).
// =============================================================================

export const HOLODECK_KINDS = {
  /** 2D flow editor (editor-2d-react): React Flow node component keyed by id. */
  flowNodeType: 'holodeck.flow.nodeType',
  flowEdgeType: 'holodeck.flow.edgeType',
  /** 2D flow editor palette entries (`ScenePaletteItem`). */
  flowPalette: 'holodeck.flow.palette',
  /** 3D viewer (viewer-3d-react) object renderer (`SceneObjectRenderer`). */
  scene3dRenderer: 'holodeck.scene3d.renderer',
  /** 2.5D iso editor (editor-2.5d-react). */
  isoPart: 'holodeck.iso.part',
  isoTheme: 'holodeck.iso.theme',
  isoAnimator: 'holodeck.iso.animator',
  isoInspector: 'holodeck.iso.inspector',
} as const;

export interface FlowComponentContribution extends Contribution {
  component: HolodeckComponent;
}

/**
 * Bridge for the older Tier-1 `SceneComponentPack`: the same content expressed
 * as an extension so one registry serves both.
 */
export function packToExtension(pack: SceneComponentPack): HolodeckExtension {
  const contributions: Record<string, Contribution[]> = {};
  if (pack.paletteItems?.length) {
    contributions[HOLODECK_KINDS.flowPalette] = pack.paletteItems.map((p) => ({ ...p }));
  }
  if (pack.nodeTypes) {
    contributions[HOLODECK_KINDS.flowNodeType] = Object.entries(pack.nodeTypes).map(
      ([id, component]): FlowComponentContribution => ({ id, component }),
    );
  }
  if (pack.edgeTypes) {
    contributions[HOLODECK_KINDS.flowEdgeType] = Object.entries(pack.edgeTypes).map(
      ([id, component]): FlowComponentContribution => ({ id, component }),
    );
  }
  if (pack.objectRenderers) {
    contributions[HOLODECK_KINDS.scene3dRenderer] = Object.entries(pack.objectRenderers).map(([id, r]) => ({
      id,
      ...r,
    }));
  }
  return { id: pack.id, version: pack.version, contributions };
}
