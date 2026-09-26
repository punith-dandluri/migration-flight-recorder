import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import pg from "pg";
import {
  PROFILE,
  digest,
  fingerprint,
  runAtomic,
  validateAtomic,
} from "./target-policy.mjs";
import { createTargetEngine } from "./target-engine.mjs";

const temp = await mkdtemp(join(tmpdir(), "mfr-target-tests-"));
await mkdir("artifacts", { recursive: true, mode: 0o700 });
const name = "mfr-target-test-" + randomUUID();
function docker(args, input) {
  const r = spawnSync("docker", args, {
    input,
    maxBuffer: 32 * 1024 ** 2,
    timeout: 60000,
  });
  if (r.status !== 0) throw new Error(r.stderr?.toString() || r.error?.message);
  return r.stdout;
}
let port;
async function connect(database = "mfr_execution_test", user = "mfr_executor") {
  const c = new pg.Client({
    host: "127.0.0.1",
    port,
    database,
    user,
    connectionTimeoutMillis: 5000,
  });
  await c.connect();
  return c;
}
const records = [];
const passed = (label) => {
  records.push(label);
  console.log("PASS " + label);
};
try {
  for (const sql of [
    "BEGIN; ALTER TABLE app.projects ADD COLUMN x text; COMMIT;",
    "CREATE INDEX CONCURRENTLY ix ON app.projects(id);",
    "DO $$ BEGIN NULL; END $$;",
    "ALTER TABLE mfr_control.executions ADD COLUMN x int;",
    "ALTER TABLE projects ADD COLUMN x text;",
    "UPDATE app.projects SET name=pg_read_file('/etc/passwd');",
    "ALTER TABLE app.projects OWNER TO postgres;",
    "ALTER TABLE app.projects ADD COLUMN x custom.dangerous;",
  ])
    await assert.rejects(validateAtomic(sql));
  passed("atomic policy rejects unsafe/unsupported syntax");
  const image = docker([
    "inspect",
    "--format",
    "{{.Image}}",
    "migration-flight-recorder-postgres",
  ])
    .toString()
    .trim();
  docker([
    "run",
    "-d",
    "--name",
    name,
    "--label",
    "mfr.target.test=true",
    "--cpus",
    "2",
    "--memory",
    "512m",
    "-p",
    "127.0.0.1::5432",
    "-e",
    "POSTGRES_HOST_AUTH_METHOD=trust",
    "-e",
    "POSTGRES_DB=mfr_execution_test",
    image,
  ]);
  const info = JSON.parse(docker(["inspect", name]).toString())[0];
  port = Number(info.NetworkSettings.Ports["5432/tcp"][0].HostPort);
  let admin;
  for (let i = 0; i < 40; i++) {
    try {
      admin = await connect("mfr_execution_test", "postgres");
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  assert(admin);
  await admin.query(
    `CREATE ROLE mfr_executor LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS; CREATE SCHEMA app AUTHORIZATION mfr_executor; CREATE TABLE app.projects(id integer PRIMARY KEY,name text); ALTER TABLE app.projects OWNER TO mfr_executor; INSERT INTO app.projects VALUES(1,'one'),(2,'two'); CREATE SCHEMA mfr_control; CREATE TABLE mfr_control.executions(plan_id uuid PRIMARY KEY,sql_sha256 text,rehearsal_run_id uuid,evidence jsonb); GRANT USAGE ON SCHEMA mfr_control TO mfr_executor; GRANT SELECT,INSERT ON mfr_control.executions TO mfr_executor;`,
  );
  const client = await connect();
  const query = async (sql) => (await client.query(sql)).rows;
  const baseline = await fingerprint(query);
  const sql = "ALTER TABLE app.projects ADD COLUMN url text;";
  const checks = [
    {
      name: "column",
      sql: "SELECT column_name,data_type,is_nullable FROM information_schema.columns WHERE table_schema='app' AND table_name='projects' AND column_name='url'",
      expectedRows: [
        { column_name: "url", data_type: "text", is_nullable: "YES" },
      ],
    },
  ];
  let failBackup = false;
  async function verifiedBackup() {
    if (failBackup) throw new Error("simulated corrupt backup");
    const archive = join(temp, randomUUID() + ".dump");
    const bytes = docker([
      "exec",
      name,
      "pg_dump",
      "-U",
      "postgres",
      "-d",
      "mfr_execution_test",
      "-Fc",
      "--no-owner",
      "--no-acl",
      "--exclude-schema=mfr_control",
    ]);
    await writeFile(archive, bytes, { mode: 0o600 });
    await admin.query("DROP DATABASE IF EXISTS mfr_restore_test WITH (FORCE)");
    await admin.query("CREATE DATABASE mfr_restore_test OWNER mfr_executor");
    docker(
      [
        "exec",
        "-i",
        name,
        "pg_restore",
        "-U",
        "mfr_executor",
        "-d",
        "mfr_restore_test",
        "--no-owner",
        "--no-acl",
        "--exit-on-error",
      ],
      bytes,
    );
    const restored = await connect("mfr_restore_test");
    const fp = await fingerprint(
      async (sql) => (await restored.query(sql)).rows,
    );
    await restored.end();
    return {
      archive,
      contentDigest: digest(bytes.toString("base64")),
      fingerprint: fp,
      restoreVerified: true,
    };
  }
  await verifiedBackup();
  const rehearsal = await connect("mfr_restore_test");
  const rehearsalResult = await runAtomic(rehearsal, { sql, checks });
  assert.equal(rehearsalResult.status, "COMMITTED");
  const after = await fingerprint(
    async (sql) => (await rehearsal.query(sql)).rows,
  );
  await rehearsal.end();
  const report = {
    executionProfile: PROFILE,
    execution: { status: "SUCCEEDED" },
    verification: { status: "PASSED", checks },
    cleanup: "REMOVED_EPHEMERAL_RESOURCES",
    baselineFingerprint: baseline,
    afterFingerprint: after,
    source: {
      database: "mfr_execution_test",
      version: (await query("SHOW server_version"))[0].server_version,
    },
    sqlSha256: digest(sql),
    diff: { schemaChanged: true },
  };
  const engine = createTargetEngine({
    directory: temp,
    secret: "test-only-key-not-for-deployment",
    connect,
    targetIdentity: {
      database: "mfr_execution_test",
      role: "mfr_executor",
      targetId: "test-only",
    },
    loadRehearsal: async () => ({ sql, report }),
    backup: verifiedBackup,
  });
  const rehearsalId = randomUUID();
  failBackup = true;
  await assert.rejects(engine.prepare(rehearsalId), /corrupt backup/);
  failBackup = false;
  passed("backup failure blocks preparation");
  const expired = await engine.prepare(rehearsalId);
  const realNow = Date.now;
  try {
    Date.now = () => realNow() + 16 * 60000;
    await assert.rejects(engine.apply(expired.planId), /expired/);
  } finally {
    Date.now = realNow;
  }
  passed("expired plan cannot apply");
  const badRoleEngine = createTargetEngine({
    directory: temp,
    secret: "test",
    connect: () => connect("mfr_execution_test", "postgres"),
    targetIdentity: {
      database: "mfr_execution_test",
      role: "mfr_executor",
      targetId: "test-only",
    },
    loadRehearsal: async () => ({ sql, report }),
    backup: verifiedBackup,
  });
  await assert.rejects(
    badRoleEngine.prepare(rehearsalId),
    /identity|privilege/,
  );
  passed("wrong or superuser deployment identity refused");
  const tampered = await engine.prepare(rehearsalId);
  const planPath = join(temp, `${tampered.planId}.plan.json`);
  const envelope = JSON.parse(await readFile(planPath, "utf8"));
  envelope.plan.sql = "DELETE FROM app.projects";
  await writeFile(planPath, JSON.stringify(envelope));
  await assert.rejects(engine.apply(tampered.planId), /tampered/);
  passed("SQL tampering blocked");
  const drift = await engine.prepare(rehearsalId);
  await client.query("UPDATE app.projects SET name='changed' WHERE id=1");
  const driftResult = await engine.apply(drift.planId);
  assert.equal(driftResult.status, "ROLLED_BACK");
  assert.match(driftResult.error, /drift/);
  await client.query("UPDATE app.projects SET name='one' WHERE id=1");
  passed("same-row-count value drift blocked before DDL");
  const good = await engine.prepare(rehearsalId);
  assert.equal(good.status, "AWAITING_TARGET_APPROVAL");
  const result = await engine.apply(good.planId);
  assert.equal(result.status, "COMMITTED", JSON.stringify(result));
  assert(result.commitRecordVerified);
  assert.equal((await engine.apply(good.planId)).status, "COMMITTED");
  assert.equal(
    (await query("SELECT count(*)::int AS n FROM mfr_control.executions"))[0].n,
    1,
  );
  passed("verified backup, apply, ledger and replay protection");
  await client.query("ALTER TABLE app.projects DROP COLUMN url");
  const failed = await runAtomic(client, {
    sql,
    checks: [{ ...checks[0], expectedRows: [] }],
  });
  assert.equal(failed.status, "ROLLED_BACK");
  assert.equal((await client.query(checks[0].sql)).rows.length, 0);
  passed("failed postcondition rolls back DDL");
  const error = await runAtomic(client, {
    sql: sql + "UPDATE app.projects SET id=1;",
    checks,
  });
  assert.equal(error.status, "ROLLED_BACK");
  assert.equal((await client.query(checks[0].sql)).rows.length, 0);
  passed("SQL error rolls back earlier DDL");
  const destructive = await runAtomic(client, {
    sql: "ALTER TABLE app.projects DROP COLUMN name;",
    checks: [
      {
        name: "intentionally failing destructive check",
        sql: "SELECT count(*)::int AS n FROM information_schema.columns WHERE table_schema='app' AND table_name='projects' AND column_name='name'",
        expectedRows: [{ n: 1 }],
      },
    ],
  });
  assert.equal(destructive.status, "ROLLED_BACK");
  assert.equal(
    (await client.query("SELECT name FROM app.projects ORDER BY id")).rows[0]
      .name,
    "one",
  );
  passed("destructive DDL rollback restores values");
  const holder = await connect();
  await holder.query("BEGIN; LOCK TABLE app.projects IN ACCESS EXCLUSIVE MODE");
  const locked = await runAtomic(client, { sql, checks });
  assert.equal(locked.status, "ROLLED_BACK");
  assert.match(locked.error, /lock timeout/);
  await holder.query("ROLLBACK");
  await holder.end();
  passed("lock timeout rolls back");
  const realQuery = client.query.bind(client);
  const unknown = await runAtomic(
    {
      query: async (...args) => {
        const result = await realQuery(...args);
        if (args[0] === "COMMIT")
          throw new Error("simulated lost commit acknowledgment");
        return result;
      },
    },
    { sql, checks },
  );
  assert.equal(unknown.status, "OUTCOME_UNKNOWN");
  passed("lost commit acknowledgment is not reported rolled back");
  await client.end();
  await admin.end();
  await writeFile(
    "artifacts/target-execution-tests.json",
    JSON.stringify(
      {
        scope: "disposable test container only; no live target changes",
        records,
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
} finally {
  try {
    const labels = JSON.parse(
      docker([
        "inspect",
        "--format",
        "{{json .Config.Labels}}",
        name,
      ]).toString(),
    );
    if (labels["mfr.target.test"] === "true") docker(["rm", "-f", "-v", name]);
  } catch {}
  await rm(temp, { recursive: true, force: true });
}
