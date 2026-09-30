import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { McpDiscoveryController } from './mcp-discovery.controller.js';
import { mcpResourceIdentifier, serverUrl } from '../auth/oauth/server-url.js';

describe('McpDiscoveryController — protected resource metadata (RFC 9728)', () => {
  const previous = process.env['MCP_SERVER_URL'];

  beforeEach(() => {
    process.env['MCP_SERVER_URL'] = 'https://mcp.example.com';
  });

  afterEach(() => {
    if (previous === undefined) {
      delete process.env['MCP_SERVER_URL'];
    } else {
      process.env['MCP_SERVER_URL'] = previous;
    }
  });

  it('advertises the resource identifier the AS actually mints as the token audience', () => {
    const metadata = new McpDiscoveryController().getProtectedResourceMetadata();

    // Exact string, and it must be the BARE ORIGIN: the MCP SDK requires the
    // advertised resource to equal the endpoint URL or its origin, and the
    // workspace endpoints live under /api/v1/... — a path suffix here breaks
    // the client before the auth flow even starts.
    expect(metadata.resource).toBe('https://mcp.example.com');
    expect(metadata.resource).toBe(mcpResourceIdentifier());
  });

  it('points at the authorization server issuer, which is the bare server URL', () => {
    const metadata = new McpDiscoveryController().getProtectedResourceMetadata();

    // Must equal the `issuer` in /.well-known/oauth-authorization-server.
    expect(metadata.authorization_servers).toEqual(['https://mcp.example.com']);
    expect(metadata.authorization_servers).toEqual([serverUrl()]);
  });

  it('tracks SERVER_URL when MCP_SERVER_URL is unset, with no "undefined" leaking in', () => {
    delete process.env['MCP_SERVER_URL'];
    process.env['SERVER_URL'] = 'https://api.coredoc.example';
    try {
      const metadata = new McpDiscoveryController().getProtectedResourceMetadata();

      expect(metadata.resource).toBe('https://api.coredoc.example');
      expect(metadata.authorization_servers).toEqual(['https://api.coredoc.example']);
    } finally {
      delete process.env['SERVER_URL'];
    }
  });

  it('declares header-only bearer methods', () => {
    expect(new McpDiscoveryController().getProtectedResourceMetadata().bearer_methods_supported).toEqual(['header']);
  });

  // Source-level guard, same spirit as the cookie guard in
  // mcp-rewrite.middleware.test.ts. The audience the AS mints and the resource
  // this document advertises drifted apart once; booting OAuthModule here to
  // compare them for real is not an option (McpAuthModule.forRoot runs at
  // import time and needs live upstream credentials), so pin the shared helper
  // at the one call site that can silently diverge again.
  it('source guard: oauth.module.ts derives the AS resource from mcpResourceIdentifier()', () => {
    const modulePath = fileURLToPath(new URL('../auth/oauth/oauth.module.ts', import.meta.url));
    const source = readFileSync(modulePath, 'utf8');

    expect(source).toMatch(/resource:\s*mcpResourceIdentifier\(/);
  });
});
