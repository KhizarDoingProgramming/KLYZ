# KLYZ

Visual workflow automation platform — a canvas editor, a real execution
engine, and first-party integrations (HTTP, PostgreSQL, Webhooks, data
transforms, GitHub, Gmail, Google Sheets, Notion, Slack) running on a
Redis/BullMQ queue.

## Quick start

```bash
npm install
npm run infra:up     # Redis + PostgreSQL in Docker
npm run dev:all      # Next.js app + worker on http://localhost:3000
```

Open the app, pick a demo workflow, and run it. The three runnable demos
(Lead Capture, Partner Event Relay, Daily Lead Report) are described in
[docs/integrations.md](docs/integrations.md); three more (Urgent Issue
Alert, Weekly Tracking Issue, Push to Inbox) drive GitHub and Gmail and
need an OAuth connection first, and the remaining demos route through
Slack, Notion and Google Sheets the same way.

## Scripts

| Script | What it does |
| --- | --- |
| `npm run dev` | Next.js dev server only |
| `npm run dev:all` | app + queue worker together |
| `npm run worker` | run the BullMQ worker alone |
| `npm run infra:up` / `infra:down` | start/stop Redis + PostgreSQL |
| `npm test` | unit + integration suites (`*.infra.test.ts` need `infra:up`) |
| `npm run test:unit` | unit suites only (in-process memory queue) |
| `npm run lint` / `typecheck` / `build` | eslint, tsc, production build |

## Architecture

* **App** — Next.js (App Router) on Node 22. Workflow definitions are
  edited in the browser and POSTed to the API when a run starts; runs,
  steps and events are persisted server-side.
* **Worker** — `tsx src/worker/index.ts` consumes the `workflow-executions`
  BullMQ queue, executes nodes (engine + integration handlers) and streams
  events back through Redis.
* **Storage** — SQLite via `node:sqlite` (`.klyz/klyz.db`, WAL) for this
  phase; Redis for queue state; the PostgreSQL container is the target
  database for the PostgreSQL integration (not the app's own store yet).
* **Credentials** — AES-256-GCM encrypted at rest, decrypted only inside
  the worker for one node run, never returned by APIs or logs.
* **Providers** — GitHub, Gmail, Google Sheets, Notion and Slack connect
  through OAuth (`/api/providers/…`); their events arrive on signed
  endpoints (`/api/providers/github/hooks/…`, Gmail push with OIDC
  verification, Slack Events API with `x-slack-signature`) and are
  deduplicated per workflow before a run starts.

* **AI builder** — plain language in, a structured workflow plan out
  (`/ai`). The plan is validated against the real node registry, reviewed
  in the UI, and only written to the editor when you apply it; publishing
  and running stay manual. Provider-agnostic (any OpenAI-compatible
  endpoint via `KLYZ_AI_*`), and no prompt, key or payload is logged.

## Run control

Three nodes decide whether, and how often, the steps after them run.

### Loop — `logic.loop`

`over` is the list to walk. **Each item** runs one pass per element;
**Batched** runs one pass per `batchSize` elements (default 25). The unit
changes, the outputs do not — they always describe *passes*:

| Output | Semantics |
| --- | --- |
| `results` | One entry per **completed** pass: the last body-step output from that pass. |
| `count` | Number of **completed** passes — equal to `results.length`, never the raw list length. |

Inside the body the loop's ref exposes `item`, `index`, `count` and the
growing `results` (`{{loop.item}}`). Nested loops key their iterations
with dots (`0.1`, `1.0`), and every body step is recorded once per pass
with a `pass N` chip next to its attempt in the timeline.

* **`maxItems`** — a list longer than *Max items* (default 100, hard cap
  5000) fails the step with `LOOP_TOO_LARGE` rather than looping
  indefinitely.
* **Body failure** — one failing body step fails the loop itself: the
  step settles `failed`, publishes no `results`, and the run stops. The
  iterations that did run stay visible as completed steps.
* **Stop inside the body** — a Filter set to *Stop the workflow* ends the
  run successfully with the `results` collected so far.

### Filter — `logic.filter`

`expression` is evaluated against the run scope. When it is not truthy,
`onSkip` decides what happens: **Mark step as skipped** (default) records
the step as `skipped` and leaves every outgoing edge untaken — the branch
silently ends, with no failure; **Stop the workflow** ends the run
successfully right there. `output.passed` reports the decision either way.

### JSON — `data.json`

`mode: parse` turns a string into an object, `mode: stringify` turns any
value into text. Both fail with `CONFIG_INVALID` instead of guessing:
non-text input to *parse*, unserialisable values (for example circular
references) to *stringify*. The result is `output.value`.

### Manual run payloads

The editor's **Run input** box (Run tab) takes a JSON **object**, which
is sent as the run's `input` and read by every node as `trigger.payload`
(`{{trigger.payload.items}}`). Invalid JSON, or anything that is not an
object, is refused before the draft is saved or a run is queued. An empty
box means an empty payload. The default is `{"items": ["alpha", "beta",
"gamma"]}`, so a Loop pointed at `{{trigger.payload.items}}` runs on the
first try.

AI steps (`extract`, `summarize`, `classify`, `generate`) are ordinary
nodes with their own provider configuration — see
[docs/ai.md](docs/ai.md).

Configuration lives in `.env.example` — copy it to `.env` and adjust.
Documentation: [docs/integrations.md](docs/integrations.md),
[docs/ai.md](docs/ai.md), [docs/security.md](docs/security.md).
