import { BadRequestException, Controller, Get, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../../auth/auth.guard.js';
import { CliBundleService } from './cli-bundle.service.js';

const VERSION_PATTERN = /^(latest|main-[a-f0-9]{7,14}|v\d+\.\d+\.\d+(-[\w.]+)?)$/;

@Controller('cli')
@UseGuards(AuthGuard)
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
