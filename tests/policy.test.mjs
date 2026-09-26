import test from "node:test";
import assert from "node:assert/strict";
import { parseMigration, assertSourceSize } from "../scripts/rehearsal.mjs";
import { validateAtomic, validateChecks } from "../scripts/target-policy.mjs";
import {
  agentManifest,
  assertApprovalPolicy,
} from "../scripts/agent-config.mjs";

test("PostgreSQL parsing preserves quoted semicolons, Unicode and procedural blocks", async () => {
  const statements = await parseMigration(
    "DO $$ BEGIN PERFORM 'é;'; END $$; SELECT ';' AS value;",
  );
  assert.equal(statements.length, 2);
  assert.match(statements[0].sql, /é;/);
});
test("invalid or oversized source is rejected without sampling", () => {
  for (const bytes of [NaN, -1, 1024 ** 3 + 1])
    assert.throws(() => assertSourceSize(bytes));
  assertSourceSize(1024);
});
test("atomic target profile rejects transaction, role and administrative escape", async () => {
  for (const sql of [
    "BEGIN; SELECT 1; COMMIT;",
    "SET ROLE postgres;",
    "COPY app.projects TO PROGRAM 'id';",
    "DO $$ BEGIN NULL; END $$;",
    "ALTER TABLE mfr_control.executions ADD COLUMN x int;",
    "CREATE INDEX CONCURRENTLY ix ON app.projects(id);",
  ]) {
    await assert.rejects(validateAtomic(sql));
  }
  await validateAtomic("ALTER TABLE app.projects ADD COLUMN url text;");
});
test("target verification requires explicit read-only expected results", async () => {
  await assert.rejects(validateChecks([]));
  await assert.rejects(
    validateChecks([
      { name: "write", sql: "DELETE FROM app.projects", expectedRows: [] },
    ]),
  );
  await validateChecks([
    {
      name: "column count",
      sql: "SELECT count(*) AS n FROM information_schema.columns WHERE table_schema='app' AND table_name='projects' AND column_name='url'",
      expectedRows: [{ n: 1 }],
    },
  ]);
});
test("portable manifest retains native approval boundaries", async () => {
  const manifest = await agentManifest("local/test");
  assertApprovalPolicy(manifest);
  assert.equal(manifest.model.name, "local/test");
  assert.equal(manifest.model.params.parallel_tool_calls, false);
  manifest.mcp_servers.find(
    (c) => c.name === "approved-local-target",
  ).require_approval_for_tools = [];
  assert.throws(() => assertApprovalPolicy(manifest));
});
