import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import assert from "node:assert/strict";
import { sourceQuery } from "./rehearsal.mjs";
import { writeFile } from "node:fs/promises";
const client = new Client({ name: "rehearsal-acceptance", version: "1.0.0" });
await client.connect(
  new StreamableHTTPClientTransport(new URL("http://127.0.0.1:3002/mcp")),
);
const records = [];
const fingerprint = () =>
  sourceQuery(
    "SELECT json_build_object('rows',count(*),'nulls',count(*) FILTER(WHERE legacy_customer_reference IS NULL),'description_exists',EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='app' AND table_name='projects' AND column_name='description')) FROM app.organizations;",
  );
const baseline = await fingerprint();
assert.equal(JSON.parse(baseline).rows, 200);
assert.equal(JSON.parse(baseline).nulls, 147);
async function call(name, args) {
  const value = await client.callTool({ name, arguments: args });
  assert(!value.isError, JSON.stringify(value));
  return JSON.parse(value.content[0].text);
}
try {
  assert.deepEqual((await client.listTools()).tools.map((t) => t.name).sort(), [
    "get_rehearsal_report",
    "rehearse_migration",
  ]);
  await assert.rejects(
    client.callTool({
      name: "rehearse_migration",
      arguments: { sourceId: "other_database", proposedSql: "SELECT 1" },
    }),
    /Invalid literal/,
  );
  const origin = await fetch("http://127.0.0.1:3002/mcp", {
    method: "POST",
    headers: {
      Origin: "https://example.com",
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  assert.equal(origin.status, 403);
  for (const [name, proposedSql, checks, expected] of [
    [
      "known-blocker",
      "ALTER TABLE app.organizations ALTER COLUMN legacy_customer_reference SET NOT NULL;",
      [],
      "FAILED",
    ],
    [
      "nullable-add",
      "ALTER TABLE app.projects ADD COLUMN description text;",
      [
        {
          name: "column exists",
          sql: "SELECT count(*)::integer AS columns FROM information_schema.columns WHERE table_schema='app' AND table_name='projects' AND column_name='description'",
          expectedRows: [{ columns: 1 }],
        },
      ],
      "SUCCEEDED",
    ],
  ]) {
    const job = await call("rehearse_migration", {
      sourceId: "migration_flight_recorder",
      proposedSql,
      checks,
    });
    assert.equal(job.status, "RUNNING");
    const busy = await call("rehearse_migration", {
      sourceId: "migration_flight_recorder",
      proposedSql: "SELECT 1",
    });
    assert.equal(busy.status, "BUSY");
    let result;
    const deadline = Date.now() + 660000;
    do {
      assert(Date.now() < deadline);
      result = await call("get_rehearsal_report", { jobId: job.jobId });
    } while (result.status === "RUNNING");
    assert.equal(result.status, "COMPLETED");
    assert.equal(result.report.execution.status, expected);
    if (name === "known-blocker")
      assert.equal(result.report.execution.error.sqlstate, "23502");
    assert.equal(result.report.targetExecution, "NOT_AVAILABLE");
    assert.equal(result.report.cleanup, "REMOVED_EPHEMERAL_RESOURCES");
    if (checks.length)
      assert.equal(result.report.verification.status, "PASSED");
    assert.equal(await fingerprint(), baseline);
    records.push({ name, jobId: job.jobId, report: result.report });
    console.log(
      `PASS ${name}: ${result.report.execution.status}; source unchanged`,
    );
  }
  await writeFile(
    "artifacts/rehearsal-mcp-acceptance.json",
    JSON.stringify({ baseline, records }, null, 2),
    { mode: 0o600 },
  );
} finally {
  await client.close();
}
