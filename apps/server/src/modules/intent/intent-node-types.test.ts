import { NodeType } from '@coredoc/core';
import { describe, expect, it } from 'vitest';
import {
  INTENT_ANCHOR_NODE_TYPES,
  INTENT_SEED_NODE_ID_KINDS,
  INTENT_SEED_NODE_TYPES,
  nodeIdKindOf,
} from './intent-node-types.js';

describe('intent node-type allowlists', () => {
  it('seeds every anchorable kind that has a node-id spelling, plus Route and Package', () => {
    for (const type of INTENT_ANCHOR_NODE_TYPES) {
      if (type === NodeType.ExternalCall) continue;
      expect(INTENT_SEED_NODE_TYPES).toContain(type);
    }
    expect(INTENT_SEED_NODE_TYPES).toContain(NodeType.Route);
    expect(INTENT_SEED_NODE_TYPES).toContain(NodeType.Package);
    expect(INTENT_SEED_NODE_TYPES).toContain(NodeType.Entrypoint);
  });

  it('keeps external_call anchorable but out of BOTH seed lists, so the two agree', () => {
    // It has a versioned id, so it anchors; it has no node-id spelling, so the
    // enforced allowlist could never admit it. The nominal list used to say
    // otherwise, which is the disagreement this asserts is gone.
    expect(INTENT_ANCHOR_NODE_TYPES).toContain(NodeType.ExternalCall);
    expect(INTENT_SEED_NODE_TYPES).not.toContain(NodeType.ExternalCall);
    expect(INTENT_SEED_NODE_ID_KINDS).not.toContain('external_call');
    expect(INTENT_SEED_NODE_ID_KINDS).not.toContain('ext-call');
  });

  it('excludes from anchors the kinds that carry no versioned id', () => {
    expect(INTENT_ANCHOR_NODE_TYPES).not.toContain(NodeType.Route);
    expect(INTENT_ANCHOR_NODE_TYPES).not.toContain(NodeType.Package);
    expect(INTENT_ANCHOR_NODE_TYPES).not.toContain(NodeType.Repository);
  });

  it('lists the seed allowlist in node-id vocabulary', () => {
    expect(INTENT_SEED_NODE_ID_KINDS).toContain('route');
    expect(INTENT_SEED_NODE_ID_KINDS).toContain('package');
    expect(INTENT_SEED_NODE_ID_KINDS).toContain('state-store');
    expect(INTENT_SEED_NODE_ID_KINDS).toContain('type-alias');
    // A repository is not addressable as a graph node id, and a method has no
    // NodeType of its own — neither is seedable.
    expect(INTENT_SEED_NODE_ID_KINDS).not.toContain('repository');
    expect(INTENT_SEED_NODE_ID_KINDS).not.toContain('method');
  });
});

describe('nodeIdKindOf', () => {
  it('reads the type segment of a stable node id', () => {
    expect(nodeIdKindOf('a1b2c3d4e5f6:route:src/app/routes.ts:GET /orders')).toBe('route');
    expect(nodeIdKindOf('a1b2c3d4e5f6:function:src/pay.ts:charge')).toBe('function');
  });

  it('reports a value that is not a stable node id', () => {
    expect(nodeIdKindOf('not-a-node-id')).toBeNull();
    expect(nodeIdKindOf('a1b2c3d4e5f6:function')).toBeNull();
    expect(nodeIdKindOf('a1b2c3d4e5f6::src/pay.ts:charge')).toBeNull();
  });
});
