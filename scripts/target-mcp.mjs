import { FastMCP } from "fastmcp";
import { z } from "zod";
import pg from "pg";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, open, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createTargetEngine } from "./target-engine.mjs";
import { runRehearsal } from "./rehearsal.mjs";
import { digest } from "./target-policy.mjs";
const root = fileURLToPath(new URL("../", import.meta.url));
const port = Number(process.env.MFR_TARGET_PORT ?? 3003);
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw new Error("Invalid MFR_TARGET_PORT");
const directory = root + "artifacts/target-execution/";
await mkdir(directory, { recursive: true, mode: 0o700 });
const tokenFile = root + "sandbox/target-mcp.token";
try {
  const f = await open(tokenFile, "wx", 0o600);
  await f.writeFile(randomBytes(32).toString("hex"));
  await f.close();
} catch (error) {
  if (error.code !== "EEXIST") throw error;
}
const secret = (await readFile(tokenFile, "utf8")).trim();
if (secret.length < 64) throw new Error("Invalid connector token");
async function connect() {
  const file = await readFile(root + "sandbox/target.env", "utf8").catch(
    () => "",
  );
  const uri = file
    .split("\n")
    .find((line) => line.startsWith("TARGET_DATABASE_URL="))
    ?.slice(20)
    .trim();
  if (!uri)
    throw new Error(
      "TARGET_SETUP_REQUIRED: operator must provision mfr_executor and sandbox/target.env; no target writes performed.",
    );
  const u = new URL(uri);
  if (
    !["postgres:", "postgresql:"].includes(u.protocol) ||
    u.hostname !== "127.0.0.1" ||
    u.port !== "54329" ||
    u.pathname !== "/migration_flight_recorder" ||
    u.username !== "mfr_executor" ||
    u.search
  )
    throw new Error("Target URL is not the fixed local deployment identity");
  const client = new pg.Client({
    connectionString: uri,
    connectionTimeoutMillis: 5000,
    query_timeout: 35000,
    application_name: "mfr-approved-target",
  });
  await client.connect();
  return client;
}
const engine = createTargetEngine({
  directory,
  secret,
  connect,
  targetIdentity: {
    targetId: "migration_flight_recorder-local",
    database: "migration_flight_recorder",
    role: "mfr_executor",
  },
  loadRehearsal: async (id) => ({
    report: JSON.parse(
      await readFile(root + `artifacts/rehearsals/${id}/report.json`, "utf8"),
    ),
    sql: await readFile(
      root + `artifacts/rehearsals/${id}/migration.sql`,
      "utf8",
    ),
  }),
  backup: async () => {
    const { report } = await runRehearsal({
      proposedSql: "SELECT 1;",
      backupOnly: true,
    });
    if (
      report.status !== "BACKUP_RESTORE_VERIFIED" ||
      report.cleanup !== "REMOVED_EPHEMERAL_RESOURCES"
    )
      throw new Error(
        `Backup verification failed: ${report.error ?? report.status}`,
      );
    return {
      backupId: report.runId,
      archive: report.backup.archive,
      archiveSha256: report.backup.sha256,
      contentDigest: digest(
        (await readFile(report.backup.archive)).toString("base64"),
      ),
      fingerprint: report.baselineFingerprint,
      restoreVerified: true,
    };
  },
});
const jobs = new Map();
let active = false;
const json = (value) => ({
  content: [{ type: "text", text: JSON.stringify(value) }],
});
const jobFile = (id) => directory + `${id}.job.json`;
async function start(kind, id, work) {
  const existing =
    jobs.get(id) ??
    (await readFile(jobFile(id), "utf8")
      .then(JSON.parse)
      .catch((e) => {
        if (e.code === "ENOENT") return null;
        throw e;
      }));
  if (existing) return json(existing);
  if (active)
    return json({
      status: "BUSY",
      message:
        "One preparation/application is running. Retrieve it; do not resubmit.",
    });
  active = true;
  const job = { executionId: id, kind, status: "RUNNING" };
  jobs.set(id, job);
  try {
    await writeFile(jobFile(id), JSON.stringify(job), { mode: 0o600 });
  } catch (error) {
    active = false;
    jobs.delete(id);
    throw error;
  }
  void (async () => {
    try {
      job.result = await work();
      job.status = "COMPLETED";
    } catch (error) {
      job.status = "FAILED";
      job.error = error.message;
    } finally {
      active = false;
      await writeFile(jobFile(id), JSON.stringify(job), { mode: 0o600 }).catch(
        () => {
          job.persistenceError = true;
        },
      );
    }
  })();
  return json({ ...job });
}
const server = new FastMCP({
  name: "approved-local-target",
  version: "1.0.0",
  authenticate: async (request) => {
    const provided = Buffer.from(request.headers.authorization ?? "");
    const expected = Buffer.from("Bearer " + secret);
    if (
      request.headers.origin ||
      ![`127.0.0.1:${port}`, `localhost:${port}`].includes(
        request.headers.host,
      ) ||
      provided.length !== expected.length ||
      !timingSafeEqual(provided, expected)
    )
      throw new Response("Unauthorized", { status: 401 });
    return {};
  },
});
server.addTool({
  name: "prepare_target_migration",
  description:
    "Requires native approval. Create and restore-test a private backup for an existing successful atomic rehearsal, check target drift, and prepare an immutable 15-minute plan. Does NOT apply migration. Only request after the user asks to prepare/apply to the target. Returns executionId for polling. TARGET_SETUP_REQUIRED means an operator must configure restricted deployment access.",
  parameters: z.object({ rehearsalRunId: z.string().uuid() }).strict(),
  execute: async ({ rehearsalRunId }) =>
    start("prepare", randomUUID(), () => engine.prepare(rehearsalRunId)),
});
server.addTool({
  name: "apply_target_migration",
  description:
    "CHANGES THE REAL LOCAL TARGET DATABASE. Requires separate native approval for an immutable planId. Before calling, show exact SQL, target, backup, fingerprint, affected data and destructive loss warning. Use only planId from verified preparation. Rechecks drift, applies in one transaction with precommit verification. No automatic retry. Returns executionId for polling.",
  parameters: z.object({ planId: z.string().uuid() }).strict(),
  execute: async ({ planId }) =>
    start("apply", planId, () => engine.apply(planId)),
});
server.addTool({
  name: "get_target_execution",
  description:
    "Read preparation/application status; COMPLETED only means a result exists. Inspect result.status. RUNNING jobs wait up to 20 seconds. Unknown outcomes must not be retried.",
  parameters: z.object({ executionId: z.string().uuid() }).strict(),
  execute: async ({ executionId }) => {
    let job = jobs.get(executionId);
    if (job) {
      const end = Date.now() + 20000;
      while (job.status === "RUNNING" && Date.now() < end)
        await new Promise((r) => setTimeout(r, 250));
    } else {
      job = await readFile(jobFile(executionId), "utf8")
        .then(JSON.parse)
        .catch((e) => {
          if (e.code === "ENOENT") return { status: "NOT_FOUND" };
          throw e;
        });
      if (job.status === "RUNNING")
        job =
          job.kind === "apply"
            ? {
                ...job,
                status: "RECONCILIATION",
                result: await engine.get(executionId),
              }
            : {
                ...job,
                status: "INTERRUPTED",
                message: "Preparation interrupted; operator review required.",
              };
    }
    if (job.kind === "apply" && job.result?.status === "OUTCOME_UNKNOWN")
      job = { ...job, result: await engine.get(executionId) };
    return json(job);
  },
});
await server.start({
  transportType: "httpStream",
  httpStream: { host: "127.0.0.1", port, endpoint: "/mcp", stateless: true },
});
console.log(
  `Authenticated target connector listening on 127.0.0.1:${port}. Target writes require separate operator setup and native approval.`,
);
