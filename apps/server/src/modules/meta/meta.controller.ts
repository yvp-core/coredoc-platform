import { Controller, Get } from '@nestjs/common';
import { MIN_CLIENT_VERSION, SERVER_VERSION } from './server-version.js';

export interface MetaResponse {
  version: string;
  minClientVersion: string;
}

/**
 * Unauthenticated version handshake, same posture as /health: a client must be
 * able to learn "this server is older than you support" before it has a token,
 * and the payload is not sensitive (the version is already in every response
 * header).
 */
@Controller('meta')
export class MetaController {
  @Get()
  getMeta(): MetaResponse {
    return { version: SERVER_VERSION, minClientVersion: MIN_CLIENT_VERSION };
  }
}
