import { FastMCP } from "fastmcp";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { runRehearsal } from "./rehearsal.mjs";

const directory = fileURLToPath(
  new URL("../artifacts/rehearsal-jobs/", import.meta.url),
);
await mkdir(directory, { recursive: true, mode: 0o700 });
const jobs = new Map();
const port = Number(process.env.MFR_REHEARSAL_PORT ?? 3002);
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw new Error("Invalid MFR_REHEARSAL_PORT");
let active = false;
const json = (value) => ({
  content: [{ type: "text", text: JSON.stringify(value) }],
});
const persist = (job) =>
  writeFile(`${directory}${job.jobId}.json`, JSON.stringify(job), {
    mode: 0o600,
  });
const server = new FastMCP({
  name: "local-docker-rehearsal",
  version: "1.0.0",
  authenticate: async (request) => {
    // Local service only. Reject browser-origin requests and DNS-rebinding hosts.
    if (
      request.headers.origin ||
      ![`127.0.0.1:${port}`, `localhost:${port}`].includes(request.headers.host)
    )
      throw new Response("Local server-to-server access only", { status: 403 });
    return {};
  },
});
server.addTool({
  name: "rehearse_migration",
  description:
    "Request approval-gated local Docker rehearsal of migration_flight_recorder. After an eligible migration-check request, show exact SQL/checks and CALL THIS TOOL to trigger TrueForge native approval; do not ask another conversational yes/no question. The runtime pauses before execution until the human approves. Never changes the source. Returns jobId; fetch get_rehearsal_report until complete. No shell or arbitrary sources. Respect inspection-only requests; blocked/inconclusive proposals need an explicit diagnostic-rehearsal request.",
  parameters: z
    .object({
      sourceId: z.literal("migration_flight_recorder"),
      proposedSql: z.string().min(1).max(1048576),
      executionProfile: z
        .enum(["submitted-transactions", "atomic-reviewed-v1"])
        .default("submitted-transactions"),
      checks: z
        .array(
          z
            .object({
              name: z.string().max(200),
              sql: z.string().min(1).max(20000),
              expectedRows: z.array(z.record(z.unknown())).max(1000),
            })
            .strict(),
        )
        .max(30)
        .default([]),
    })
    .strict(),
  execute: async ({ proposedSql, checks, executionProfile }) => {
    if (active)
      return json({
        status: "BUSY",
        targetExecution: "NOT_AVAILABLE",
        message:
          "One rehearsal is already running; retrieve its report. Do not retry the migration.",
      });
    active = true;
    const job = {
      jobId: randomUUID(),
      status: "RUNNING",
      sourceId: "migration_flight_recorder",
      targetExecution: "NOT_AVAILABLE",
    };
    try {
      await persist(job);
    } catch (error) {
      active = false;
      throw error;
    }
    jobs.set(job.jobId, job);
    void (async () => {
      try {
        const { report } = await runRehearsal({
          proposedSql,
          checks,
          executionProfile,
        });
        // Full schema dumps remain in private reports; retain actionable evidence here.
        const { before, after, ...summary } = report;
        Object.assign(job, {
          status: "COMPLETED",
          report: {
            ...summary,
            baseline: before?.tables,
            afterCounts: after?.tables,
          },
        });
      } catch (error) {
        Object.assign(job, { status: "FAILED", error: error.message });
      } finally {
        active = false;
        await persist(job).catch(() => {
          job.persistenceError = true;
        });
      }
    })();
    return json({
      jobId: job.jobId,
      status: "RUNNING",
      targetExecution: "NOT_AVAILABLE",
    });
  },
});
server.addTool({
  name: "get_rehearsal_report",
  description:
    "Retrieve a rehearsal job report. Waits up to 20 seconds for a running job. COMPLETED means a report exists, not migration success: inspect report.execution and report.verification. Never rerun SQL just because a job is still running.",
  parameters: z.object({ jobId: z.string().uuid() }).strict(),
  execute: async ({ jobId }) => {
    let job = jobs.get(jobId);
    if (job) {
      const deadline = Date.now() + 20000;
      while (job.status === "RUNNING" && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 250));
    } else {
      try {
        job = JSON.parse(await readFile(`${directory}${jobId}.json`, "utf8"));
      } catch {
        return json({ status: "NOT_FOUND", targetExecution: "NOT_AVAILABLE" });
      }
      if (job.status === "RUNNING")
        job = {
          ...job,
          status: "INTERRUPTED",
          message:
            "Server restarted. Operator must inspect private reports and run scoped cleanup; do not automatically retry.",
        };
    }
    return json(job);
  },
});
await server.start({
  transportType: "httpStream",
  httpStream: { host: "127.0.0.1", port, endpoint: "/mcp", stateless: true },
});
console.log(`Local rehearsal MCP: http://127.0.0.1:${port}/mcp`);
