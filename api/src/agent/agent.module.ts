import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { PersistenceModule } from '../common/persistence/persistence.module.js';
import { MediaModule } from '../media/media.module.js';
import { AgentConfigsController } from './agent-configs.controller.js';
import { AgentConfigStore } from './agent-config.store.js';
import { AgentCrypto } from './agent-crypto.js';
import { AgentGateway } from './agent-gateway.js';
import { AgentMedia } from './agent-media.js';
import { AgentMemoriesController } from './agent-memories.controller.js';
import { AgentMemoryStore } from './agent-memory.store.js';
import { AgentProposalAdapter } from './agent-proposal.adapter.js';
import { AgentProposalStore } from './agent-proposal.store.js';
import { AgentProposalsController } from './agent-proposals.controller.js';
import { AgentRunStore } from './agent-run.store.js';
import { AgentRunsController } from './agent-runs.controller.js';
import { AgentService } from './agent.service.js';
import { AgentSessionStore } from './agent-session.store.js';
import { AgentSessionsController } from './agent-sessions.controller.js';
import { AgentStore } from './agent.store.js';
import { CoachGenUIController } from './coach-genui.controller.js';
import { CoachGenUIService } from './coach-genui.service.js';
import { RetrievalModule } from './retrieval/index.js';

@Module({
  imports: [PersistenceModule, AuthModule, MediaModule, RetrievalModule],
  controllers: [
    AgentRunsController,
    AgentConfigsController,
    AgentSessionsController,
    AgentMemoriesController,
    AgentProposalsController,
    CoachGenUIController,
  ],
  providers: [
    AgentStore,
    AgentCrypto,
    AgentConfigStore,
    AgentRunStore,
    AgentSessionStore,
    AgentMemoryStore,
    AgentProposalStore,
    AgentProposalAdapter,
    AgentMedia,
    AgentGateway,
    AgentService,
    CoachGenUIService,
  ],
  exports: [AgentService],
})
export class AgentModule {}
