/* Thin wrapper over api/durable.js: every write of db.json or a state file goes
 * through here so a host reset cannot resurrect the file it replaced. */
import { Injectable } from '@nestjs/common';
import { atomicWrite as durableWrite } from '../../../durable.js';

@Injectable()
export class AtomicWriter {
  write(file: string, content: string, mode?: number): void {
    durableWrite(file, content, mode);
  }
}
