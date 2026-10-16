import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module.js';
import { GithubRepositoryResolver } from '../../libs/github/github-repository-resolver.service.js';
import { WorkspaceMcpContextService } from '../../mcp/workspace-mcp-context.service.js';
import { IntentReleaseModule } from './intent-release.module.js';
import { IntentHandoffService } from './intent-handoff.service.js';
import { IntentHandoffGithubService } from './intent-handoff-github.service.js';
import { IntentHandoffAnchorsService } from './intent-handoff-anchors.service.js';
import { IntentHandoffProcessor } from './intent-handoff-processor.service.js';

@Module({
  imports: [DatabaseModule, IntentReleaseModule],
  providers: [
    IntentHandoffService,
    IntentHandoffGithubService,
    GithubRepositoryResolver,
    IntentHandoffAnchorsService,
    IntentHandoffProcessor,
    WorkspaceMcpContextService,
  ],
  exports: [IntentHandoffService, IntentHandoffProcessor],
})
export class IntentHandoffModule {}
