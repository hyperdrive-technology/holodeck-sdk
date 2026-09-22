/**
 * Holodeck SDK - Core Types and Interfaces
 *
 * Foundation interfaces for the Holodeck ecosystem.
 * Used by importers, providers, and visualization components.
 */

// =============================================================================
// CORE SCENE TYPES
// =============================================================================

/**
 * 3D position in scene space
 */
export interface Vector3 {
  x: number;
  y: number;
  z: number;
}

/**
 * 3D rotation (Euler angles in radians)
 */
export interface Euler3 {
  x: number;
  y: number;
  z: number;
}

/**
 * 3D scale factors
 */
export interface Scale3 {
  x: number;
  y: number;
  z: number;
}

/**
 * Transform matrix for 3D positioning
 */
export interface Transform {
  position: Vector3;
  rotation: Euler3;
  scale: Scale3;
}

/**
 * RGBA color representation
 */
export interface Color {
  r: number; // 0-1
  g: number; // 0-1
  b: number; // 0-1
  a?: number; // 0-1, default 1
}

/**
 * Material properties for 3D rendering
 */
export interface Material {
  color?: Color;
  emissive?: Color;
  metalness?: number; // 0-1
  roughness?: number; // 0-1
  opacity?: number; // 0-1
  transparent?: boolean;
  wireframe?: boolean;
  texture?: string; // URL or asset ID
}

/**
 * Geometry definition for 3D objects
 */
export interface Geometry {
  type: 'box' | 'sphere' | 'cylinder' | 'plane' | 'custom';
  parameters?: Record<string, any>;
  asset?: string; // URL or asset ID for custom geometry
}

/**
 * Animation keyframe
 */
export interface Keyframe {
  time: number; // seconds
  value: any;
  easing?: 'linear' | 'ease-in' | 'ease-out' | 'ease-in-out';
}

/**
 * Animation track definition
 */
export interface AnimationTrack {
  property: string; // dot notation path: 'transform.position.x'
  keyframes: Keyframe[];
}

/**
 * Animation definition
 */
export interface Animation {
  name: string;
  duration: number; // seconds
  loop?: boolean;
  tracks: AnimationTrack[];
}

/**
 * Individual node in the scene graph
 */
export interface SceneNode {
  id: string;
  type: string; // 'server', 'database', 'network', 'container', etc.
  name: string;

  // 3D Properties
  transform: Transform;
  geometry?: Geometry;
  material?: Material;
  visible?: boolean;

  // Data Properties
  metadata?: Record<string, any>;
  tags?: string[];

  // Live Data
  metrics?: Record<string, any>;
  status?: 'healthy' | 'warning' | 'critical' | 'unknown';

  // Animation
  animations?: Animation[];

  // Hierarchy
  parent?: string; // parent node ID
  children?: string[]; // child node IDs

  // Extensibility
  extensions?: Record<string, any>;
}

/**
 * Connection between two nodes
 */
export interface SceneEdge {
  id: string;
  source: string; // source node ID
  target: string; // target node ID
  type?: string; // 'network', 'data-flow', 'dependency', etc.

  // Visual Properties
  color?: Color;
  width?: number;
  style?: 'solid' | 'dashed' | 'dotted';
  opacity?: number;

  // Data Properties
  metadata?: Record<string, any>;
  metrics?: Record<string, any>;

  // Animation
  animations?: Animation[];

  // Extensibility
  extensions?: Record<string, any>;
}

/**
 * Scene graph containing all nodes and edges
 */
export interface SceneGraph {
  nodes: SceneNode[];
  edges: SceneEdge[];

  // Scene-level properties
  bounds?: {
    min: Vector3;
    max: Vector3;
  };

  // Camera settings
  camera?: {
    position: Vector3;
    target: Vector3;
    fov?: number;
    near?: number;
    far?: number;
  };

  // Lighting
  lights?: Array<{
    type: 'ambient' | 'directional' | 'point' | 'spot';
    color?: Color;
    intensity?: number;
    position?: Vector3;
    direction?: Vector3;
  }>;

  // Environment
  environment?: {
    background?: Color | string; // color or skybox URL
    fog?: {
      color: Color;
      near: number;
      far: number;
    };
  };
}

/**
 * Scene metadata
 */
export interface SceneMetadata {
  name: string;
  description?: string;
  author?: string;
  version?: string;
  created?: string; // ISO timestamp
  updated?: string; // ISO timestamp
  tags?: string[];

  // Import info
  importSource?: string;
  importedAt?: string;
  importedBy?: string;

  // Extensibility
  extensions?: Record<string, any>;
}

/**
 * Complete scene file
 */
export interface SceneFile {
  version: string; // SDK version
  metadata: SceneMetadata;
  scene: SceneGraph;

  // Asset references
  assets?: Record<string, string>; // asset ID -> URL mapping

  // Extensibility
  extensions?: Record<string, any>;
}

export type HolodeckLiveConnectionState = 'live' | 'stale' | 'disconnected';

export interface HolodeckLiveConnection {
  state: HolodeckLiveConnectionState;
  targetId: string;
  targetLabel: string;
}

export function liveOverlayCopy(connection: HolodeckLiveConnection): string {
  return `Live · ${connection.targetLabel}`;
}

// =============================================================================
// PLUGIN INTERFACES
// =============================================================================

/**
 * Importer configuration
 */
export interface ImporterConfig {
  [key: string]: any;
}

/**
 * Import result
 */
export interface ImportResult {
  scene: SceneFile;
  warnings?: string[];
  errors?: string[];
}

/**
 * Importer interface for converting external data to SceneFiles
 */
export interface Importer {
  id: string;
  name: string;
  description?: string;
  version?: string;

  // Supported formats
  supportedFormats: string[]; // file extensions: ['.tf', '.yaml', '.json']
  supportedMimeTypes?: string[];

  // Configuration schema
  configSchema?: any; // JSON Schema for config validation

  // Import methods
  import(input: string | ArrayBuffer | Uint8Array, config?: ImporterConfig): Promise<ImportResult>;
  validate?(input: string | ArrayBuffer | Uint8Array): Promise<boolean>;

  // Metadata
  metadata?: Record<string, any>;
}

/**
 * Provider configuration
 */
export interface ProviderConfig {
  [key: string]: any;
}

/**
 * Metrics query
 */
export interface MetricsQuery {
  nodeIds?: string[];
  metricNames?: string[];
  from?: Date;
  to?: Date;
  resolution?: number; // seconds
  filters?: Record<string, any>;
}

/**
 * Metrics data point
 */
export interface MetricsDataPoint {
  timestamp: Date;
  value: number | string | boolean;
  tags?: Record<string, string>;
}

/**
 * Metrics result
 */
export interface MetricsResult {
  nodeId: string;
  metricName: string;
  dataPoints: MetricsDataPoint[];
  unit?: string;
  metadata?: Record<string, any>;
}

/**
 * Provider interface for supplying live data
 */
export interface Provider {
  id: string;
  name: string;
  description?: string;
  version?: string;

  // Configuration
  configSchema?: any; // JSON Schema for config validation

  // Connection lifecycle
  connect(config: ProviderConfig): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;

  // Data methods
  query(query: MetricsQuery): Promise<MetricsResult[]>;
  subscribe?(query: MetricsQuery, callback: (results: MetricsResult[]) => void): () => void;

  // Health check
  healthCheck?(): Promise<boolean>;

  // Metadata
  metadata?: Record<string, any>;
}

/**
 * Animation hook context
 */
export interface AnimationContext {
  scene: SceneGraph;
  deltaTime: number;
  elapsedTime: number;
  frameCount: number;
}

/**
 * Animation hook for custom behaviors
 */
export interface AnimationHook {
  id: string;
  name: string;
  description?: string;
  version?: string;

  // Hook methods
  onFrame?(context: AnimationContext): void;
  onNodeUpdate?(nodeId: string, node: SceneNode, context: AnimationContext): void;
  onEdgeUpdate?(edgeId: string, edge: SceneEdge, context: AnimationContext): void;

  // Lifecycle
  onStart?(context: AnimationContext): void;
  onStop?(context: AnimationContext): void;

  // Configuration
  configSchema?: any;

  // Metadata
  metadata?: Record<string, any>;
}

// =============================================================================
// SCENE EXTENSION CONTRACTS (Tier 1 + Tier 2)
// =============================================================================

/**
 * Framework-agnostic React component slot.
 * Host apps (editor-2d-react, Hyperdrive UI) map this to `React.ComponentType` at compile time.
 */
export type HolodeckComponent = (props: Record<string, unknown>) => unknown;

/**
 * Palette entry for drag-and-drop node creation in editor-2d-react.
 */
export interface ScenePaletteItem {
  /** Unique palette id (e.g. "vendor:pump-v2"). */
  id: string;
  /** Default `SceneNode.type` assigned when dropped. */
  nodeType: string;
  label: string;
  description?: string;
  /** Optional default geometry/material applied to new nodes. */
  defaults?: Partial<Pick<SceneNode, 'transform' | 'geometry' | 'material' | 'metadata'>>;
}

/**
 * Auto-layout hints consumed by editor-2d-react (dagre direction, spacing, etc.).
 */
export interface SceneLayoutConfig {
  nodeSpacing?: number;
  rankSpacing?: number;
  direction?: 'TB' | 'BT' | 'LR' | 'RL';
  align?: 'UL' | 'UR' | 'DL' | 'DR';
}

/**
 * Custom 3D object renderer keyed by `SceneNode.type` for viewer-3d-react.
 */
export interface SceneObjectRenderer {
  /** Matches `SceneNode.type` (e.g. "vendor:pump-v2"). */
  nodeType: string;
  /** Host maps to a R3F/React renderer component. */
  render: HolodeckComponent;
}

/**
 * Tier 1 — content pack for **existing** Holodeck 2D/3D scenes.
 *
 * Third-party npm packages export a `SceneComponentPack` that the host merges into
 * built-in registries (`editor-2d-react` node/edge types, `viewer-3d-react` object renderers).
 * Conflicts on `nodeTypes` / `objectRenderers` keys must fail at registration time.
 *
 * Holodeck extensions must **not** compile `.plc`, bind IEC addresses, or deploy runtimes.
 * Live data enters via generic `Provider` metrics or host-supplied overlay callbacks only.
 */
export interface SceneComponentPack {
  id: string;
  version: string;
  /** 2D editor palette (editor-2d-react). */
  paletteItems?: ScenePaletteItem[];
  /** Custom React Flow node components keyed by type id. */
  nodeTypes?: Record<string, HolodeckComponent>;
  /** Custom React Flow edge components keyed by type id. */
  edgeTypes?: Record<string, HolodeckComponent>;
  /** Default layout algorithm configuration for the pack. */
  layoutConfig?: SceneLayoutConfig;
  /** 3D object renderers keyed by `SceneNode.type` (viewer-3d-react). */
  objectRenderers?: Record<string, SceneObjectRenderer>;
  /**
   * Optional live-data overlay hook — maps generic metrics/status onto scene nodes.
   * Must not reference IEC tag names; host apps supply binding semantics.
   */
  overlayAdapter?: (node: SceneNode, metrics: Record<string, unknown>) => SceneNode;
}

/**
 * Tier 2 — adapter for a **new scene editor or viewer** that still uses `SceneFile`.
 *
 * Authors may replace React Flow / R3F internally (P&ID ortho canvas, network topology, etc.)
 * while keeping `@holodeck/sdk` `SceneFile` as the interchange format — no parallel scene model.
 */
export interface SceneEditorAdapter {
  id: string;
  name: string;
  version?: string;
  /** Extension namespaces this editor owns (e.g. "extensions.acme.pid"). */
  supportedExtensions?: string[];
  load(scene: SceneFile): void | Promise<void>;
  save(): SceneFile | Promise<SceneFile>;
}

/**
 * Tier 2 — read-only viewer adapter with the same `SceneFile` contract as `SceneEditorAdapter`.
 */
export interface SceneViewerAdapter {
  id: string;
  name: string;
  version?: string;
  supportedExtensions?: string[];
  load(scene: SceneFile): void | Promise<void>;
}

// =============================================================================
// UTILITY TYPES
// =============================================================================

/**
 * Plugin registry entry
 */
export interface PluginRegistryEntry<T = any> {
  id: string;
  instance: T;
  metadata?: Record<string, any>;
}

/**
 * Plugin registry
 */
export interface PluginRegistry {
  importers: Map<string, PluginRegistryEntry<Importer>>;
  providers: Map<string, PluginRegistryEntry<Provider>>;
  animationHooks: Map<string, PluginRegistryEntry<AnimationHook>>;
}

/**
 * Scene validation result
 */
export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * Scene statistics
 */
export interface SceneStats {
  nodeCount: number;
  edgeCount: number;
  totalVertices?: number;
  totalTriangles?: number;
  memoryUsage?: number; // bytes
  bounds?: {
    min: Vector3;
    max: Vector3;
    size: Vector3;
  };
}

// =============================================================================
// UTILITY FUNCTIONS
// =============================================================================

/**
 * Create a default transform
 */
export function createTransform(
  position: Partial<Vector3> = {},
  rotation: Partial<Euler3> = {},
  scale: Partial<Scale3> = {}
): Transform {
  return {
    position: { x: 0, y: 0, z: 0, ...position },
    rotation: { x: 0, y: 0, z: 0, ...rotation },
    scale: { x: 1, y: 1, z: 1, ...scale }
  };
}

/**
 * Create a default material
 */
export function createMaterial(overrides: Partial<Material> = {}): Material {
  return {
    color: { r: 0.8, g: 0.8, b: 0.8, a: 1 },
    metalness: 0.0,
    roughness: 0.5,
    opacity: 1.0,
    transparent: false,
    wireframe: false,
    ...overrides
  };
}

/**
 * Generate a unique ID
 */
export function generateId(): string {
  return Math.random().toString(36).substr(2, 9);
}

/**
 * Validate scene file structure
 */
export function validateScene(scene: SceneFile): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Basic validation
  if (!scene.version) {
    errors.push('Scene file must have a version');
  }

  if (!scene.metadata?.name) {
    errors.push('Scene file must have a name');
  }

  if (!scene.scene?.nodes) {
    errors.push('Scene file must have nodes');
  }

  // Node validation
  const nodeIds = new Set<string>();
  for (const node of scene.scene.nodes || []) {
    if (!node.id) {
      errors.push('All nodes must have an id');
    } else if (nodeIds.has(node.id)) {
      errors.push(`Duplicate node id: ${node.id}`);
    } else {
      nodeIds.add(node.id);
    }

    if (!node.name) {
      warnings.push(`Node ${node.id} has no name`);
    }
  }

  // Edge validation
  const edgeIds = new Set<string>();
  for (const edge of scene.scene.edges || []) {
    if (!edge.id) {
      errors.push('All edges must have an id');
    } else if (edgeIds.has(edge.id)) {
      errors.push(`Duplicate edge id: ${edge.id}`);
    } else {
      edgeIds.add(edge.id);
    }

    if (!nodeIds.has(edge.source)) {
      errors.push(`Edge ${edge.id} references non-existent source node: ${edge.source}`);
    }

    if (!nodeIds.has(edge.target)) {
      errors.push(`Edge ${edge.id} references non-existent target node: ${edge.target}`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings
  };
}

/**
 * Calculate scene statistics
 */
export function calculateSceneStats(scene: SceneFile): SceneStats {
  const stats: SceneStats = {
    nodeCount: scene.scene.nodes?.length || 0,
    edgeCount: scene.scene.edges?.length || 0
  };

  // Calculate bounds
  const positions = scene.scene.nodes
    ?.map(node => node.transform.position)
    .filter(Boolean) || [];

  if (positions.length > 0) {
    const xs = positions.map(p => p.x);
    const ys = positions.map(p => p.y);
    const zs = positions.map(p => p.z);

    const min = {
      x: Math.min(...xs),
      y: Math.min(...ys),
      z: Math.min(...zs)
    };

    const max = {
      x: Math.max(...xs),
      y: Math.max(...ys),
      z: Math.max(...zs)
    };

    stats.bounds = {
      min,
      max,
      size: {
        x: max.x - min.x,
        y: max.y - min.y,
        z: max.z - min.z
      }
    };
  }

  return stats;
}
