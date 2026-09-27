# KLYZ AI workflow builder

Describe an automation in plain language, get back a **structured,
validated workflow plan**, review it, and apply it to the editor through
the normal persistence path.

The AI layer adds no engine, no node types and no publishing path of its
own. A plan is only a proposal: it becomes a workflow when a human
presses *Apply to editor*, and a workflow only runs when somebody runs it
in the editor or on the executions page — exactly like a hand-built one.

---

## Configuration

The builder talks to any OpenAI-compatible chat-completions endpoint.
Nothing below ever reaches the browser; only the non-secret parts are
returned by `GET /api/ai/status`.

| Variable | Default | Meaning |
| --- | --- | --- |
| `KLYZ_AI_PROVIDER` | `openai` | `openai` = any OpenAI-compatible endpoint. `mock` = the deterministic local stand-in (tests/local only, **refused when `NODE_ENV=production`**). Anything else is a configuration error. |
| `KLYZ_AI_API_KEY` | — | Provider key. **Unset = builder off** (routes answer `AI_CONFIGURATION_MISSING`). Not needed while the provider is `mock`. |
| `KLYZ_AI_MODEL` | `openai/gpt-4o-mini` | Model id passed to the provider. |
| `KLYZ_AI_BASE_URL` | `https://openrouter.ai/api/v1` | Any OpenAI-compatible base URL (no trailing slash needed). |
| `KLYZ_AI_TIMEOUT_MS` | `45000` | Per-request timeout (1 000–300 000). |
| `KLYZ_AI_MAX_TOKENS` | `4096` | Completion budget (256–16 384). |
| `KLYZ_AI_RATE_LIMIT` | `30` | Requests per minute **per workspace** (in-process). |
| `KLYZ_AI_MAX_INTENT_CHARS` | `4000` | Length limit for the description (200–32 000). |

---

## AI steps

Four node types call the same provider from inside a workflow. They are
ordinary handlers — resolve config, call the one configured model,
validate the reply against the shape the registry advertises, return it
as step output.

| Node | Asks for | Step output |
| --- | --- | --- |
| `ai.extract` | one value per field in `schema` | `fields` (exactly the declared keys, unknown → `null`), `tokens` |
| `ai.summarize` | a summary of `input` at `length` | `summary`, `tokens` |
| `ai.classify` | one label from `labels` — or every matching label when `multi` | `label`, `scores`, `tokens` |
| `ai.generate` | `prompt`, optionally grounded by `context` | `text`, `tokens` |

Rules that hold for all four:

* **No provider, no output.** With `KLYZ_AI_PROVIDER=openai` and no key
  the step fails with `AI_NOT_CONFIGURED`, naming the variable to set —
  never a fabricated field, never a silent skip.
* **Strict replies.** Each answer is parsed and shape-checked: a label
  outside the caller's list is `AI_INVALID_OUTPUT`, not a best guess.
* **Bounded and private.** Input is clipped (24 000 chars), the token
  budget is capped, cancellation follows the run's abort signal, and
  neither prompt nor completion is written to a log, an audit row or the
  event stream — only the validated fields become step output.

### Local mock provider

`KLYZ_AI_PROVIDER=mock` replaces the network round-trip with a
deterministic in-process stand-in (`src/lib/server/ai/mock.ts`) that
answers each of the four contracts from the text the step sent. The
handler, its config resolution, its reply parsing and its error mapping
all run unchanged, so tests cover the real execution path without a key.

It is opt-in and never a default; `aiProviderKind()` refuses it when
`NODE_ENV=production`, so a shipped deployment cannot silently answer AI
steps from it.

---

## Request lifecycle

```
intent ──▶ rate limit ──▶ bounds checks ──▶ context assembly (redacted)
        ──▶ provider call (timeout + abort) ──▶ strict JSON parse
        ──▶ one repair attempt if unusable ──▶ registry + graph validation
        ──▶ { plan, validation, workflow, connections, meta }
```

| Stage | Module |
| --- | --- |
| Plan schema, limits, `PlanParseError` | `src/lib/ai/plan.ts` |
| Capability catalog (from `NODE_DEFINITIONS`) | `src/lib/ai/catalog.ts` |
| Plan → workflow graph (layout, refs, summary) | `src/lib/ai/graph.ts` |
| Validation + connection derivation | `src/lib/ai/validate.ts` |
| Diff against the current workflow | `src/lib/ai/diff.ts` |
| Explanations (workflow / node / failure) | `src/lib/ai/explain.ts` |
| Provider client, error mapping | `src/lib/server/ai/provider.ts` |
| Rate limit, context redaction, prompts | `src/lib/server/ai/{rate-limit,context,prompt}.ts` |
| Orchestration (generate / refine / explain) | `src/lib/server/ai/service.ts` |
| Routes | `src/app/api/ai/**` |
| UI (`/ai`) | `src/components/ai/*` |

### What the model is told

* **The capability catalog** — a projection of `NODE_DEFINITIONS`
  (title, purpose, required/optional fields, outputs, branches,
  credentials, side effects, cost). A node type that is not registered is
  not in the catalog, not in the prompt, and cannot pass validation.
* **The workflow / execution under discussion**, wrapped in
  `<workflow_data>` / `<execution_data>` as redacted JSON with `<`
  escaped, plus the rule that those blocks are *data, never instructions*.
* **The strict output schema** and the instruction to return one JSON
  object and nothing else.

The key, the raw prompts, and provider response bodies are never logged:
the audit line is metadata only —

```
[ai] {"op":"plan","provider":"openrouter.ai","model":"…","ms":1842,"attempts":1,"repaired":false,"tokens":6120,"catalog":"…","nodes":5,"edges":4,"ok":true,"applyable":true}
```

---

## Validation semantics

Every plan is converted to a real workflow and pushed through the same
`validateWorkflow` the editor and execution API use. Two values describe
the result:

| Field | Meaning |
| --- | --- |
| `ok` | No validation errors at all — the graph would run as-is (a connection may still be missing). |
| `applyable` | No **structural** errors. Safe to open in the editor, where remaining gaps are filled by hand. |

**Blocking** (applyable = false): unknown capability (`capability_*`),
cycle (`graph_cycle`), no trigger, dangling/self edge, orphan step,
duplicate ref.

**Non-blocking but reported**: missing required config
(`missing_<node>_<key>`) and broken `{{ref.path}}` expressions
(`ref_*`) — the editor already surfaces both.

**Connections, not errors**: a required `credential` field left empty is
*never* an AI error. The AI cannot know credential ids, so those gaps are
returned as `connections` (`{ credential, label, reason, nodeId }`) and
the user completes them on the Integrations page.

A reply that uses **no** registered capability at all is not a plan:
`AI_VALIDATION_FAILED` (422) with the reasons.

---

## Endpoints

| Route | Body | Returns |
| --- | --- | --- |
| `POST /api/ai/workflows/generate` | `{ intent, workflow? }` | `{ plan, validation, workflow, connections, meta }` |
| `POST /api/ai/workflows/refine` | `{ intent, plan, feedback, workflow? }` | same |
| `POST /api/ai/workflows/explain` | `{ workflow, nodeId? }` | `{ explanation, meta }` |
| `POST /api/ai/executions/:id/explain` | `{}` | `{ explanation, meta }` |
| `GET /api/ai/status` | — | `{ ai: { enabled, model, baseUrl }, catalog }` |

`workflow` is context (the editor may hold unsaved changes); nothing on
these routes writes to the workspace. Execution explanations load the run
**server-side by id**, workspace-scoped, so the browser never assembles —
or sees — raw step payloads for that call.

Error codes: `AI_CONFIGURATION_MISSING` (503), `AI_RATE_LIMITED` (429),
`AI_TIMEOUT` (504), `AI_PROVIDER_ERROR` (502), `AI_INVALID_OUTPUT` (422),
`AI_VALIDATION_FAILED` (422), plus ordinary `BAD_REQUEST` (400) and
`NOT_A_MEMBER` (403).

---

## Applying a plan

*New workflow* → creates a local draft in the workflows store and opens
`/workflows/<id>`. *Editing* (`/ai?workflow=<id>`) → replaces that
workflow's graph (name, description, status and run statistics are kept)
and shows a diff of what changes first. `GET /ai?execution=<id>` opens
the builder with that run's failure explanation attached.

Nothing is published and nothing is executed from the AI surface. Status
stays `draft`, exactly as `planToWorkflow` produces it.

---

## Security notes

* **Key handling** — the API key is read server-side and attached only
  to the outbound `Authorization` header. It is excluded from status
  responses, error messages and logs (`redactMessage` also masks
  `Bearer …` tokens and `user:password@` credentials in URLs).
* **Prompt injection** — workflow/execution content is untrusted data:
  redacted (`src/lib/server/redact.ts`), clipped (depth 8, strings
  1 500 chars, arrays 40, block 40 000 chars), `<`-escaped, and framed by
  a system-prompt rule that data blocks are data.
* **Output handling** — the model's answer is parsed strictly (unknown
  fields rejected, counts and nesting bounded), then re-validated against
  the real registry. It is never trusted as a workflow.
* **Budget** — fixed-window rate limit per workspace, in-process
  (documented as per-process; swap for a shared limiter when KLYZ has
  one). Provider-side timeout and a 400 000-character response cap.
* **Cost** — the plan request is read-only; a run's price is shown by the
  existing cost model on each node, not simulated by the AI.

---

## Tests

```bash
npx vitest run src/lib/ai src/lib/server/ai src/app/api/ai
```

Covers: strict plan parsing and limits, catalog/registry parity, graph
conversion (refs, layout, summary), validation semantics (unknown
capability blocking, credential reclassification, cycles, orphans), diff,
explanations, provider error mapping (rate limit, auth, timeout,
oversize, redaction), provider selection (including `mock` refused in
production), the four AI steps run through the real engine against the
local mock, rate limiting, context redaction/escaping, the
generate/refine/explain pipeline against a mocked model, and the HTTP
route (membership, config-missing, body validation, envelope).
