import { Server } from 'node:http';
import path from 'node:path';

const dataDir = process.argv[2];
if (!dataDir || !path.isAbsolute(dataDir)) throw new Error('Supply the absolute path of the temporary fixture data directory.');
Object.assign(process.env, {
  PORT: '0',
  DATA_DIR: dataDir,
  ORIGIN: 'http://127.0.0.1',
  RP_ID: 'localhost',
  INVITE_ONLY: '0',
  PASSWORD_LOGIN: '1',
  COACH_DISABLED: '1',
  COACH_CREDENTIAL_DIR: path.join(dataDir, 'coach-auth'),
  INTEGRATIONS: '',
  MEDIA_UPLOADS: '0',
});

const listen = Server.prototype.listen;
// The upstream entry point takes a port only. Bind this test process to loopback.
Server.prototype.listen = function (port, callback) {
  // ADB reverse removal blocks new connections. Close each response so the
  // mobile client cannot reuse an existing connection during the offline step.
  this.prependListener('request', (_request, response) => response.setHeader('Connection', 'close'));
  return listen.call(this, port, '127.0.0.1', callback);
};
setTimeout(() => process.exit(1), 10 * 60_000).unref();
await import('../../api/server.js');
