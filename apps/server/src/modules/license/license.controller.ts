import { Controller, Get } from '@nestjs/common';
import type { LicenseState } from './license-state.js';
import { LicenseService } from './license.service.js';

/**
 * Unauthenticated status route, like /health: when writes start failing, the
 * operator diagnosing it may not be able to log in yet.
 *
 * It answers the one question that needs no login — "is this deployment's
 * license gating writes?" — and nothing else. The customer name, expiry date
 * and grace window are commercial details of the installation; on an
 * internet-reachable server this route is readable by anyone, so they are
 * simply omitted rather than gated behind auth that this route deliberately
 * does not have. The signature is never exposed either.
 */
@Controller('license')
export class LicenseController {
  constructor(private readonly license: LicenseService) {}

  @Get()
  getLicense(): { state: LicenseState } {
    return { state: this.license.getStatus().state };
  }
}
