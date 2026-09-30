import { describe, expect, it } from 'vitest';
import { TOOL_DESCRIPTIONS } from './tool-descriptions.js';
import { SYMBOL_TYPES, TOOL_INPUT_SCHEMAS, TOOL_SCHEMAS } from './tool-schemas.js';

describe('search_symbols canonical schema', () => {
  it('accepts file as a canonical symbol type', () => {
    expect(SYMBOL_TYPES).toContain('file');
    expect(
      TOOL_SCHEMAS.search_symbols.parse({
        query: 'src/server.ts',
        type: 'file',
      }),
    ).toMatchObject({ type: 'file' });
  });

  it('emits file in the MCP JSON schema and advertises file search', () => {
    const typeSchema = TOOL_INPUT_SCHEMAS.search_symbols.properties.type as {
      enum?: string[];
    };

    expect(typeSchema.enum).toContain('file');
    expect(TOOL_DESCRIPTIONS.search_symbols).toMatch(/files/i);
  });

  it('documents multi-word queries as AND-only', () => {
    const querySchema = TOOL_INPUT_SCHEMAS.search_symbols.properties.query as {
      description?: string;
    };

    expect(querySchema.description).toMatch(/Multiple words = AND/i);
    expect(querySchema.description).not.toMatch(/fall(?:s|back)[^.]*(?:to|as) OR/i);
  });
});

/**
 * `describe_repository` resolves a `project:<project-id>` scope through the same
 * generic project-scope path find_dependents/analyze_change_impact document, and
 * answers with that project's repo-list overview. The contract has to SAY so:
 * an agent that cannot see the token in the schema never reaches for it.
 */
describe('describe_repository project scope token', () => {
  it('advertises the project-wide scope token on both the description and the scope param', () => {
    const scopeSchema = TOOL_INPUT_SCHEMAS.describe_repository.properties.scope as {
      description?: string;
    };

    expect(TOOL_DESCRIPTIONS.describe_repository).toContain('project:<project-id>');
    expect(scopeSchema.description).toContain('project:<project-id>');
  });

  it('states that an unresolvable project hard-errors rather than falling back', () => {
    const scopeSchema = TOOL_INPUT_SCHEMAS.describe_repository.properties.scope as {
      description?: string;
    };

    expect(scopeSchema.description).toMatch(/hard-error/i);
    expect(scopeSchema.description).toMatch(/never falls back/i);
  });
});
