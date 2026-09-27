/*
 * Manual end-to-end check for the integrations phase.
 *
 * Requires the dev stack: `npm run infra:up` + `npm run dev:all`, then
 * `npx tsx scripts/e2e.ts`. It exercises the real HTTP surface and the
 * real queue; every check prints PASS/FAIL and a non-zero exit code
 * means something broke.
 *
 * Auth: every workspace route requires a session, so the script signs
 * in first. Point `KLYZ_E2E_EMAIL` / `KLYZ_E2E_PASSWORD` at an account
 * that already lives in the workspace holding the demo workflows; with
 * nothing set it registers a throwaway account instead. Credentials the
 * demos run with are saved, used, and removed again — and the demo
 * drafts this script edits are restored before it exits, so a run never
 * leaves a dangling credential reference behind.
 */
import { getWorkflow } from "../src/lib/demo/workflows";

const BASE = "http://localhost:3000";
const results: string[] = [];
const PASSWORD = process.env.KLYZ_E2E_PASSWORD ?? "e2e-password-123";
let cookie = "";

interface ApiResponse {
  status: number;
  json: Record<string, unknown> | null;
}

interface RunSummary {
  id: string;
  status: string;
  source?: string;
}

interface WorkflowNode {
  id: string;
  type: string;
  data?: { config?: Record<string, unknown> };
}

interface WorkflowView {
  id: string;
  name: string;
  description: string;
  status: string;
  tags: string[];
  revision: number;
  nodes: WorkflowNode[];
  edges: Array<Record<string, unknown>>;
}

function record(label: string, condition: boolean, detail = ""): void {
  results.push(`${condition ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!condition) process.exitCode = 1;
}

function nested(value: Record<string, unknown> | null, ...path: string[]): unknown {
  let current: unknown = value;
  for (const key of path) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function defaultHeaders(): Record<string, string> {
  return { "content-type": "application/json", ...(cookie ? { cookie } : {}) };
}

function sessionCookie(response: Response): string {
  const raw = response.headers.get("set-cookie") ?? "";
  return raw.split(";")[0] ?? "";
}

async function bootstrap(): Promise<void> {
  const email = process.env.KLYZ_E2E_EMAIL;
  if (email) {
    const login = await fetch(`${BASE}/api/auth/login`, {
      method: "POST",
      headers: defaultHeaders(),
      body: JSON.stringify({ email, password: PASSWORD }),
    });
    if (login.ok) {
      cookie = sessionCookie(login);
      return;
    }
  }
  const register = await fetch(`${BASE}/api/auth/register`, {
    method: "POST",
    headers: defaultHeaders(),
    body: JSON.stringify({
      email: `e2e-${Date.now()}@example.test`,
      name: "E2E",
      password: PASSWORD,
    }),
  });
  if (!register.ok) {
    throw new Error(
      `Could not start a session (${register.status}). Set KLYZ_E2E_EMAIL and ` +
        `KLYZ_E2E_PASSWORD to an account inside the demo workspace.`,
    );
  }
  cookie = sessionCookie(register);
}

async function api(path: string, init?: RequestInit): Promise<ApiResponse> {
  const response = await fetch(`${BASE}${path}`, {
    ...init,
    headers: defaultHeaders(),
  });
  const json = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  return { status: response.status, json };
}

async function readWorkflow(id: string): Promise<WorkflowView> {
  const { status, json } = await api(`/api/workflows/${id}`);
  if (status !== 200) throw new Error(`read ${id} failed: ${status}`);
  return nested(json, "workflow") as unknown as WorkflowView;
}

/** Save `nodes`/`edges` as this workflow's draft at its current revision. */
async function saveDraft(current: WorkflowView, nodes: WorkflowView["nodes"], edges: WorkflowView["edges"]): Promise<void> {
  const { status, json } = await api(`/api/workflows/${current.id}/draft`, {
    method: "PUT",
    body: JSON.stringify({
      definition: {
        id: current.id,
        name: current.name,
        description: current.description,
        status: current.status,
        tags: current.tags,
        nodes,
        edges,
      },
      revision: current.revision,
    }),
  });
  if (status !== 200) {
    throw new Error(`draft save for ${current.id} failed: ${status} ${JSON.stringify(json)}`);
  }
}

async function waitForRun(workflowId: string, timeoutMs = 30_000): Promise<RunSummary | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { json } = await api(`/api/executions?workflowId=${workflowId}&limit=5`);
    const runs = (nested(json, "executions") ?? []) as RunSummary[];
    const latest = runs.find((run) => run.source !== "seed") ?? null;
    if (latest && ["completed", "failed", "cancelled"].includes(latest.status)) return latest;
    if (Date.now() > deadline) return latest;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
}

/** Drafts this script rewrote, kept so cleanup can put them back. */
const touched: Array<{ id: string; view: WorkflowView }> = [];

async function main() {
  await bootstrap();

  /* 1 — credential CRUD + test -------------------------------- */
  const created = await api("/api/credentials", {
    method: "POST",
    body: JSON.stringify({
      name: "E2E Postgres",
      kind: "postgres",
      fields: {
        connectionString: "postgres://klyz:klyz@127.0.0.1:5432/klyz_integrations",
      },
    }),
  });
  record("create credential", created.status === 201, `status=${created.status}`);
  const credentialId = (nested(created.json, "credential", "id") as string | undefined) ?? "";

  const listed = await api("/api/credentials");
  const listedCred = ((nested(listed.json, "credentials") ?? []) as Array<
    Record<string, unknown>
  >).find((credential) => credential.id === credentialId);
  record("list credentials", listed.status === 200 && !!listedCred);
  record(
    "list never exposes secret fields",
    listedCred !== undefined &&
      !("fields" in listedCred) &&
      !("secretEnc" in listedCred) &&
      !("secret_enc" in listedCred),
    listedCred ? Object.keys(listedCred).join(",") : "missing",
  );

  const tested = await api(`/api/credentials/${credentialId}/test`, { method: "POST" });
  record(
    "test connection",
    tested.status === 200 && nested(tested.json, "result", "ok") === true,
    `${tested.status} ${String(nested(tested.json, "result", "detail") ?? "")}`,
  );

  /* 2 — demo A: webhook → transform → postgres → log ---------- */
  const lead = getWorkflow("wf_lead_capture");
  if (!lead) throw new Error("demo workflow wf_lead_capture missing");
  const leadView = await readWorkflow(lead.id);
  touched.push({ id: lead.id, view: leadView });
  const leadNodes = structuredClone(leadView.nodes);
  const leadPg = leadNodes.find((node) => node.type === "action.postgres");
  if (!leadPg) throw new Error("demo A no longer has a PostgreSQL step");
  leadPg.data ??= { config: {} };
  leadPg.data.config ??= {};
  leadPg.data.config.credential = credentialId;
  await saveDraft(leadView, leadNodes, leadView.edges);

  const leadHook = lead.nodes.find((node) => node.type === "trigger.webhook");
  const publishA = await api(`/api/workflows/${lead.id}/webhook`, {
    method: "PUT",
    body: JSON.stringify({
      config: {
        path: leadHook?.data.config.path,
        method: leadHook?.data.config.method,
        auth: "header",
        secret: "whsec_e2e",
        enabled: true,
      },
    }),
  });
  record("publish webhook A", publishA.status === 200, `status=${publishA.status}`);
  const urlA = (nested(publishA.json, "webhook", "url") as string | undefined) ?? "";
  record("publish returns copyable URL", urlA.includes("/api/webhooks/"), urlA);

  const hookCall = await fetch(`${BASE}/api/webhooks/hooks/leads`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-klyz-webhook-secret": "whsec_e2e",
    },
    body: JSON.stringify({ email: "ada@example.com", source: "e2e" }),
  });
  record("webhook accepted", hookCall.status === 202, `status=${hookCall.status}`);

  const runA = await waitForRun(lead.id);
  record("demo A run completed", runA?.status === "completed", `status=${runA?.status}`);

  const webhookView = (await api(`/api/workflows/${lead.id}/webhook`)).json;
  const deliveryCount = Number(nested(webhookView, "webhook", "deliveryCount") ?? 0);
  const sample = nested(webhookView, "webhook", "sample") as string | null;
  record("delivery bookkeeping", deliveryCount >= 1 && !!sample, `count=${deliveryCount}`);

  /* 3 — demo C: manual → postgres read → aggregate → log ------ */
  const report = getWorkflow("wf_daily_lead_report");
  if (!report) throw new Error("demo workflow wf_daily_lead_report missing");
  const reportView = await readWorkflow(report.id);
  touched.push({ id: report.id, view: reportView });
  const reportNodes = structuredClone(reportView.nodes);
  const reportPg = reportNodes.find((node) => node.type === "data.postgres");
  if (!reportPg) throw new Error("demo C no longer has a PostgreSQL step");
  reportPg.data ??= { config: {} };
  reportPg.data.config ??= {};
  reportPg.data.config.credential = credentialId;
  await saveDraft(reportView, reportNodes, reportView.edges);
  const publishC = await api(`/api/workflows/${report.id}/publish`, { method: "POST" });
  record("publish demo C", publishC.status === 201, `status=${publishC.status}`);

  const runC = await api(`/api/workflows/${report.id}/execute`, {
    method: "POST",
    body: JSON.stringify({}),
  });
  record("demo C execute accepted", runC.status === 201, `status=${runC.status}`);
  const finishedC = await waitForRun(report.id);
  record("demo C run completed", finishedC?.status === "completed", `status=${finishedC?.status}`);

  /* 4 — demo B: webhook → HTTP → transform → log -------------- */
  const relay = getWorkflow("wf_partner_relay");
  if (!relay) throw new Error("demo workflow wf_partner_relay missing");
  const relayHook = relay.nodes.find((node) => node.type === "trigger.webhook");
  const publishB = await api(`/api/workflows/${relay.id}/webhook`, {
    method: "PUT",
    body: JSON.stringify({
      config: {
        path: relayHook?.data.config.path,
        method: relayHook?.data.config.method,
        auth: relayHook?.data.config.auth,
        secret: "",
        enabled: true,
      },
    }),
  });
  record("publish webhook B", publishB.status === 200, `status=${publishB.status}`);
  const relayCall = await fetch(`${BASE}/api/webhooks/hooks/partner`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ event: "order.created" }),
  });
  record("webhook B accepted", relayCall.status === 202, `status=${relayCall.status}`);
  const runB = await waitForRun(relay.id, 45_000);
  record("demo B run completed", runB?.status === "completed", `status=${runB?.status}`);

  /* 5 — auth is actually enforced ------------------------------ */
  const badSecret = await fetch(`${BASE}/api/webhooks/hooks/leads`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-klyz-webhook-secret": "wrong" },
    body: JSON.stringify({ email: "x@example.com" }),
  });
  record("wrong secret rejected", badSecret.status === 401, `status=${badSecret.status}`);

  const unauthenticated = await fetch(`${BASE}/api/credentials`, {
    headers: { "content-type": "application/json" },
  });
  record("workspace API needs a session", unauthenticated.status === 401, `status=${unauthenticated.status}`);

  /* cleanup ----------------------------------------------------- */
  await api(`/api/workflows/${relay.id}/webhook`, { method: "DELETE" });
  await api(`/api/workflows/${lead.id}/webhook`, { method: "DELETE" });
  await api(`/api/credentials/${credentialId}`, { method: "DELETE" });

  /* Put the demo drafts back and re-publish, so no workflow keeps
     pointing at the credential this script just removed. */
  let restored = 0;
  for (const entry of touched) {
    try {
      const latest = await readWorkflow(entry.id);
      await saveDraft(latest, entry.view.nodes, entry.view.edges);
      await api(`/api/workflows/${entry.id}/publish`, { method: "POST" });
      restored += 1;
    } catch (error) {
      record(`restore ${entry.id}`, false, String(error));
    }
  }
  record("demo drafts restored", restored === touched.length, `${restored}/${touched.length}`);
  record("cleanup", true);

  console.log(results.join("\n"));
}

main().catch((error) => {
  console.error(results.join("\n"));
  console.error("E2E crashed:", error);
  process.exit(1);
});
