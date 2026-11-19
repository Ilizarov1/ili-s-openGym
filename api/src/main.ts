/* Nest entry point.
 *
 * The request hook runs before routing (CORS, OPTIONS, target validation,
 * trailing-slash and HEAD handling), the global body parser stays off, and the
 * boot line is byte-for-byte the one the legacy entry printed so the test
 * harness and the container healthcheck keep working.
 */
import { startApi } from './start-api.js';

async function bootstrap(): Promise<void> {
  const port = +(process.env.PORT || 3000);
  const app = await startApi(port, { shutdownHooks: process.platform !== 'win32' });
  const server = app.getHttpServer();
  const address = server.address();
  const actual = typeof address === 'object' && address ? address.port : port;

  console.log(
    `gym-api on :${actual} (rpID=${process.env.RP_ID || 'localhost'}, origin=${
      process.env.ORIGIN || 'http://localhost:8080'
    })`,
  );
}

bootstrap().catch(err => {
  console.error('api failed to start', err);
  process.exit(1);
});
