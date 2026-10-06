<div align="center">
  <img src="public/logo.svg" width="120" alt="KLYZ Logo" />
  
  # KLYZ

  **Visual workflow automation platform. Because your scripts deserved a UI.**
  
  [![Live Demo](https://img.shields.io/badge/Live_Demo-klyz.vercel.app-000000?style=for-the-badge&logo=vercel)](https://klyz.vercel.app/)
  [![Tests](https://img.shields.io/badge/tests-731_passing-success?style=for-the-badge)](#)

</div>

---

## ⚡ What is KLYZ?

KLYZ is a powerful, self-hosted visual workflow automation platform. It gives you a canvas editor, a robust real-time execution engine, and first-party integrations, all backed by a high-performance Redis/BullMQ queue.

I built this because I wanted the power of enterprise automation tools (think Zapier or Make) but with the execution speed, control, and developer experience of a modern Node.js backend. No black boxes, just pure logic execution.

**Core Concept:** `EVENT → PROCESS → LOGIC → ACTION → RESULT`

---

## 🚀 Key Features

* **Visual Canvas Editor:** Build complex workflows intuitively with React Flow.
* **Real-time Execution Engine:** Watch your workflows execute step-by-step with live execution state streaming via SSE.
* **Loop & Conditional Logic:** Full support for `logic.loop` (batched/each) and `logic.filter` conditional branching.
* **AI Builder:** Plain language in, structured workflow plan out. Generated plans are validated against the real node registry before ever reaching your canvas.
* **First-Class Security:** AES-256-GCM credentials encrypted at rest. Decrypted only inside the worker for a single run, and never returned by APIs or logs.

---

## 🔌 Integrations

Native support for modern platforms:
* **HTTP & Webhooks** (Incoming, Outgoing, and signed endpoint verification)
* **PostgreSQL** (Direct SQL execution)
* **GitHub** (Push, PRs, Webhooks)
* **Google Workspace** (Gmail, Google Sheets)
* **Slack** (Messaging & Events API)
* **Notion** (Database & Pages)
* **Data Transforms** (`data.json` parse/stringify, mapping)

---

## 🏗️ Architecture

KLYZ splits the frontend experience from the heavy lifting, ensuring zero blocking:

* **App (UI & API)**: Next.js (App Router) on Node 22. Handles workflow definitions, API triggers, and real-time execution monitoring.
* **Worker Engine**: A dedicated, compiled Node process (`node dist/worker.mjs`) consuming a `workflow-executions` BullMQ queue.
* **Storage**: SQLite (`node:sqlite`, WAL mode) for application configuration and execution persistence. PostgreSQL container is the target database for the Postgres integration.
* **Realtime State**: Redis for PubSub execution events and BullMQ state management.

---

## 💻 Getting Started Locally

Running KLYZ locally is straightforward.

### 1. Environment Setup
Copy the example environment file:
```bash
cp .env.example .env
```
*(Configure `KLYZ_REDIS_URL`, `KLYZ_DATABASE_URL`, and integration keys as needed. Never expose actual secrets.)*

### 2. Start Infrastructure
Start the Redis and PostgreSQL containers via Docker:
```bash
npm run infra:up
```

### 3. Run the Platform
Start both the Next.js app and the queue worker:
```bash
npm install
npm run dev:all
```
Your canvas is now live at `http://localhost:3000`.

---

## 🛠️ Scripts & Commands

| Command | Description |
| :--- | :--- |
| `npm run dev` | Starts Next.js dev server only |
| `npm run dev:all` | Starts app + queue worker together |
| `npm run worker` | Runs the compiled BullMQ worker alone |
| `npm run infra:up` / `down`| Start/stop Redis + PostgreSQL |
| `npm test` | Runs all 731 unit + integration tests (requires `infra:up`) |
| `npm run test:unit` | Unit suites only (in-process memory queue) |
| `npm run lint` / `typecheck` / `build` | eslint, tsc, production build |

---

## ☁️ Deployment

KLYZ is built for modern serverless and containerized deployments (e.g., Vercel + Deplexo/Railway).
* **Web**: Deploy the Next.js application on Vercel or any Node 22 environment.
* **Worker**: Deploy the `Dockerfile.worker` on a continuous container service.
* **Configuration**: Ensure both deployments share the exact same `KLYZ_REDIS_URL` (requires `rediss://` for TLS in production) and application storage mounts/URLs.

---

## 📄 Documentation & Contributing
For more detailed documentation, see:
* [Integrations](docs/integrations.md)
* [AI Builder](docs/ai.md)
* [Security](docs/security.md)

Feel free to open issues or submit pull requests. Ensure all code passes `npm run lint`, `npm run typecheck`, and `npm test` before submitting.

---

## 📝 Attribution & License

KLYZ was originally created by **MUSTAFA**. 

This project is open-source. You are free to fork, clone, modify, and use it in accordance with the project's license. If you reuse or build upon this work, please preserve this attribution to credit the original author.
