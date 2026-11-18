# Nawah AI

**A Collaborative Environment for Engineers and Specialized AI Agents**

An open-source foundation for bringing AI into engineering teams without replacing the people, expertise, and judgment that make those teams valuable.

---

## 1. Vision

AI is becoming an important part of engineering and technical work. However, adopting AI inside an organization is not simply a matter of giving everyone access to a chatbot or deploying a collection of autonomous agents.

Different teams have different responsibilities, tools, workflows, and knowledge. They need AI assistance that understands their working context, respects their boundaries, and integrates with the tools they already use.

Nawah aims to provide a shared environment where engineers and specialized AI agents can work alongside each other.

It provides a common foundation that organizations can deploy and adapt to their own needs, while allowing individual departments to use AI in ways that fit their work.

The objective is not to automate the organization itself. It is to make the people within it more capable.

---

## 2. Philosophy

AI should augment engineering, not replace engineering judgment.

Nawah is built around a simple idea: AI should increase human capability without making human expertise less relevant.

Engineers should remain responsible for understanding problems, exploring ideas, evaluating solutions, and making technical decisions.

AI agents can assist with research, analysis, implementation, documentation, repetitive tasks, and other specialized activities. But their outputs should remain subject to human judgment.

The goal is better engineering work, not simply more AI-generated output.

### Collaboration, not forced autonomy

Nawah does not assume that every AI agent must communicate with every other agent or that all organizational work should be coordinated by a central autonomous system.

Departments have their own responsibilities and workflows. Their engineers should remain in control of how work is coordinated across departmental boundaries.

AI should support collaboration where it is useful, not impose an artificial organizational structure.

### A shared foundation, not a rigid framework

Organizations should not have to rebuild their workflows around a new AI platform.

Nawah provides common infrastructure while allowing departments to configure their own agents, models, and integrations.

It should complement existing engineering tools rather than force organizations to replace them.

### Practicality over complexity

A useful system does not need to be a massive orchestration framework.

Nawah prioritizes a small, understandable, extensible foundation. Complexity should be introduced only when real operational needs justify it.

---

## 3. Core Design Principles

- **Human-centered:** Engineers retain control over decisions and responsibilities.
- **Department-oriented:** Each department can have its own specialized agents and working context.
- **Shared infrastructure:** Departments use one common core instead of maintaining separate AI platforms.
- **Isolation:** Department boundaries and agent permissions are respected.
- **Tool integration:** Connect AI capabilities to existing engineering tools and workflows.
- **Model flexibility:** Avoid unnecessary dependence on a single AI provider.
- **Cost transparency:** Make AI consumption and estimated costs visible to the organization.
- **Incremental adoption:** Start small and expand as actual needs emerge.
- **Open and adaptable:** Keep the foundation accessible for organizations to inspect, extend, and customize.

---

## 4. How Nawah Works

Nawah uses a shared core to provide common infrastructure for an organization's AI-assisted workflows.

Within that environment:

- Each department can have its own specialized AI agents.
- Agents can use configured models, instructions, and permitted tools.
- Departments operate within their assigned boundaries.
- Engineers interact with agents through compatible applications and existing workflows.
- The organization can monitor AI usage and estimated costs across departments.

The shared core handles common infrastructure. It does not require every department to adopt the same workflow or delegate its decisions to a central AI coordinator.

### Conceptual Architecture

```text
Organization
└── Shared Nawah Core
    ├── Department A
    │   └── Specialized Agents
    ├── Department B
    │   └── Specialized Agents
    ├── Department C
    │   └── Specialized Agents
    ├── Model Providers
    ├── Tools and Integrations
    └── Usage and Cost Visibility
```

The architecture is intended to support multiple departments without turning Nawah into a complete enterprise management system.

---

## 5. What Nawah Is Not

Nawah is not intended to be:

- A replacement for engineering expertise or human decision-making.
- A project management or employee management platform.
- A mandatory autonomous multi-agent orchestration system.
- A system that requires every department to share its internal context with every other department.
- A rigid framework that forces organizations to abandon their existing tools.
- A platform that creates unnecessary complexity before real needs appear.

Its purpose is narrower and more practical: provide a common environment for engineers to work with specialized AI assistance.

---

## 6. Current Capabilities

Nawah AI Core is the initial implementation of this vision.

The current foundation includes:

- Department and agent management.
- Role-based access and department-level isolation.
- OpenAI-compatible API endpoints (`/v1/chat/completions`, `/v1/models`).
- Routing to supported AI model providers (OpenAI, Anthropic, Google, Ollama, OpenAI-compatible).
- MCP tool integration.
- SQLite-based persistence.
- Provider credential encryption.
- Usage and estimated cost tracking.
- Deployment packaging and external tool integration support.

The project is being developed incrementally. The vision describes the intended direction, while this section identifies capabilities implemented in the current version.

---

## 7. Getting Started

### Requirements

- **Docker deployment:** Docker Engine 24+ and Docker Compose v2+
- **Local Node.js deployment:** Node.js 22+ and npm

### Quick Start with Docker Compose (Recommended)

1. Configure environment variables (optional; sensible defaults work out of the box):

   ```bash
   cp .env.example .env
   ```

   Edit `.env` if you want to set `NAWAH_MASTER_KEY`, `NAWAH_BOOTSTRAP_ADMIN_KEY`, `PORT`, or `APP_URL`.

2. Build and start Nawah Core:

   ```bash
   docker compose up -d --build
   ```

3. Verify the service is healthy:

   ```bash
   curl http://localhost:3000/api/health
   # {"ok":true,"service":"nawah-ai-core","version":"0.1.0"}
   ```

4. Open `http://localhost:3000` in your browser:
   - If `NAWAH_BOOTSTRAP_ADMIN_KEY` was not set, the **First-Run Setup** screen lets you mint your initial `global_admin` access key (and automatically locks once the first key exists).
   - If `NAWAH_BOOTSTRAP_ADMIN_KEY` was set, sign in with that key.

### Quick Start with Node.js (Bare Metal)

```bash
cp .env.example .env
npm install
npm run build
npm start
```

For local development with Vite middleware:

```bash
npm run dev
```

### Data Persistence & Encryption Master Key

- Nawah stores all state in an embedded SQLite database (`nawah.db`, WAL mode with `busy_timeout=5000`) inside `NAWAH_DATA_DIR` (`./data` locally, `/app/data` in Docker via the `nawah_data` volume).
- Provider API keys and MCP credentials are encrypted at rest using AES-256-GCM:
  - Set `NAWAH_MASTER_KEY` explicitly in `.env` (64-char hex recommended), **or**
  - Leave `NAWAH_MASTER_KEY` blank to let Nawah auto-generate a 256-bit key and persist it in `<NAWAH_DATA_DIR>/.nawah_master_key`.
- Keep the `nawah_data` Docker volume (and `.nawah_master_key` if auto-generated) intact across restarts so existing provider keys remain decryptable and all departments, agents, keys, and usage logs survive container recreation.

### Database Migrations & Upgrading an Existing Installation

Database migrations live in `./drizzle/` and run automatically on startup via Drizzle (`migrate(db, { migrationsFolder })`).

To upgrade an existing Docker deployment without losing data:

```bash
# Optional backup of the SQLite data volume before upgrading
docker compose stop nawah-core
docker compose up -d --build
```

Because `nawah_data` is a named Docker volume mounted at `/app/data`, rebuilding the container preserves `nawah.db` and `.nawah_master_key` and applies any pending SQL migrations automatically on boot.

### Environment Variables

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port exposed by Nawah Core (`host:container` in `docker-compose.yml`). |
| `NODE_ENV` | `production` | Set to `production` to serve static `dist/` assets; `development` enables Vite middleware. |
| `NAWAH_DATA_DIR` | `./data` (`/app/data` in Docker) | Directory containing `nawah.db` and `.nawah_master_key`. |
| `NAWAH_MASTER_KEY` | *(auto-generated)* | Optional 64-char hex AES-256-GCM key for encrypting provider and MCP secrets. |
| `NAWAH_BOOTSTRAP_ADMIN_KEY` | *(empty)* | Optional initial `global_admin` Bearer key minted automatically only when zero keys exist. |
| `NAWAH_BOOTSTRAP_ADMIN_LABEL` | `Platform Admin` | Display label for the bootstrapped `global_admin` key. |
| `APP_URL` | `http://localhost:3000` | Public base URL embedded in generated Continue.dev, Git PR, and Slack integration recipes. |
| `NAWAH_PROVIDER_TIMEOUT_MS` | `60000` | Request timeout (ms) for upstream LLM provider calls. |
| `NAWAH_PROVIDER_TEST_TIMEOUT_MS` | `10000` | Request timeout (ms) for provider connection checks. |

### Using the Exported Deployment Kit (`nawah-deploy-kit.zip`)

Authorized administrators can download `nawah-deploy-kit.zip` from the **Deploy & Integrate** tab (`GET /api/deploy/bundle.zip`). The archive is a self-contained installation package containing:

- `Dockerfile`, `docker-compose.yml`, `.dockerignore`, `.env.example`, `README.md`
- `package.json`, `server.ts`, `index.html`, `vite.config.ts`, `tsconfig.json`, `drizzle.config.ts`
- `src/`, `drizzle/`, and `templates/`
- `integrations/` (`continue-config.yaml`, `git-pr-webhook.mjs`, `slack-adapter.mjs`)

Unzip it on a clean host and run `docker compose up -d --build` (or `npm install && npm run build && npm start`).

---

## 8. Project Direction

Nawah will evolve through practical use rather than attempting to anticipate every possible organizational requirement in advance.

The priority is to establish a reliable foundation, test it with real engineering workflows, identify genuine limitations, and improve the system incrementally.

The measure of success is not how many agents Nawah can create, but how effectively it helps people do better work.

---

## License

Apache-2.0
