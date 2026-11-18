import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import JSZip from 'jszip';
import { eq, and } from 'drizzle-orm';
import { db } from '../db/index.ts';
import { agents } from '../db/schema.ts';
import { isAgentAuthorized } from '../engine/agent-hydrator.ts';
import { requireAuth, requireRole } from '../middleware/auth.ts';

export const deployRouter = Router();
deployRouter.use(requireAuth);

const REQUIRED_BUNDLE_FILES = [
  'package.json',
  'server.ts',
  'index.html',
  'vite.config.ts',
  'tsconfig.json',
  'drizzle.config.ts',
  'Dockerfile',
  'docker-compose.yml',
  '.dockerignore',
  '.env.example',
  'README.md',
];

const OPTIONAL_LOCKFILES = ['package-lock.json', 'bun.lock'];
const REQUIRED_BUNDLE_DIRS = ['src', 'drizzle', 'templates'];
const SKIPPED_FILENAMES = new Set(['.DS_Store', 'Thumbs.db']);

function readRequiredWorkspaceFile(relPath: string): string {
  const full = path.resolve(process.cwd(), relPath);
  if (!fs.existsSync(full) || !fs.statSync(full).isFile()) {
    throw new Error(`Required deployment file is missing: ${relPath}`);
  }
  const content = fs.readFileSync(full, 'utf8');
  if (content.trim().length === 0) {
    throw new Error(`Required deployment file is empty: ${relPath}`);
  }
  return content;
}

function addDirectoryToZip(zip: JSZip, relDir: string): number {
  const rootDir = path.resolve(process.cwd(), relDir);
  if (!fs.existsSync(rootDir) || !fs.statSync(rootDir).isDirectory()) {
    throw new Error(`Required deployment directory is missing: ${relDir}`);
  }

  let fileCount = 0;
  const walk = (absDir: string, zipPrefix: string) => {
    for (const entry of fs.readdirSync(absDir, { withFileTypes: true })) {
      if (SKIPPED_FILENAMES.has(entry.name)) continue;
      const fullPath = path.join(absDir, entry.name);
      const zipPath = `${zipPrefix}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(fullPath, zipPath);
      } else if (entry.isFile()) {
        zip.file(zipPath, fs.readFileSync(fullPath));
        fileCount++;
      }
    }
  };

  walk(rootDir, relDir);
  if (fileCount === 0) {
    throw new Error(`Required deployment directory is empty: ${relDir}`);
  }
  return fileCount;
}

function buildRecipeFiles(
  originUrl: string,
  activeSlugs: string[],
  allowDefaultFallback = true,
) {
  const primarySlug = activeSlugs[0] || 'code-reviewer';
  const modelList =
    activeSlugs.length > 0
      ? activeSlugs
      : allowDefaultFallback
        ? ['code-reviewer', 'db-architect', 'security-reviewer', 'design-reviewer']
        : [];

  const continueConfigYaml = `# Continue.dev (~/.continue/config.yaml)
name: Nawah AI Engineering Workspace
version: 0.1.0
schema: v1

models:
${modelList
  .map(
    (slug) => `  - name: "Nawah · ${slug}"
    provider: openai
    model: "agent/${slug}"
    apiBase: "${originUrl}/v1"
    apiKey: "\${NAWAH_API_KEY}"`,
  )
  .join('\n')}
`;

  const gitPrScript = `// Lightweight GitHub / GitLab CI PR Review Adapter
// Usage: NAWAH_URL=${originUrl} NAWAH_API_KEY=nawah_... node git-pr-webhook.mjs

import { execSync } from 'node:child_process';

const baseUrl = (process.env.NAWAH_URL || '${originUrl}').replace(/\\/+$/, '');
const apiKey = process.env.NAWAH_API_KEY;
if (!apiKey) {
  console.error('Missing NAWAH_API_KEY');
  process.exit(1);
}

const diff = execSync('git diff origin/main...HEAD', { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 });

const response = await fetch(\`\${baseUrl}/api/webhooks/git-pr\`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Authorization: \`Bearer \${apiKey}\`,
  },
  body: JSON.stringify({
    agentSlug: process.env.NAWAH_AGENT || '${primarySlug}',
    repository: process.env.GITHUB_REPOSITORY || 'org/repo',
    prNumber: process.env.PR_NUMBER || 'local',
    title: process.env.PR_TITLE || 'Pull Request Review',
    diff,
  }),
});

const result = await response.json();
if (!response.ok) {
  console.error('Review failed:', result);
  process.exit(1);
}
console.log(result.reviewMarkdown);
`;

  const slackAdapterScript = `// Lightweight Slack Slash Command Forwarder
// Routes Slack slash command payloads directly to Nawah Core (/api/webhooks/slack)

import express from 'express';

const app = express();
app.use(express.urlencoded({ extended: true }));

const nawahUrl = (process.env.NAWAH_URL || '${originUrl}').replace(/\\/+$/, '');
const nawahApiKey = process.env.NAWAH_API_KEY;

app.post('/slack/command', async (req, res) => {
  const { text, channel_name, user_name } = req.body;
  const upstream = await fetch(\`\${nawahUrl}/api/webhooks/slack\`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: \`Bearer \${nawahApiKey}\`,
    },
    body: JSON.stringify({
      agentSlug: process.env.NAWAH_AGENT || '${primarySlug}',
      channel: channel_name || '#engineering',
      userName: user_name || 'engineer',
      text: text || '',
    }),
  });
  const data = await upstream.json();
  res.json({
    response_type: 'in_channel',
    text: upstream.ok ? data.text : \`Error: \${data.error?.message || 'Execution failed'}\`,
  });
});

app.listen(process.env.PORT || 4001, () => {
  console.log('Nawah Slack adapter listening');
});
`;

  const dockerfile = readRequiredWorkspaceFile('Dockerfile');
  const dockerCompose = readRequiredWorkspaceFile('docker-compose.yml');
  const dockerignore = readRequiredWorkspaceFile('.dockerignore');
  const envExample = readRequiredWorkspaceFile('.env.example');
  const drizzleConfig = readRequiredWorkspaceFile('drizzle.config.ts');
  const readme = readRequiredWorkspaceFile('README.md');

  return [
    { name: 'Dockerfile', category: 'docker', content: dockerfile },
    { name: 'docker-compose.yml', category: 'docker', content: dockerCompose },
    { name: '.dockerignore', category: 'docker', content: dockerignore },
    { name: '.env.example', category: 'docker', content: envExample },
    { name: 'drizzle.config.ts', category: 'docker', content: drizzleConfig },
    { name: 'README.md', category: 'docker', content: readme },
    { name: 'integrations/continue-config.yaml', category: 'integration', content: continueConfigYaml },
    { name: 'integrations/git-pr-webhook.mjs', category: 'integration', content: gitPrScript },
    { name: 'integrations/slack-adapter.mjs', category: 'integration', content: slackAdapterScript },
  ];
}

function resolveOrigin(req: import('express').Request): string {
  if (process.env.APP_URL) {
    return process.env.APP_URL.replace(/\/+$/, '');
  }
  const proto = (req.headers['x-forwarded-proto'] as string) || req.protocol || 'http';
  const host = req.headers['x-forwarded-host'] || req.get('host') || 'localhost:3000';
  return `${proto}://${host}`;
}

deployRouter.get('/files', (req, res) => {
  const auth = req.auth!;
  try {
    const activeAgents = db
      .select()
      .from(agents)
      .where(and(eq(agents.workspaceId, auth.workspaceId), eq(agents.isActive, true)))
      .all()
      .filter((a) => isAgentAuthorized(auth, a));

    const originUrl = resolveOrigin(req);
    const files = buildRecipeFiles(
      originUrl,
      activeAgents.map((a) => a.slug),
      auth.role !== 'member',
    );

    res.json({
      originUrl,
      files:
        auth.role === 'member'
          ? files.filter((f) => f.category === 'integration')
          : files,
    });
  } catch (err) {
    res.status(500).json({
      error: {
        code: 'deploy_files_unavailable',
        message: err instanceof Error ? err.message : 'Failed to load deployment files',
      },
    });
  }
});

deployRouter.get(
  '/bundle.zip',
  requireRole('global_admin', 'department_admin'),
  async (req, res) => {
    const auth = req.auth!;
    try {
      const activeAgents = db
        .select()
        .from(agents)
        .where(and(eq(agents.workspaceId, auth.workspaceId), eq(agents.isActive, true)))
        .all()
        .filter((a) => isAgentAuthorized(auth, a));

      const originUrl = resolveOrigin(req);
      const recipeFiles = buildRecipeFiles(
        originUrl,
        activeAgents.map((a) => a.slug),
      );

      const zip = new JSZip();

      // Include generated integration scripts & Docker recipe files
      for (const file of recipeFiles) {
        zip.file(file.name, file.content);
      }

      // Include all required application root files needed to build/run independently
      for (const relFile of REQUIRED_BUNDLE_FILES) {
        zip.file(relFile, readRequiredWorkspaceFile(relFile));
      }

      // Include lockfiles if present
      for (const lockFile of OPTIONAL_LOCKFILES) {
        const full = path.resolve(process.cwd(), lockFile);
        if (fs.existsSync(full) && fs.statSync(full).isFile()) {
          const buf = fs.readFileSync(full);
          if (buf.length > 0) {
            zip.file(lockFile, buf);
          }
        }
      }

      // Include complete source, Drizzle SQL migrations, and starter YAML agent templates
      for (const dirName of REQUIRED_BUNDLE_DIRS) {
        addDirectoryToZip(zip, dirName);
      }
      readRequiredWorkspaceFile('drizzle/meta/_journal.json');

      const buffer = await zip.generateAsync({ type: 'nodebuffer' });
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', 'attachment; filename="nawah-deploy-kit.zip"');
      res.send(buffer);
    } catch (err) {
      res.status(500).json({
        error: {
          code: 'deploy_bundle_incomplete',
          message:
            err instanceof Error
              ? err.message
              : 'Failed to package complete deployment bundle',
        },
      });
    }
  },
);
