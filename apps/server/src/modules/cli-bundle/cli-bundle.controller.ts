import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import { CliBundleService } from './cli-bundle.service.js';

const VERSION_PATTERN = /^(latest|v\d+\.\d+\.\d+(-[\w.]+)?)$/;

// Public on purpose: the bundle is an asset of a public GitHub Release, so a
// token gate here would protect nothing. Clients may still send one.
@Controller('cli')
export class CliBundleController {
  constructor(private readonly cliBundleService: CliBundleService) {}

  @Get('bundle')
  async getBundle(@Query('v') version?: string) {
    const v = version ?? 'latest';
    if (!VERSION_PATTERN.test(v)) {
      throw new BadRequestException(`Invalid version format: ${v}`);
    }
    return this.cliBundleService.getBundleUrl(v);
  }
}
