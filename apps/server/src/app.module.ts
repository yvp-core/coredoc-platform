import { Module } from '@nestjs/common';
import { ApiAppModule } from './api-app.module.js';
import { WorkerAppModule } from './worker-app.module.js';

export { ApiAppModule } from './api-app.module.js';
export { WorkerAppModule } from './worker-app.module.js';

@Module({ imports: [ApiAppModule, WorkerAppModule] })
export class AppModule {}
