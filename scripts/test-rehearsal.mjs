import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import {
  runRehearsal,
  parseMigration,
  sourceQuery,
  assertSourceSize,
  restoreArchive,
} from "./rehearsal.mjs";

const results = [];
const check = (name, sql, expectedRows) => ({ name, sql, expectedRows });
async function fingerprint() {
  const tables = JSON.parse(
    await sourceQuery(
      "SELECT json_agg(x ORDER BY s,t) FROM (SELECT n.nspname s,c.relname t FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind='r' AND n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema')x;",
    ),
  );
  const evidence = [];
  for (const { s, t } of tables) {
    const identifier = (value) => '"' + value.replaceAll('"', '""') + '"';
    evidence.push({
      s,
      t,
      fingerprint: await sourceQuery(
        `SELECT count(*)::text || ':' || coalesce(md5(string_agg(digest, '' ORDER BY digest)), '') FROM (SELECT md5(row_to_json(x)::text) digest FROM ${identifier(s)}.${identifier(t)} x) d;`,
      ),
    });
  }
  evidence.push({
    schema: await sourceQuery(
      "SELECT coalesce(json_agg(x ORDER BY s,t,a),'[]') FROM (SELECT n.nspname s,c.relname t,a.attnum a,a.attname,pg_catalog.format_type(a.atttypid,a.atttypmod) type,a.attnotnull FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema' AND a.attnum>0 AND NOT a.attisdropped)x;",
    ),
  });
  return evidence;
}

const original = await fingerprint();
const parsed = await parseMigration(
  "-- Unicode café\nBEGIN; DO $$ BEGIN PERFORM ';'; END $$; SELECT 'é;'; COMMIT;",
);
assert.equal(parsed.length, 4);
assert.match(parsed[1].sql, /PERFORM ';'/);
assert.match(parsed[2].sql, /é;/);
for (const sql of [
  "\\! touch /tmp/escape",
  "SET ROLE postgres;",
  "ALTER SYSTEM SET statement_timeout=0;",
  "COPY app.projects TO PROGRAM 'id';",
  "CREATE ROLE bad SUPERUSER;",
])
  await assert.rejects(parseMigration(sql));
assert.throws(() => assertSourceSize(1024 ** 3 + 1));
assertSourceSize(1024 ** 3);
await assert.rejects(
  restoreArchive(async (args, options) => {
    assert(args.includes("--exit-on-error"));
    assert.equal(options.inputFile, "broken.dump");
    throw new Error("invalid archive");
  }, "broken.dump"),
  /invalid archive/,
);
results.push({
  name: "parser-admin-rejection-size-and-restore-error-boundary",
  passed: true,
  coverage: "unit",
});

const scenarios = [
  {
    name: "nullable-add",
    file: "01_easy_add_project_description.sql",
    checks: [
      check(
        "description exists nullable",
        "SELECT is_nullable FROM information_schema.columns WHERE table_schema='app' AND table_name='projects' AND column_name='description'",
        [{ is_nullable: "YES" }],
      ),
    ],
  },
  {
    name: "billing-backfill",
    file: "02_medium_backfill_billing_email.sql",
    checks: [
      check(
        "emails populated",
        "SELECT count(*)::int AS n FROM billing.customers WHERE billing_email IS NULL",
        [{ n: 0 }],
      ),
    ],
  },
  {
    name: "concurrent-index",
    file: "03_high_add_audit_actor_ip_index.sql",
    checks: [
      check(
        "IP values filled",
        "SELECT count(*)::int AS n FROM audit.events WHERE actor_ip IS NOT NULL",
        [{ n: 25000 }],
      ),
      check(
        "index valid",
        "SELECT indisvalid FROM pg_index WHERE indexrelid='audit.audit_events_actor_ip_idx'::regclass",
        [{ indisvalid: true }],
      ),
    ],
  },
  {
    name: "type-widening",
    file: "04_high_widen_deployment_duration.sql",
    checks: [
      check(
        "duration bigint",
        "SELECT data_type FROM information_schema.columns WHERE table_schema='operations' AND table_name='deployment_runs' AND column_name='duration_ms'",
        [{ data_type: "bigint" }],
      ),
    ],
  },
  {
    name: "destructive-drop",
    file: "05_destructive_drop_legacy_customer_reference.sql",
    checks: [
      check(
        "column absent",
        "SELECT count(*)::int AS n FROM information_schema.columns WHERE table_schema='app' AND table_name='organizations' AND column_name='legacy_customer_reference'",
        [{ n: 0 }],
      ),
    ],
  },
  {
    name: "known-null-blocker",
    sql: "ALTER TABLE app.organizations ALTER COLUMN legacy_customer_reference SET NOT NULL;",
    failure: true,
    checks: [
      check(
        "147 nulls remain",
        "SELECT count(*)::int AS n FROM app.organizations WHERE legacy_customer_reference IS NULL",
        [{ n: 147 }],
      ),
    ],
  },
  {
    name: "ordered-new-column",
    sql: "ALTER TABLE app.organizations ADD COLUMN rehearsal_label text; UPDATE app.organizations SET rehearsal_label='org-' || id::text; ALTER TABLE app.organizations ALTER COLUMN rehearsal_label SET NOT NULL;",
    checks: [
      check(
        "all filled",
        "SELECT count(*)::int AS n FROM app.organizations WHERE rehearsal_label IS NOT NULL",
        [{ n: 200 }],
      ),
    ],
  },
  {
    name: "transaction-rollback",
    sql: "BEGIN; ALTER TABLE app.projects ADD COLUMN rollback_probe text; SELECT 1/0; COMMIT;",
    failure: true,
    checks: [
      check(
        "change rolled back",
        "SELECT count(*)::int AS n FROM information_schema.columns WHERE table_schema='app' AND table_name='projects' AND column_name='rollback_probe'",
        [{ n: 0 }],
      ),
    ],
  },
  {
    name: "committed-partial-failure",
    sql: "ALTER TABLE app.projects ADD COLUMN partial_probe text; SELECT 1/0; ALTER TABLE app.projects ADD COLUMN never_run text;",
    failure: true,
    checks: [
      check(
        "first committed, last absent",
        "SELECT column_name FROM information_schema.columns WHERE table_schema='app' AND table_name='projects' AND column_name IN ('partial_probe','never_run') ORDER BY column_name",
        [{ column_name: "partial_probe" }],
      ),
    ],
  },
  {
    name: "timeout",
    sql: "SELECT pg_sleep(35);",
    failure: true,
    checks: [
      check(
        "rows preserved",
        "SELECT count(*)::int AS n FROM app.organizations",
        [{ n: 200 }],
      ),
    ],
  },
  {
    name: "dynamic-admin-denied",
    sql: "DO $$ BEGIN EXECUTE 'CREATE ROLE escaped SUPERUSER'; END $$;",
    failure: true,
    checks: [
      check(
        "no escaped role",
        "SELECT count(*)::int AS n FROM pg_roles WHERE rolname='escaped'",
        [{ n: 0 }],
      ),
    ],
  },
  {
    name: "file-read-denied",
    sql: "SELECT pg_read_file('/etc/passwd');",
    failure: true,
    checks: [
      check(
        "still non-superuser",
        "SELECT rolsuper FROM pg_roles WHERE rolname=current_user",
        [{ rolsuper: false }],
      ),
    ],
  },
  {
    name: "postcondition-failure",
    sql: "SELECT 1;",
    verificationFailure: true,
    checks: [check("deliberately wrong", "SELECT 1 AS n", [{ n: 2 }])],
  },
];
for (const test of scenarios) {
  console.log(`Rehearsing ${test.name}...`);
  const sql = test.sql ?? (await readFile(`db/scenarios/${test.file}`, "utf8"));
  const result = await runRehearsal({ proposedSql: sql, checks: test.checks });
  const r = result.report;
  assert.equal(
    r.execution.status,
    test.failure ? "FAILED" : "SUCCEEDED",
    `${test.name}: ${r.error ?? r.execution.error?.message}`,
  );
  assert.equal(
    r.verification.status,
    test.verificationFailure ? "FAILED" : "PASSED",
    JSON.stringify(r.verification),
  );
  assert.equal(r.cleanup, "REMOVED_EPHEMERAL_RESOURCES");
  assert.equal(r.clone.isolationVerified.network, "none");
  if (test.name === "transaction-rollback")
    assert.equal(
      r.execution.transactionAtDisconnect,
      "OPEN_TRANSACTION_ROLLED_BACK",
    );
  if (test.name === "committed-partial-failure")
    assert.equal(r.execution.statements[2].status, "NOT_RUN");
  if (test.name === "timeout")
    assert.equal(r.execution.error.sqlstate, "57014");
  assert.deepEqual(await fingerprint(), original, "Source database changed!");
  results.push({
    name: test.name,
    passed: true,
    runId: result.runId,
    status: r.status,
    sourceUnchanged: true,
  });
  await mkdir("artifacts/rehearsals", { recursive: true });
  await writeFile(
    "artifacts/rehearsals/acceptance.json",
    JSON.stringify(results, null, 2),
    { mode: 0o600 },
  );
  console.log(
    `PASS ${test.name}: ${r.execution.status}; verification ${r.verification.status}; source unchanged`,
  );
}
console.log(`${results.length} rehearsal checks passed.`);
