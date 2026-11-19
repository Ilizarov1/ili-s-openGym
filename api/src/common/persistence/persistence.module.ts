import { Module } from '@nestjs/common';
import { RUNTIME_CONFIG, loadRuntimeConfig } from '../../config/runtime-config.js';
import { AccountStore } from './account-store.js';
import { AtomicWriter } from './atomic-write.js';
import { Paths } from './paths.js';
import { StateStore } from './state-store.js';

/* One instance of the account database and the state cache per process. */
@Module({
  providers: [
    { provide: RUNTIME_CONFIG, useFactory: () => loadRuntimeConfig() },
    Paths,
    AtomicWriter,
    AccountStore,
    StateStore,
  ],
  exports: [RUNTIME_CONFIG, Paths, AtomicWriter, AccountStore, StateStore],
})
export class PersistenceModule {}
