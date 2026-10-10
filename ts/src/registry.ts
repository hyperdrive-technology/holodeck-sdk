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
 * - `install` is atomic: validation runs for every kind first, then the
 *   registry mutates. A failed install leaves the registry untouched.
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
  /** Structural check run at install time; a failing item rejects the whole install. */
  validate?: (item: unknown) => item is T;
  /** Called after the registry has been updated. */
  onInstall?: (items: T[], extensionId: string) => void;
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
  /** id → item */
  items: Map<string, Contribution>;
  /** id → owning extension */
  owners: Map<string, string>;
}

export class ContributionRegistry {
  private readonly kinds = new Map<string, KindSlot>();
  /** extensionId → extension (kept so uninstall and late kind registration can replay) */
  private readonly extensions = new Map<string, HolodeckExtension>();
  private readonly listeners = new Set<(change: RegistryChange) => void>();

  /** Register a kind this editor can receive. Returns an unregister function. */
  registerKind<T extends Contribution>(def: ContributionKind<T>): () => void {
    if (this.kinds.has(def.kind)) {
      throw new ContributionRegistryError(`kind "${def.kind}" is already registered`, 'DUPLICATE_KIND');
    }
    const slot: KindSlot = { def: def as unknown as ContributionKind, items: new Map(), owners: new Map() };
    this.kinds.set(def.kind, slot);
    this.emit({ type: 'kind-registered', kind: def.kind });

    // Replay contributions of this kind from extensions installed before the
    // editor mounted (the "pending" case). Validation failures here are thrown
    // so a bad pack is visible rather than silently dropped.
    for (const ext of this.extensions.values()) {
      const items = ext.contributions[def.kind];
      if (items?.length) {
        this.validateItems(slot, items, ext.id);
        this.commitItems(slot, items, ext.id);
      }
    }

    return () => {
      if (this.kinds.get(def.kind) !== slot) return;
      this.kinds.delete(def.kind);
      this.emit({ type: 'kind-unregistered', kind: def.kind });
    };
  }

  hasKind(kind: string): boolean {
    return this.kinds.has(kind);
  }

  /** Install an extension. Atomic: all kinds validate before any mutate. */
  install(ext: HolodeckExtension): InstallResult {
    if (this.extensions.has(ext.id)) {
      throw new ContributionRegistryError(`extension "${ext.id}" is already installed`, 'DUPLICATE_EXTENSION');
    }
    const routed: Array<[KindSlot, Contribution[]]> = [];
    const pending: string[] = [];
    for (const [kind, items] of Object.entries(ext.contributions)) {
      const slot = this.kinds.get(kind);
      if (!slot) {
        pending.push(kind);
        continue;
      }
      this.validateItems(slot, items, ext.id);
      routed.push([slot, items]);
    }

    this.extensions.set(ext.id, ext);
    const installed: Record<string, string[]> = {};
    for (const [slot, items] of routed) {
      this.commitItems(slot, items, ext.id);
      installed[slot.def.kind] = items.map((i) => i.id);
    }
    this.emit({ type: 'installed', extensionId: ext.id, kinds: Object.keys(installed) });
    return { extensionId: ext.id, installed, pending };
  }

  uninstall(extensionId: string): void {
    const ext = this.extensions.get(extensionId);
    if (!ext) {
      throw new ContributionRegistryError(`extension "${extensionId}" is not installed`, 'UNKNOWN_EXTENSION');
    }
    this.extensions.delete(extensionId);
    const kinds: string[] = [];
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
        kinds.push(slot.def.kind);
        slot.def.onUninstall?.(removed, extensionId);
      }
    }
    this.emit({ type: 'uninstalled', extensionId, kinds });
  }

  list<T extends Contribution>(kind: string): readonly T[] {
    const slot = this.kinds.get(kind);
    return slot ? (Array.from(slot.items.values()) as T[]) : [];
  }

  get<T extends Contribution>(kind: string, id: string): T | undefined {
    return this.kinds.get(kind)?.items.get(id) as T | undefined;
  }

  /** Which extension contributed `id` to `kind`. */
  ownerOf(kind: string, id: string): string | undefined {
    return this.kinds.get(kind)?.owners.get(id);
  }

  installedExtensions(): readonly HolodeckExtension[] {
    return Array.from(this.extensions.values());
  }

  /** Contributions whose kind no editor has registered. */
  pending(): Record<string, Contribution[]> {
    const out: Record<string, Contribution[]> = {};
    for (const ext of this.extensions.values()) {
      for (const [kind, items] of Object.entries(ext.contributions)) {
        if (!this.kinds.has(kind) && items.length) {
          (out[kind] ??= []).push(...items);
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

  private validateItems(slot: KindSlot, items: Contribution[], extensionId: string): void {
    const seen = new Set<string>();
    for (const item of items) {
      if (!item || typeof item !== 'object' || typeof (item as Contribution).id !== 'string') {
        throw new ContributionRegistryError(
          `extension "${extensionId}" has a ${slot.def.kind} contribution without a string id`,
          'INVALID_ITEM',
        );
      }
      if (seen.has(item.id) || slot.items.has(item.id)) {
        const owner = slot.owners.get(item.id) ?? extensionId;
        throw new ContributionRegistryError(
          `${slot.def.kind} "${item.id}" from "${extensionId}" conflicts with "${owner}"`,
          'DUPLICATE_ID',
        );
      }
      const validate = slot.def.validate as ((x: unknown) => boolean) | undefined;
      if (validate && !validate(item)) {
        throw new ContributionRegistryError(
          `${slot.def.kind} "${item.id}" from "${extensionId}" failed validation`,
          'INVALID_ITEM',
        );
      }
      seen.add(item.id);
    }
  }

  private commitItems(slot: KindSlot, items: Contribution[], extensionId: string): void {
    for (const item of items) {
      slot.items.set(item.id, item);
      slot.owners.set(item.id, extensionId);
    }
    slot.def.onInstall?.(items, extensionId);
  }

  private emit(change: RegistryChange): void {
    for (const l of this.listeners) l(change);
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
    assert(r.get<T>(kindDef.kind, a.id) === a, 'get returns the same object');
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
