/* The local admin socket: `node recover.js <name>` asks the running server for
 * a recovery code. Linux only, like the legacy entry; Windows starts nothing.
 */
import { Injectable } from '@nestjs/common';
import type net from 'node:net';
import { nameKey } from '../../password.js';
import { startAdminSocket } from '../../admin-socket.js';
import { AccountStore } from '../common/persistence/account-store.js';
import { RecoveryService } from '../accounts/recovery.service.js';
import { LifecycleCoordinator } from './lifecycle.coordinator.js';

const CLI_REQUEST = { headers: {}, socket: {} } as any;

@Injectable()
export class AdminSocketService {
  private server: net.Server | null = null;
  private readonly connections = new Set<net.Socket>();

  constructor(
    private readonly coordinator: LifecycleCoordinator,
    private readonly accounts: AccountStore,
    private readonly recovery: RecoveryService,
  ) {
    coordinator.register({
      name: 'admin-socket',
      order: 99,
      start: () => this.start(),
      stop: () => this.stop(),
    });
    coordinator.signal.addEventListener('abort', () => {
      for (const connection of this.connections) connection.destroy();
    }, { once: true });
  }

  private start(): void {
    this.server = startAdminSocket({
      handle: async (msg: any) => {
        if (this.coordinator.closing) return { error: 'server is shutting down' };
        if (!msg || msg.cmd !== 'recover') return { error: 'unknown command' };
        const db = this.accounts.db;
        const id = typeof msg.id === 'string' ? msg.id : null;
        const key = nameKey(typeof msg.name === 'string' ? msg.name : '');
        const found = id
          ? db.users.filter(u => u.id === id)
          : key
            ? db.users.filter(u => nameKey(u.name) === key || (u as any).email === key)
            : [];
        const row = (u: any) => ({
          id: u.id,
          name: u.name,
          created: u.created || null,
          admin: this.accounts.isAdmin(u),
          owner: this.accounts.isOwner(u),
        });
        if (!found.length) return { error: id ? 'no profile with that id' : 'no profile with that name' };
        if (found.length > 1) {
          return { error: 'several profiles have that name: pick one with --id', matches: found.map(row) };
        }
        const user = found[0];
        if (user.disabled) {
          return { error: 'that profile is disabled: enable it in the admin dashboard first' };
        }
        const made = this.recovery.issue(CLI_REQUEST, user, null);
        return { ...row(user), code: made.code, expires: made.exp };
      },
    });
    this.server?.on('connection', (connection: net.Socket) => {
      this.connections.add(connection);
      connection.once('close', () => this.connections.delete(connection));
    });
  }

  private stop(): void | Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = null;
    return new Promise(resolve => server.close(() => resolve()));
  }
}
