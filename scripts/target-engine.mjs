// Server-side orchestration. Dependencies are supplied by trusted operator code,
// never by model arguments. Approval is enforced by the authenticated TrueForge connector.
import { mkdir, readFile, writeFile, open, rename } from "node:fs/promises";
import { randomUUID, createHmac, timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import {
  PROFILE,
  digest,
  fingerprint,
  validateAtomic,
  validateChecks,
  runAtomic,
  tablesSQL,
  quote,
} from "./target-policy.mjs";

const uuid = (value) => {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  )
    throw new Error("Invalid record ID");
  return value;
};
export function createTargetEngine({
  directory,
  secret,
  connect,
  targetIdentity,
  loadRehearsal,
  backup,
}) {
  const sign = (plan) =>
    createHmac("sha256", secret).update(JSON.stringify(plan)).digest("hex");
  const path = (id, suffix) => join(directory, `${uuid(id)}.${suffix}.json`);
  const save = async (file, value) => {
    const tmp = `${file}.${randomUUID()}.tmp`;
    await writeFile(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
    await rename(tmp, file);
  };
  const read = async (id, suffix) =>
    JSON.parse(await readFile(path(id, suffix), "utf8"));
  async function identity(client) {
    const row = (
      await client.query(
        "SELECT current_database() AS database, current_setting('server_version') AS version,current_user AS role,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls FROM pg_catalog.pg_roles WHERE rolname=current_user",
      )
    ).rows[0];
    if (
      row.database !== targetIdentity.database ||
      row.role !== targetIdentity.role ||
      row.rolsuper ||
      row.rolcreatedb ||
      row.rolcreaterole ||
      row.rolreplication ||
      row.rolbypassrls
    )
      throw new Error(
        "Target identity or deployment-role privilege check failed",
      );
    const inherited = (
      await client.query(
        "SELECT rolname FROM pg_catalog.pg_roles WHERE rolname<>current_user AND pg_catalog.pg_has_role(current_user,oid,'MEMBER') AND (rolsuper OR rolcreaterole OR rolcreatedb OR rolreplication OR rolbypassrls OR rolname LIKE 'pg_%')",
      )
    ).rows;
    if (inherited.length)
      throw new Error("Deployment role has privileged memberships");
    return {
      database: row.database,
      version: row.version,
      role: row.role,
      targetId: targetIdentity.targetId,
    };
  }
  async function lockAndFingerprint(client) {
    await client.query("SELECT pg_catalog.pg_advisory_xact_lock(78634327)");
    const query = async (sql) => (await client.query(sql)).rows;
    const tables = await query(tablesSQL);
    if (tables.length)
      await client.query(
        `LOCK TABLE ${tables.map((t) => `${quote(t.schema)}.${quote(t.name)}`).join(",")} IN ACCESS EXCLUSIVE MODE`,
      );
    return fingerprint(query);
  }
  async function prepare(rehearsalRunId) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const { report, sql } = await loadRehearsal(uuid(rehearsalRunId));
    if (
      report.executionProfile !== PROFILE ||
      report.execution.status !== "SUCCEEDED" ||
      report.verification.status !== "PASSED" ||
      report.cleanup !== "REMOVED_EPHEMERAL_RESOURCES" ||
      !report.baselineFingerprint ||
      report.source.database !== targetIdentity.database ||
      report.sqlSha256 !== digest(sql)
    )
      throw new Error(
        "Requires an unchanged, successful atomic rehearsal with passed checks and complete cleanup",
      );
    const checks = report.verification.checks.map(
      ({ name, sql, expectedRows }) => ({ name, sql, expectedRows }),
    );
    await validateAtomic(sql);
    await validateChecks(checks);
    const client = await connect();
    let identified;
    try {
      identified = await identity(client);
      if (identified.version !== report.source.version)
        throw new Error("PostgreSQL version changed");
      // Fail before copying anything when deployment setup is incomplete.
      await client.query("SELECT plan_id FROM mfr_control.executions LIMIT 0");
      await client.query("BEGIN");
      await client.query(
        "SET LOCAL lock_timeout='2s'; SET LOCAL statement_timeout='30s'",
      );
      if (
        (await lockAndFingerprint(client)).sha256 !==
        report.baselineFingerprint.sha256
      )
        throw new Error("Target drift since rehearsal; rehearse again");
    } finally {
      await client.query("ROLLBACK").catch(() => {});
      await client.end();
    }
    const verified = await backup();
    if (
      !verified.restoreVerified ||
      verified.fingerprint.sha256 !== report.baselineFingerprint.sha256
    )
      throw new Error(
        "Verified backup does not match rehearsed baseline; no execution plan created",
      );
    const plan = {
      planId: randomUUID(),
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 900000).toISOString(),
      target: identified,
      rehearsalRunId,
      sql,
      sqlSha256: digest(sql),
      checks,
      executionProfile: PROFILE,
      baselineFingerprint: report.baselineFingerprint.sha256,
      backup: verified,
      impact: {
        before: report.baselineFingerprint.tables,
        after: report.afterFingerprint?.tables,
        schemaChanged: report.diff.schemaChanged,
        warning:
          "Review removed columns, reduced populated counts, changed content hashes and row counts. Hash changes do not explain business meaning; do not approve uncertain destructive effects.",
      },
    };
    await save(path(plan.planId, "plan"), { plan, signature: sign(plan) });
    return {
      status: "AWAITING_TARGET_APPROVAL",
      ...plan,
      backup: { ...verified, archive: undefined },
    };
  }
  async function apply(planId) {
    const envelope = await read(planId, "plan");
    const expected = Buffer.from(sign(envelope.plan));
    const actual = Buffer.from(envelope.signature ?? "");
    if (
      actual.length !== expected.length ||
      !timingSafeEqual(actual, expected) ||
      envelope.plan.planId !== planId
    )
      throw new Error("Execution plan tampered or mismatched");
    const plan = envelope.plan;
    const previous = await read(planId, "execution").catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (previous) return previous;
    if (Date.now() >= Date.parse(plan.expiresAt))
      throw new Error("Execution plan expired; prepare and approve again");
    await validateAtomic(plan.sql);
    await validateChecks(plan.checks);
    if (digest(plan.sql) !== plan.sqlSha256 || !plan.backup.restoreVerified)
      throw new Error("Plan evidence mismatch");
    const bytes = await readFile(plan.backup.archive);
    if (digest(bytes.toString("base64")) !== plan.backup.contentDigest)
      throw new Error("Verified backup missing or modified");
    // Exclusive per-plan claim is durable, so a restart/retry never silently reruns SQL.
    const claim = await open(
      join(directory, `${uuid(planId)}.claim`),
      "wx",
      0o600,
    ).catch((error) => {
      throw new Error(
        error.code === "EEXIST"
          ? "Execution already claimed; inspect outcome, never retry automatically"
          : error.message,
      );
    });
    await claim.writeFile(
      JSON.stringify({ pid: process.pid, at: new Date().toISOString() }),
    );
    await claim.close();
    let result = {
      executionId: planId,
      planId,
      sqlSha256: plan.sqlSha256,
      status: "RUNNING",
      startedAt: new Date().toISOString(),
    };
    await save(path(planId, "execution"), result);
    let client;
    let deadline;
    try {
      client = await connect();
      deadline = setTimeout(() => {
        void client.end().catch(() => {});
      }, 600000);
      if (
        JSON.stringify(await identity(client)) !== JSON.stringify(plan.target)
      )
        throw new Error("Target identity changed");
      const outcome = await runAtomic(client, {
        sql: plan.sql,
        checks: plan.checks,
        beforeExecute: async () => {
          if (Date.now() >= Date.parse(plan.expiresAt))
            throw new Error("Plan expired");
          const found = (
            await client.query(
              "SELECT plan_id FROM mfr_control.executions WHERE plan_id=$1",
              [planId],
            )
          ).rows;
          if (found.length) throw new Error("Plan already committed");
          if (
            (await lockAndFingerprint(client)).sha256 !==
            plan.baselineFingerprint
          )
            throw new Error("Target drift after approval; nothing applied");
        },
        beforeCommit: async (query, evidence) => {
          const invalid = await query(
            "SELECT indexrelid::regclass::text AS name FROM pg_catalog.pg_index WHERE NOT indisvalid OR NOT indisready",
          );
          if (invalid.length)
            throw new Error("Invalid index detected; rolling back");
          await client.query(
            "INSERT INTO mfr_control.executions(plan_id,sql_sha256,rehearsal_run_id,evidence) VALUES($1,$2,$3,$4)",
            [
              planId,
              plan.sqlSha256,
              plan.rehearsalRunId,
              JSON.stringify(evidence),
            ],
          );
        },
      });
      result = { ...result, ...outcome };
      if (outcome.status === "COMMITTED") {
        try {
          const observed = (
            await client.query(
              "SELECT sql_sha256 FROM mfr_control.executions WHERE plan_id=$1",
              [planId],
            )
          ).rows;
          result.commitRecordVerified =
            observed[0]?.sql_sha256 === plan.sqlSha256;
          if (!result.commitRecordVerified)
            result.status = "COMMITTED_VERIFICATION_INCOMPLETE";
        } catch (error) {
          result.status = "COMMITTED_VERIFICATION_INCOMPLETE";
          result.verificationError = error.message;
        }
      }
    } catch (error) {
      result = {
        ...result,
        status: "PRECONDITION_FAILED",
        error: error.message,
      };
    } finally {
      clearTimeout(deadline);
      await client?.end().catch(() => {});
    }
    result.finishedAt = new Date().toISOString();
    await save(path(planId, "execution"), result);
    return result;
  }
  async function get(executionId) {
    const result = await read(executionId, "execution");
    if (!["RUNNING", "OUTCOME_UNKNOWN"].includes(result.status)) return result;
    const client = await connect();
    try {
      await identity(client);
      const rows = (
        await client.query(
          "SELECT sql_sha256,evidence FROM mfr_control.executions WHERE plan_id=$1",
          [executionId],
        )
      ).rows;
      if (rows[0]?.sql_sha256 === result.sqlSha256) {
        const reconciled = {
          ...result,
          status: "COMMITTED",
          reconciled: true,
          ...rows[0].evidence,
        };
        await save(path(executionId, "execution"), reconciled);
        return reconciled;
      }
      return {
        ...result,
        status: "OUTCOME_UNKNOWN",
        message:
          "No confirmed commit record yet. Do not retry; operator reconciliation required.",
      };
    } finally {
      await client.end();
    }
  }
  return { prepare, apply, get };
}
