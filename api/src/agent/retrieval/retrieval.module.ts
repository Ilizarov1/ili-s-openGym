import { Module } from '@nestjs/common';
import { safeRetrievalConfig, type RetrievalConfig } from './config.js';
import { CONFIG_TOKEN, createRetrievalPool, FIXTURE_RETRIEVAL_TOKEN, MODEL_CLIENT_TOKEN, POOL_TOKEN } from './database.js';
import { RetrievalService } from './retrieval.service.js';
import { FixtureRetrievalAdapter } from './fixture-retrieval.js';
import { embedText, rerank } from './models.js';
import type { RerankDocument } from './models.js';

@Module({
  providers: [
    { provide: CONFIG_TOKEN, useFactory: () => safeRetrievalConfig() },
    { provide: POOL_TOKEN, useFactory: () => createRetrievalPool(safeRetrievalConfig()) },
    { provide: MODEL_CLIENT_TOKEN, useFactory: (config: RetrievalConfig) => ({
      embedText: (text: string, signal?: AbortSignal) => embedText(config, text, signal),
      rerank: (query: string, documents: RerankDocument[], signal?: AbortSignal) => rerank(config, query, documents, signal),
    }), inject: [CONFIG_TOKEN] },
    FixtureRetrievalAdapter,
    { provide: FIXTURE_RETRIEVAL_TOKEN, useExisting: FixtureRetrievalAdapter },
    RetrievalService,
  ],
  exports: [RetrievalService],
})
export class RetrievalModule {}
