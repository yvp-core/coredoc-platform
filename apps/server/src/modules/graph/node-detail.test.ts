import { describe, expect, it } from 'vitest';
import { projectNodeDetail } from './node-detail.js';

describe('projectNodeDetail', () => {
  it('projects an http entrypoint (method/path/fullPath/purpose)', () => {
    const d = projectNodeDetail('entrypoint', {
      entrypointType: 'http',
      method: 'GET',
      path: '/u/:id',
      fullPath: '/api/u/:id',
      purpose: 'Fetch a user',
      documentation: 'JSDoc',
    });
    expect(d).toEqual({
      kind: 'entrypoint',
      entrypointType: 'http',
      method: 'GET',
      path: '/u/:id',
      fullPath: '/api/u/:id',
      purpose: 'Fetch a user',
      documentation: 'JSDoc',
    });
  });

  it('projects a function with AI purpose/businessLogic/sideEffects', () => {
    const d = projectNodeDetail('function', {
      purpose: 'Creates a user',
      businessLogic: '- validates email\n- hashes password',
      sideEffects: '[database] inserts a row',
      isAsync: true,
      visibility: 'public',
      complexity: 4,
    });
    expect(d).toMatchObject({
      kind: 'function',
      purpose: 'Creates a user',
      businessLogic: '- validates email\n- hashes password',
      sideEffects: '[database] inserts a row',
      isAsync: true,
      visibility: 'public',
      complexity: 4,
    });
  });

  it('projects inline interface members', () => {
    const d = projectNodeDetail('interface', {
      members: [{ name: 'id', kind: 'property', typeText: 'string', isOptional: false }],
    });
    expect(d).toEqual({
      kind: 'interface',
      members: [{ name: 'id', kind: 'property', typeText: 'string', isOptional: false }],
    });
  });

  it('projects enum members (with and without values)', () => {
    const d = projectNodeDetail('enum', { members: [{ name: 'A', value: 'a' }, { name: 'B' }] });
    expect(d).toEqual({ kind: 'enum', members: [{ name: 'A', value: 'a' }, { name: 'B' }] });
  });

  it('projects entity fields (TypeInfo.text → typeText), relations, and indexes', () => {
    const d = projectNodeDetail('entity', {
      ormType: 'prisma',
      tableName: 'users',
      fields: [{ name: 'id', columnName: 'id', type: { text: 'string' }, isPrimaryKey: true }],
      relations: [{ name: 'posts', type: 'one-to-many', targetEntityName: 'Post' }],
      indexes: [{ name: 'idx_email', columns: ['email'], isUnique: true }],
    });
    expect(d).toMatchObject({
      kind: 'entity',
      ormType: 'prisma',
      tableName: 'users',
      fields: [{ name: 'id', columnName: 'id', typeText: 'string', isPrimaryKey: true }],
      relations: [{ name: 'posts', type: 'one-to-many', targetEntityName: 'Post' }],
      indexes: [{ name: 'idx_email', columns: ['email'], isUnique: true }],
    });
  });

  it('projects a class (properties_ → fields, implements names, constructor params)', () => {
    const d = projectNodeDetail('class', {
      extendsName: 'Base',
      implements: [{ name: 'IFoo', resolvedId: 'x' }],
      properties_: [{ name: 'count', typeText: 'number', visibility: 'private' }],
      constructorParams: [{ name: 'dep', typeText: 'Dep' }],
    });
    expect(d).toMatchObject({
      kind: 'class',
      extendsName: 'Base',
      implements: ['IFoo'],
      fields: [{ name: 'count', typeText: 'number', visibility: 'private' }],
      constructorParams: [{ name: 'dep', typeText: 'Dep' }],
    });
  });

  it('projects external_call protocol/method/path', () => {
    const d = projectNodeDetail('external_call', {
      serviceName: 'stripe',
      protocol: 'http',
      httpMethod: 'POST',
      pathTemplate: '/v1/charges',
    });
    expect(d).toMatchObject({
      kind: 'external_call',
      serviceName: 'stripe',
      protocol: 'http',
      httpMethod: 'POST',
      pathTemplate: '/v1/charges',
    });
  });

  it('projects generic messaging and IPC address fields', () => {
    const d = projectNodeDetail('external_call', {
      serviceName: 'desktop-main',
      protocol: 'ipc',
      messagingSystem: 'electron-ipc',
      messagingDestination: 'config:load',
      messagingDestinationRef: 'Channels.CONFIG_LOAD',
      ipcDirection: 'invoke',
    });
    expect(d).toMatchObject({
      kind: 'external_call',
      protocol: 'ipc',
      messagingSystem: 'electron-ipc',
      messagingDestination: 'config:load',
      messagingDestinationRef: 'Channels.CONFIG_LOAD',
      ipcDirection: 'invoke',
    });
  });

  it('falls back to generic for unmapped kinds', () => {
    expect(projectNodeDetail('package', { documentation: 'a package' })).toEqual({
      kind: 'generic',
      documentation: 'a package',
    });
  });

  it('is total on malformed properties (garbage omitted, never throws)', () => {
    expect(() => projectNodeDetail('function', {})).not.toThrow();
    expect(projectNodeDetail('interface', { members: 'not-an-array' })).toEqual({ kind: 'interface', members: [] });
    expect(projectNodeDetail('entity', {})).toMatchObject({ kind: 'entity', fields: [], relations: [] });
  });
});
