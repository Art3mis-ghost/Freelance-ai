import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { CONFIG, ensureDirectories } from './src/server/config.ts';
import { closeDatabase, initDatabase } from './src/server/db/database.ts';
import { createApiRouter } from './src/server/routes.ts';
import { startBackgroundSchedulers, stopBackgroundSchedulers } from './src/server/services/taskQueue.ts';

function writeServerPidFile(): void {
  try {
    const payload = JSON.stringify(
      {
        pid: process.pid,
        host: CONFIG.host,
        port: CONFIG.port,
        startedAt: new Date().toISOString(),
        execPath: process.execPath,
      },
      null,
      2,
    );
    fs.writeFileSync(CONFIG.pidFilePath, `${payload}\n`, { encoding: 'utf8', mode: 0o600 });
  } catch {
    // Non-fatal if PID file cannot be written in read-only container
  }
}

function removeOwnPidFile(): void {
  try {
    if (!fs.existsSync(CONFIG.pidFilePath)) return;
    const raw = fs.readFileSync(CONFIG.pidFilePath, 'utf8').trim();
    let recordedPid: number | null = null;
    try {
      const parsed = JSON.parse(raw) as { pid?: number };
      recordedPid = typeof parsed.pid === 'number' ? parsed.pid : null;
    } catch {
      const asNum = Number(raw);
      recordedPid = Number.isFinite(asNum) ? asNum : null;
    }
    if (recordedPid === process.pid) {
      fs.unlinkSync(CONFIG.pidFilePath);
    }
  } catch {
    // Ignore cleanup errors
  }
}

export async function createServerApp(options: { dbPath?: string; startSchedulers?: boolean; attachFrontend?: boolean } = {}) {
  ensureDirectories();
  initDatabase(options.dbPath);

  if (options.startSchedulers !== false) {
    startBackgroundSchedulers();
  }

  const app = express();
  app.disable('x-powered-by');
  // Only trust reverse-proxy headers when explicitly configured via TRUST_PROXY=true or Cloud Run runtime
  app.set('trust proxy', CONFIG.trustProxy ? 1 : false);

  app.use(express.json({ limit: '5mb' }));
  app.use(express.urlencoded({ extended: true, limit: '5mb' }));

  // Mount REST API
  app.use('/api', createApiRouter());

  // Structured API error handler (never expose stack traces or secrets)
  app.use('/api', (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const message = err instanceof Error ? err.message : 'Internal server error';
    res.status(500).json({ error: message, code: 'INTERNAL_ERROR' });
  });

  if (options.attachFrontend !== false) {
    const distDir = path.resolve(CONFIG.rootDir, 'dist');
    const useProductionStatic = CONFIG.isProduction && fs.existsSync(path.join(distDir, 'index.html'));

    if (useProductionStatic) {
      app.use(express.static(distDir));
      app.get('*', (req, res, next) => {
        if (req.path.startsWith('/api/')) return next();
        res.sendFile(path.join(distDir, 'index.html'));
      });
    } else {
      const { createServer: createViteServer } = await import('vite');
      const vite = await createViteServer({
        server: { middlewareMode: true },
        appType: 'spa',
      });
      app.use(vite.middlewares);
    }
  }

  return app;
}

const isDirectEntry =
  process.argv[1] &&
  (process.argv[1].endsWith('server.ts') || process.argv[1].endsWith('server.js'));

if (isDirectEntry) {
  createServerApp()
    .then((app) => {
      const server = app.listen(CONFIG.port, CONFIG.host, () => {
        writeServerPidFile();
        const displayHost = CONFIG.host === '0.0.0.0' ? 'localhost' : CONFIG.host;
        console.log(`Freelance AI Agent Hub running at http://${displayHost}:${CONFIG.port} (bind: ${CONFIG.host}, PID: ${process.pid})`);
        console.log(`Workspace: ${CONFIG.workspaceDir}`);
        console.log(`Database:  ${CONFIG.dbPath}`);
      });

      let shuttingDown = false;
      const shutdown = () => {
        if (shuttingDown) return;
        shuttingDown = true;
        stopBackgroundSchedulers();
        removeOwnPidFile();
        server.close(() => {
          closeDatabase();
          process.exit(0);
        });
        // Force exit fallback after 5s if keep-alive sockets linger
        setTimeout(() => {
          closeDatabase();
          process.exit(0);
        }, 5000).unref();
      };

      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
      process.on('exit', removeOwnPidFile);
    })
    .catch((err) => {
      console.error('Failed to start Freelance AI Agent Hub:', err);
      process.exit(1);
    });
}
