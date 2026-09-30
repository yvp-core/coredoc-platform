import { describe, expect, it } from 'vitest';
import type { VizEdge, VizNode } from '@coredoc/core';
import { edgeWidth, toGraphEdge, toGraphNode } from './graph-adapters.js';
import { NODE_TYPE_COLORS } from './viz-style.js';

const node = { id: 'n1', type: 'function', name: 'createBooking', repoName: 'acme-api' } as VizNode;
const edge = (over: Partial<VizEdge>): VizEdge =>
  ({ id: 'e1', sourceId: 'a', targetId: 'b', type: 'CALLS', confidence: 1, createdBy: 'parser', ...over }) as VizEdge;

describe('graph adapters', () => {
  it('maps a node to its caption, type color and selection flag', () => {
    expect(toGraphNode(node, 'n1')).toEqual({
      id: 'n1',
      caption: 'createBooking',
      color: NODE_TYPE_COLORS.function,
      selected: true,
    });
    expect(toGraphNode(node, null).selected).toBe(false);
  });

  it('draws AI edges dashed and translucent, parser edges solid', () => {
    expect(toGraphEdge(edge({ createdBy: 'ai', confidence: 0.5 }))).toMatchObject({
      source: 'a',
      target: 'b',
      caption: 'calls',
      lineStyle: 'dashed',
      opacity: 0.5,
      width: edgeWidth(0.5),
    });
    expect(toGraphEdge(edge({}))).toMatchObject({ lineStyle: 'solid', opacity: 1, width: 4 });
  });

  it('draws a cross-repo bridge solid, opaque and at least 2.5px wide', () => {
    const bridge = toGraphEdge(edge({ type: 'RESOLVES_TO' as VizEdge['type'], createdBy: 'ai', confidence: 0 }), true);
    expect(bridge).toMatchObject({ lineStyle: 'solid', opacity: 1, width: 2.5 });
    expect(bridge.color).not.toBe(toGraphEdge(edge({ createdBy: 'ai', confidence: 0 })).color);
  });

  it('clamps edge width to the 1–4px band', () => {
    expect(edgeWidth(-1)).toBe(1);
    expect(edgeWidth(2)).toBe(4);
  });
});
