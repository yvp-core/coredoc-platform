/**
 * MCP OAuth Discovery Controller
 *
 * Serves the per-workspace Protected Resource Metadata (.well-known) that
 * points MCP clients at our self-hosted authorization server. The Authorization
 * Server Metadata (.well-known/oauth-authorization-server) is served by the
 * @rekog/mcp-nest McpAuthModule itself, so this controller only owns the
 * protected-resource document (McpAuthModule's copy is disabled in OAuthModule).
 */

import { Controller, Get } from '@nestjs/common';
import { serverUrl, mcpResourceIdentifier } from '../auth/oauth/server-url.js';

@Controller('.well-known')
export class McpDiscoveryController {
  /**
   * Protected Resource Metadata (RFC 9728)
   * Tells MCP clients where to find the authorization server (our own server).
   *
   * `resource` is the audience the AS actually mints into access tokens, not
   * the bare server URL — see mcpResourceIdentifier().
   */
  @Get('oauth-protected-resource')
  getProtectedResourceMetadata() {
    return {
      resource: mcpResourceIdentifier(),
      authorization_servers: [serverUrl()],
      bearer_methods_supported: ['header'],
    };
  }
}
