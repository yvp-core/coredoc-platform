/**
 * Meta Module
 *
 * Publishes the server's version handshake at /api/v1/meta. Stateless: the
 * values are module-level constants, so no provider is needed.
 */

import { Module } from '@nestjs/common';
import { MetaController } from './meta.controller.js';

@Module({ controllers: [MetaController] })
export class MetaModule {}
