/**
 * @fileoverview Tests for the Holodeck SDK TypeScript package
 */

import { describe, it, expect } from 'vitest';
import {
  createTransform,
  createMaterial,
  generateId,
  validateScene,
  calculateSceneStats,
  liveOverlayCopy,
  type SceneFile,
  type SceneNode,
  type SceneEdge,
  type Vector3,
  type Transform,
  type Material,
  type ValidationResult,
  type SceneStats
} from './index.js';

// =============================================================================
// UTILITY FUNCTION TESTS
// =============================================================================

describe('createTransform', () => {
  it('should create default transform with all zeros position and rotation, ones scale', () => {
    const transform = createTransform();
    expect(transform).toEqual({
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0 },
      scale: { x: 1, y: 1, z: 1 }
    });
  });

  it('should merge partial position values', () => {
    const transform = createTransform({ x: 10, y: 20 });
    expect(transform.position).toEqual({ x: 10, y: 20, z: 0 });
  });

  it('should merge partial rotation values', () => {
    const transform = createTransform({}, { x: Math.PI, z: Math.PI / 2 });
    expect(transform.rotation).toEqual({ x: Math.PI, y: 0, z: Math.PI / 2 });
  });

  it('should merge partial scale values', () => {
    const transform = createTransform({}, {}, { x: 2, y: 0.5 });
    expect(transform.scale).toEqual({ x: 2, y: 0.5, z: 1 });
  });

  it('should handle all partial values together', () => {
    const transform = createTransform(
      { x: 1, y: 2 },
      { z: Math.PI },
      { x: 2, y: 2, z: 2 }
    );
    expect(transform).toEqual({
      position: { x: 1, y: 2, z: 0 },
      rotation: { x: 0, y: 0, z: Math.PI },
      scale: { x: 2, y: 2, z: 2 }
    });
  });
});

describe('createMaterial', () => {
  it('should create default material with standard values', () => {
    const material = createMaterial();
    expect(material).toEqual({
      color: { r: 0.8, g: 0.8, b: 0.8, a: 1 },
      metalness: 0.0,
      roughness: 0.5,
      opacity: 1.0,
      transparent: false,
      wireframe: false
    });
  });

  it('should merge override values', () => {
    const material = createMaterial({
      color: { r: 1, g: 0, b: 0, a: 0.5 },
      metalness: 1.0,
      wireframe: true
    });
    expect(material).toEqual({
      color: { r: 1, g: 0, b: 0, a: 0.5 },
      metalness: 1.0,
      roughness: 0.5,
      opacity: 1.0,
      transparent: false,
      wireframe: true
    });
  });

  it('should handle partial color overrides', () => {
    const material = createMaterial({
      color: { r: 1, g: 0, b: 0 }
    });
    expect(material.color).toEqual({ r: 1, g: 0, b: 0 });
  });
});

describe('generateId', () => {
  it('should generate non-empty strings', () => {
    const id = generateId();
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
  });

  it('should generate unique IDs', () => {
    const ids = new Set();
    for (let i = 0; i < 1000; i++) {
      ids.add(generateId());
    }
    expect(ids.size).toBe(1000);
  });

  it('should generate alphanumeric IDs', () => {
    const id = generateId();
    expect(id).toMatch(/^[a-z0-9]+$/);
  });
});

// =============================================================================
// VALIDATION TESTS
// =============================================================================

describe('validateScene', () => {
  const createValidScene = (): SceneFile => ({
    version: '0.1.0',
    metadata: {
      name: 'Test Scene',
      description: 'A test scene for validation',
      author: 'Test Author'
    },
    scene: {
      nodes: [
        {
          id: 'node1',
          type: 'server',
          name: 'Test Server',
          transform: createTransform()
        },
        {
          id: 'node2',
          type: 'database',
          name: 'Test Database',
          transform: createTransform()
        }
      ],
      edges: [
        {
          id: 'edge1',
          source: 'node1',
          target: 'node2',
          type: 'connection'
        }
      ]
    }
  });

  it('should validate a complete valid scene', () => {
    const scene = createValidScene();
    const result = validateScene(scene);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('should require version', () => {
    const scene = createValidScene();
    delete (scene as any).version;
    const result = validateScene(scene);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Scene file must have a version');
  });

  it('should require metadata name', () => {
    const scene = createValidScene();
    delete scene.metadata.name;
    const result = validateScene(scene);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Scene file must have a name');
  });

  it('should require nodes', () => {
    const scene = createValidScene();
    delete (scene.scene as any).nodes;
    const result = validateScene(scene);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Scene file must have nodes');
  });

  it('should require node IDs', () => {
    const scene = createValidScene();
    delete (scene.scene.nodes[0] as any).id;
    const result = validateScene(scene);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('All nodes must have an id');
  });

  it('should detect duplicate node IDs', () => {
    const scene = createValidScene();
    scene.scene.nodes[1].id = 'node1'; // Same as first node
    const result = validateScene(scene);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Duplicate node id: node1');
  });

  it('should warn about missing node names', () => {
    const scene = createValidScene();
    delete (scene.scene.nodes[0] as any).name;
    const result = validateScene(scene);
    expect(result.valid).toBe(true); // Still valid, just a warning
    expect(result.warnings).toContain('Node node1 has no name');
  });

  it('should require edge IDs', () => {
    const scene = createValidScene();
    delete (scene.scene.edges[0] as any).id;
    const result = validateScene(scene);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('All edges must have an id');
  });

  it('should detect duplicate edge IDs', () => {
    const scene = createValidScene();
    scene.scene.edges.push({
      id: 'edge1', // Same as existing edge
      source: 'node2',
      target: 'node1'
    });
    const result = validateScene(scene);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Duplicate edge id: edge1');
  });

  it('should validate edge source references', () => {
    const scene = createValidScene();
    scene.scene.edges[0].source = 'nonexistent';
    const result = validateScene(scene);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Edge edge1 references non-existent source node: nonexistent');
  });

  it('should validate edge target references', () => {
    const scene = createValidScene();
    scene.scene.edges[0].target = 'nonexistent';
    const result = validateScene(scene);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Edge edge1 references non-existent target node: nonexistent');
  });

  it('should handle empty edges array', () => {
    const scene = createValidScene();
    scene.scene.edges = [];
    const result = validateScene(scene);
    expect(result.valid).toBe(true);
  });

  it('should handle missing edges array', () => {
    const scene = createValidScene();
    delete (scene.scene as any).edges;
    const result = validateScene(scene);
    expect(result.valid).toBe(true);
  });
});

// =============================================================================
// STATISTICS TESTS
// =============================================================================

describe('calculateSceneStats', () => {
  const createTestScene = (nodePositions: Vector3[]): SceneFile => ({
    version: '0.1.0',
    metadata: { name: 'Test Scene' },
    scene: {
      nodes: nodePositions.map((pos, i) => ({
        id: `node${i}`,
        type: 'server',
        name: `Node ${i}`,
        transform: { ...createTransform(), position: pos }
      })),
      edges: []
    }
  });

  it('should calculate basic counts', () => {
    const scene = createTestScene([
      { x: 0, y: 0, z: 0 },
      { x: 10, y: 10, z: 10 }
    ]);
    scene.scene.edges = [
      { id: 'e1', source: 'node0', target: 'node1' },
      { id: 'e2', source: 'node1', target: 'node0' }
    ];

    const stats = calculateSceneStats(scene);
    expect(stats.nodeCount).toBe(2);
    expect(stats.edgeCount).toBe(2);
  });

  it('should calculate bounds for multiple nodes', () => {
    const scene = createTestScene([
      { x: 0, y: 0, z: 0 },
      { x: 10, y: 20, z: 30 },
      { x: -5, y: -10, z: -15 }
    ]);

    const stats = calculateSceneStats(scene);
    expect(stats.bounds).toEqual({
      min: { x: -5, y: -10, z: -15 },
      max: { x: 10, y: 20, z: 30 },
      size: { x: 15, y: 30, z: 45 }
    });
  });

  it('should handle single node bounds', () => {
    const scene = createTestScene([{ x: 5, y: 10, z: 15 }]);

    const stats = calculateSceneStats(scene);
    expect(stats.bounds).toEqual({
      min: { x: 5, y: 10, z: 15 },
      max: { x: 5, y: 10, z: 15 },
      size: { x: 0, y: 0, z: 0 }
    });
  });

  it('should handle empty scene', () => {
    const scene: SceneFile = {
      version: '0.1.0',
      metadata: { name: 'Empty Scene' },
      scene: { nodes: [], edges: [] }
    };

    const stats = calculateSceneStats(scene);
    expect(stats.nodeCount).toBe(0);
    expect(stats.edgeCount).toBe(0);
    expect(stats.bounds).toBeUndefined();
  });

  it('should handle missing nodes array', () => {
    const scene: SceneFile = {
      version: '0.1.0',
      metadata: { name: 'Invalid Scene' },
      scene: {} as any
    };

    const stats = calculateSceneStats(scene);
    expect(stats.nodeCount).toBe(0);
    expect(stats.edgeCount).toBe(0);
  });
});

// =============================================================================
// TYPE VALIDATION TESTS
// =============================================================================

describe('Type Validation', () => {
  it('should properly type Vector3', () => {
    const vector: Vector3 = { x: 1, y: 2, z: 3 };
    expect(vector.x).toBe(1);
    expect(vector.y).toBe(2);
    expect(vector.z).toBe(3);
  });

  it('should properly type Transform', () => {
    const transform: Transform = {
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0 },
      scale: { x: 1, y: 1, z: 1 }
    };
    expect(transform.position).toBeDefined();
    expect(transform.rotation).toBeDefined();
    expect(transform.scale).toBeDefined();
  });

  it('should properly type Material', () => {
    const material: Material = {
      color: { r: 1, g: 0, b: 0, a: 1 },
      metalness: 0.5,
      roughness: 0.5,
      opacity: 1.0,
      transparent: false,
      wireframe: false
    };
    expect(material.color?.r).toBe(1);
    expect(material.metalness).toBe(0.5);
  });

  it('should properly type SceneNode', () => {
    const node: SceneNode = {
      id: 'test-node',
      type: 'server',
      name: 'Test Server',
      transform: createTransform(),
      visible: true,
      metadata: { cpu: '2.4GHz', ram: '16GB' },
      tags: ['production', 'web-server'],
      status: 'healthy'
    };
    expect(node.id).toBe('test-node');
    expect(node.metadata?.cpu).toBe('2.4GHz');
    expect(node.tags).toContain('production');
    expect(node.status).toBe('healthy');
  });

  it('should properly type SceneEdge', () => {
    const edge: SceneEdge = {
      id: 'test-edge',
      source: 'node1',
      target: 'node2',
      type: 'network',
      color: { r: 0, g: 1, b: 0, a: 1 },
      width: 2,
      style: 'solid',
      opacity: 0.8
    };
    expect(edge.source).toBe('node1');
    expect(edge.target).toBe('node2');
    expect(edge.color?.g).toBe(1);
    expect(edge.style).toBe('solid');
  });
});

// =============================================================================
// INTEGRATION TESTS
// =============================================================================

describe('Integration Tests', () => {
  it('should create and validate a complete scene', () => {
    // Create nodes
    const server: SceneNode = {
      id: 'server-1',
      type: 'server',
      name: 'Web Server',
      transform: createTransform({ x: 0, y: 0, z: 0 }),
      material: createMaterial({ color: { r: 0, g: 1, b: 0, a: 1 } }),
      geometry: { type: 'box', parameters: { width: 2, height: 1, depth: 1 } },
      metadata: { cpu: '2.4GHz', ram: '16GB', os: 'Ubuntu 20.04' },
      status: 'healthy'
    };

    const database: SceneNode = {
      id: 'db-1',
      type: 'database',
      name: 'PostgreSQL Database',
      transform: createTransform({ x: 5, y: 0, z: 0 }),
      material: createMaterial({ color: { r: 0, g: 0, b: 1, a: 1 } }),
      geometry: { type: 'cylinder', parameters: { radius: 1, height: 2 } },
      metadata: { version: '13.4', storage: '1TB' },
      status: 'healthy'
    };

    // Create edge
    const connection: SceneEdge = {
      id: 'conn-1',
      source: 'server-1',
      target: 'db-1',
      type: 'tcp-connection',
      color: { r: 1, g: 1, b: 0, a: 0.8 },
      width: 1,
      style: 'solid',
      metadata: { port: 5432, protocol: 'TCP' }
    };

    // Create complete scene
    const scene: SceneFile = {
      version: '0.1.0',
      metadata: {
        name: 'Web Application Infrastructure',
        description: 'A simple web app with database',
        author: 'Test Suite',
        created: new Date().toISOString()
      },
      scene: {
        nodes: [server, database],
        edges: [connection],
        camera: {
          position: { x: 0, y: 5, z: 10 },
          target: { x: 2.5, y: 0, z: 0 },
          fov: 75
        },
        lights: [
          {
            type: 'ambient',
            color: { r: 0.4, g: 0.4, b: 0.4, a: 1 },
            intensity: 0.6
          },
          {
            type: 'directional',
            color: { r: 1, g: 1, b: 1, a: 1 },
            intensity: 1.0,
            position: { x: 10, y: 10, z: 10 },
            direction: { x: -1, y: -1, z: -1 }
          }
        ]
      }
    };

    // Validate the scene
    const validation = validateScene(scene);
    expect(validation.valid).toBe(true);
    expect(validation.errors).toHaveLength(0);

    // Calculate stats
    const stats = calculateSceneStats(scene);
    expect(stats.nodeCount).toBe(2);
    expect(stats.edgeCount).toBe(1);
    expect(stats.bounds).toEqual({
      min: { x: 0, y: 0, z: 0 },
      max: { x: 5, y: 0, z: 0 },
      size: { x: 5, y: 0, z: 0 }
    });
  });

  it('should handle complex hierarchy', () => {
    const parentNode: SceneNode = {
      id: 'cluster-1',
      type: 'cluster',
      name: 'Kubernetes Cluster',
      transform: createTransform(),
      children: ['pod-1', 'pod-2']
    };

    const childNode1: SceneNode = {
      id: 'pod-1',
      type: 'pod',
      name: 'Frontend Pod',
      transform: createTransform({ x: -2, y: 0, z: 0 }),
      parent: 'cluster-1'
    };

    const childNode2: SceneNode = {
      id: 'pod-2',
      type: 'pod',
      name: 'Backend Pod',
      transform: createTransform({ x: 2, y: 0, z: 0 }),
      parent: 'cluster-1'
    };

    const scene: SceneFile = {
      version: '0.1.0',
      metadata: { name: 'Kubernetes Scene' },
      scene: {
        nodes: [parentNode, childNode1, childNode2],
        edges: []
      }
    };

    const validation = validateScene(scene);
    expect(validation.valid).toBe(true);

    const stats = calculateSceneStats(scene);
    expect(stats.nodeCount).toBe(3);
  });
});

describe('liveOverlayCopy', () => {
  it('is Live · <selected target> when that target is live', () => {
    expect(
      liveOverlayCopy({
        state: 'live',
        targetId: 'in-browser',
        targetLabel: 'in-browser PLC',
      }),
    ).toBe('Live · in-browser PLC');
    expect(
      liveOverlayCopy({
        state: 'live',
        targetId: 'line-1',
        targetLabel: 'line-1',
      }),
    ).toBe('Live · line-1');
  });

  it('keeps stale and disconnected on the same target label', () => {
    expect(
      liveOverlayCopy({
        state: 'stale',
        targetId: 'inbound',
        targetLabel: 'inbound',
      }),
    ).toBe('Stale values · inbound');
    expect(
      liveOverlayCopy({
        state: 'disconnected',
        targetId: 'inbound',
        targetLabel: 'inbound',
      }),
    ).toBe('Disconnected · inbound');
    expect(
      liveOverlayCopy({
        state: 'disconnected',
        targetId: 'in-browser',
        targetLabel: 'in-browser PLC',
      }),
    ).toBe('Disconnected · in-browser PLC');
    expect(
      liveOverlayCopy({
        state: 'disconnected',
        targetId: 'in-browser',
        targetLabel: 'in-browser PLC',
      }),
    ).not.toBe('Live · in-browser PLC');
  });
});
