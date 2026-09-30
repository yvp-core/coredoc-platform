import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { serverUrl, webOrigins, resolveWebOrigin } from './server-url.js';

const CANONICAL = 'https://coredoc.example.com';
const SECOND = 'https://ai-dashboard.example.com';

describe('web origin allowlist', () => {
  const previous = { server: process.env.SERVER_URL, mcp: process.env.MCP_SERVER_URL, web: process.env.WEB_ORIGINS };

  beforeEach(() => {
    delete process.env.SERVER_URL;
    delete process.env.MCP_SERVER_URL;
    delete process.env.WEB_ORIGINS;
  });

  afterEach(() => {
    for (const [key, value] of [
      ['SERVER_URL', previous.server],
      ['MCP_SERVER_URL', previous.mcp],
      ['WEB_ORIGINS', previous.web],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  describe('webOrigins', () => {
    it('is just the canonical origin when WEB_ORIGINS is unset', () => {
      process.env.MCP_SERVER_URL = CANONICAL;
      expect(webOrigins()).toEqual([CANONICAL]);
    });

    it('puts the canonical origin first and de-duplicates a repeat of it', () => {
      process.env.MCP_SERVER_URL = CANONICAL;
      process.env.WEB_ORIGINS = `${SECOND}, ${CANONICAL}/ ,`;
      expect(webOrigins()).toEqual([CANONICAL, SECOND]);
    });

    it('trims trailing slashes so the callback uri never doubles up', () => {
      process.env.MCP_SERVER_URL = `${CANONICAL}//`;
      expect(webOrigins()).toEqual([CANONICAL]);
    });

    it('throws on a malformed entry instead of silently dropping a host', () => {
      process.env.MCP_SERVER_URL = CANONICAL;
      process.env.WEB_ORIGINS = 'ai-dashboard.example.com';
      expect(() => webOrigins()).toThrow(/WEB_ORIGINS/);
    });

    it('rejects a non-http(s) scheme', () => {
      process.env.MCP_SERVER_URL = CANONICAL;
      process.env.WEB_ORIGINS = 'javascript:alert(1)';
      expect(() => webOrigins()).toThrow(/http\(s\)/);
    });
  });

  describe('resolveWebOrigin', () => {
    beforeEach(() => {
      process.env.MCP_SERVER_URL = CANONICAL;
      process.env.WEB_ORIGINS = SECOND;
    });

    it('matches an allowlisted Host, case-insensitively', () => {
      expect(resolveWebOrigin('ai-dashboard.example.com')).toBe(SECOND);
      expect(resolveWebOrigin('AI-Dashboard.Example.COM')).toBe(SECOND);
      expect(resolveWebOrigin('coredoc.example.com')).toBe(CANONICAL);
    });

    it('falls back to the canonical origin for an unknown or spoofed Host', () => {
      expect(resolveWebOrigin('evil.example.com')).toBe(CANONICAL);
      expect(resolveWebOrigin('ai-dashboard.example.com.evil.com')).toBe(CANONICAL);
      expect(resolveWebOrigin('evil.com:443')).toBe(CANONICAL);
      expect(resolveWebOrigin(undefined)).toBe(CANONICAL);
      expect(resolveWebOrigin('')).toBe(CANONICAL);
    });

    it('never returns the Host header itself — only a configured origin', () => {
      process.env.WEB_ORIGINS = '';
      expect(webOrigins()).toContain(resolveWebOrigin('evil.com'));
    });

    it('matches on host including port, so a dev port cannot be swapped', () => {
      process.env.MCP_SERVER_URL = 'http://localhost:3000';
      process.env.WEB_ORIGINS = '';
      expect(resolveWebOrigin('localhost:3000')).toBe('http://localhost:3000');
      expect(resolveWebOrigin('localhost:4000')).toBe('http://localhost:3000');
    });

    it('tracks serverUrl when only SERVER_URL is set', () => {
      delete process.env.MCP_SERVER_URL;
      process.env.SERVER_URL = CANONICAL;
      expect(serverUrl()).toBe(CANONICAL);
      expect(resolveWebOrigin('coredoc.example.com')).toBe(CANONICAL);
    });
  });
});
