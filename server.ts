import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import express from 'express';
import { initializeDatabase, sqlite } from './src/server/db/index.ts';
import { adminRouter } from './src/server/routes/admin.ts';
import { authRouter } from './src/server/routes/auth.ts';
import { deployRouter } from './src/server/routes/deploy.ts';
import { openAiRouter } from './src/server/routes/v1-openai.ts';
import { webhooksRouter } from './src/server/routes/webhooks.ts';

dotenv.config();

async function startServer() {
  initializeDatabase();

  const app = express();
  const PORT = Number(process.env.PORT || 3000);

  app.use(express.json({ limit: '4mb' }));

  // Healthcheck
  app.get('/api/health', (_req, res) => {
    try {
      sqlite.prepare('SELECT 1').get();
      res.json({ ok: true, service: 'nawah-ai-core', version: '0.1.0' });
    } catch (err) {
      res.status(503).json({
        ok: false,
        service: 'nawah-ai-core',
        version: '0.1.0',
        error: err instanceof Error ? err.message : 'Database unavailable',
      });
    }
  });

  // OpenAI-Compatible API Gateway (/v1/models, /v1/chat/completions)
  app.use('/v1', openAiRouter);

  // Authentication & Setup
  app.use('/api/auth', authRouter);

  // Admin & Department APIs
  app.use('/api/admin', adminRouter);

  // Lightweight Git PR & Slack Webhooks
  app.use('/api/webhooks', webhooksRouter);

  // Docker & Integration Bundle Export
  app.use('/api/deploy', deployRouter);

  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      const indexHtml = path.join(distDir, 'index.html');
      if (fs.existsSync(indexHtml)) {
        res.sendFile(indexHtml);
      } else {
        res.status(404).send('Build output not found. Run npm run build.');
      }
    });
  }

  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`Nawah AI Core listening on http://0.0.0.0:${PORT}`);
  });

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`Received ${signal}, closing Nawah AI Core...`);
    server.close(() => {
      try {
        sqlite.close();
      } catch {
        // ignore close errors during shutdown
      }
      process.exit(0);
    });
    setTimeout(() => {
      try {
        sqlite.close();
      } catch {
        // ignore close errors during forced exit
      }
      process.exit(1);
    }, 5000).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

startServer().catch((err) => {
  console.error('Failed to start Nawah AI Core:', err);
  process.exit(1);
});
