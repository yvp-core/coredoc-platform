import { describe, it, expect, vi } from 'vitest';
import type { NextFunction, Request, Response } from 'express';
import { versionHeaderMiddleware } from './version-header.middleware.js';

describe('versionHeaderMiddleware', () => {
  it('stamps X-Coredoc-Version and continues the chain', () => {
    const setHeader = vi.fn();
    const next = vi.fn();

    versionHeaderMiddleware('1.2.3')({} as Request, { setHeader } as unknown as Response, next as NextFunction);

    expect(setHeader).toHaveBeenCalledWith('X-Coredoc-Version', '1.2.3');
    expect(next).toHaveBeenCalledOnce();
  });
});
