/**
 * Embedding input for a mobile entrypoint.
 *
 * Both switches in `input-builder.ts` are exhaustive over `EntrypointDetails`
 * by convention, not by the type system (each arm casts), so a new entrypoint
 * kind that is missed here silently embeds as "Endpoint Type: mobile" with no
 * address and lands in the index under its raw node id.
 */

import { describe, it, expect } from 'vitest';
import type { Entrypoint, FunctionNode } from '@coredoc/core/types';
import { buildEndpointInput, buildEndpointItems, buildFunctionItems } from './input-builder.js';

const mobileEntrypoint: Entrypoint = {
  id: 'h0:entrypoint:MainActivity',
  versionedId: 'h0:entrypoint:MainActivity@v',
  type: 'mobile',
  handlerId: 'h0:fn:onCreate',
  location: { filePath: 'app/src/main/java/com/example/MainActivity.kt', startLine: 1, endLine: 2 },
  details: {
    type: 'mobile',
    platform: 'android',
    trigger: 'launcher',
    className: 'MainActivity',
  },
};

describe('buildEndpointInput', () => {
  it('describes a mobile entrypoint by platform, trigger and class', () => {
    const text = buildEndpointInput(mobileEntrypoint, undefined, 'summary', new Map());

    expect(text).toContain('Endpoint Type: mobile');
    expect(text).toContain('Platform: android');
    expect(text).toContain('Trigger: launcher');
    expect(text).toContain('Class: MainActivity');
  });
});

describe('buildEndpointItems', () => {
  it('names a mobile entrypoint by its trigger and class, not by its node id', () => {
    const [item] = buildEndpointItems([mobileEntrypoint], [], 'summary', new Map());

    expect(item?.name).toBe('mobile:launcher:MainActivity');
    expect(item?.path).toBe('mobile:launcher:MainActivity');
  });
});

// A node the substrate MINTED from a declaration convention (a Rails `has_many` reader) has no
// source and no summary: its embedding input would be a bare signature, so the paid embedding
// call would place a declaration convention in vector space as if it were a function body.
describe('buildFunctionItems', () => {
  const declared: FunctionNode = {
    id: 'h0:fn:createPost',
    versionedId: 'h0:fn:createPost@v',
    name: 'createPost',
    kind: 'function',
    parameters: [],
    location: { filePath: 'app/models/post.rb', startLine: 10, endLine: 12 },
    sourceCode: 'def create_post; end',
  } as unknown as FunctionNode;

  const reader: FunctionNode = {
    ...declared,
    id: 'h0:fn:posts',
    versionedId: 'h0:fn:posts@v',
    name: 'posts',
    sourceCode: undefined,
    synthesized: 'ruby-association',
  } as unknown as FunctionNode;

  it('embeds a declared function and never a synthesized one', () => {
    const items = buildFunctionItems([declared, reader], 'source', new Map());

    expect(items.map((i) => i.id)).toEqual(['h0:fn:createPost']);
  });
});
