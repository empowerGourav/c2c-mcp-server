import express from 'express';
import { createRuntime, type ServerRuntime } from './runtime.js';

const app = express();
let runtimePromise: Promise<ServerRuntime> | undefined;

function getRuntime(): Promise<ServerRuntime> {
  runtimePromise ??= createRuntime();
  return runtimePromise;
}

app.use((req, res, next) => {
  void getRuntime()
    .then((runtime) => runtime.app(req, res, next))
    .catch((error: unknown) => {
      reportStartupFailure(error);
      next(error);
    });
});

export default app;

if (!process.env.VERCEL) {
  void getRuntime()
    .then((runtime) => {
      const httpServer = runtime.app.listen(runtime.config.http.port, runtime.config.http.host, () => {
        runtime.logger.info('server.started', {
          port: runtime.config.http.port,
          nodeEnv: runtime.config.nodeEnv,
          authMode: runtime.config.auth.mode,
          superAdminEnabled: runtime.config.identity.allowSuperAdmin,
        });
      });

      let stopping = false;
      const shutdown = (signal: string): void => {
        if (stopping) return;
        stopping = true;
        runtime.logger.info('server.stopping', { signal });
        const forceExit = setTimeout(() => process.exit(1), 10_000);
        forceExit.unref();
        httpServer.closeAllConnections();
        httpServer.close(() => {
          void runtime.close().finally(() => {
            clearTimeout(forceExit);
            process.exitCode = 0;
          });
        });
      };
      process.on('SIGTERM', () => shutdown('SIGTERM'));
      process.on('SIGINT', () => shutdown('SIGINT'));
    })
    .catch((error: unknown) => {
      reportStartupFailure(error);
      process.exitCode = 1;
    });
}

function reportStartupFailure(error: unknown): void {
  const description = error instanceof Error ? `${error.name}: ${error.message}` : 'Unknown startup error';
  process.stderr.write(`${JSON.stringify({ level: 'error', event: 'server.start_failed', description })}\n`);
}
