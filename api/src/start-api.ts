import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { NodeAdapter } from '@nestjs/platform-node';
import type { Server } from 'node:http';
import { AppModule } from './app.module.js';
import { RequestHook } from './common/http/request-hook.js';
import { AllExceptionsFilter } from './common/http/http-exception.filter.js';
import { InFlightInterceptor } from './lifecycle/in-flight.interceptor.js';
import { LifecycleCoordinator } from './lifecycle/lifecycle.coordinator.js';

export async function startApi(port: number, { shutdownHooks = false } = {}) {
  const adapter = new NodeAdapter();
  const app = await NestFactory.create(AppModule, adapter, {
    bodyParser: false,
    // The adapter closes any remaining network connections after the
    // coordinator has drained requests and cancelled overdue work.
    forceCloseConnections: true,
    logger: ['error', 'warn'],
    abortOnError: false,
  });

  const lifecycle = app.get(LifecycleCoordinator);
  app.setGlobalPrefix('api');
  app.useGlobalFilters(new AllExceptionsFilter());
  app.useGlobalInterceptors(new InFlightInterceptor(lifecycle));
  app.get(RequestHook).attach(adapter);

  const server = app.getHttpServer() as Server;
  server.requestTimeout = 30 * 60000;
  server.headersTimeout = 60000;

  try {
    await app.listen(port);
    if (shutdownHooks) app.enableShutdownHooks();
    await lifecycle.startAll();
    return app;
  } catch (error) {
    await app.close();
    throw error;
  }
}
