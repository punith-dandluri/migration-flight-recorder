import { parse } from "pgsql-parser";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

export const PROFILE = "atomic-reviewed-v1";
export const appSchemas = [
  "app",
  "auth",
  "billing",
  "operations",
  "audit",
  "analytics",
  "control",
];
export const quote = (value) => '"' + value.replaceAll('"', '""') + '"';
export const digest = (value) =>
  createHash("sha256")
    .update(typeof value === "string" ? value : JSON.stringify(value))
    .digest("hex");
const pureFunctions = new Set([
  "count",
  "sum",
  "min",
  "max",
  "avg",
  "length",
  "lower",
  "upper",
  "trim",
  "btrim",
  "abs",
  "round",
  "md5",
  "to_jsonb",
  "json_build_object",
  "jsonb_build_object",
  "format_type",
  "pg_get_constraintdef",
  "pg_get_indexdef",
]);
const safeTypes = new Set([
  "text",
  "varchar",
  "bpchar",
  "int2",
  "int4",
  "int8",
  "integer",
  "bigint",
  "smallint",
  "numeric",
  "bool",
  "boolean",
  "date",
  "timestamp",
  "timestamptz",
  "json",
  "jsonb",
  "uuid",
  "inet",
  "float4",
  "float8",
]);
const supportedAlter = new Set([
  "AT_AddColumn",
  "AT_DropColumn",
  "AT_SetNotNull",
  "AT_DropNotNull",
  "AT_AlterColumnType",
  "AT_AddConstraint",
  "AT_DropConstraint",
  "AT_ColumnDefault",
]);
function visit(value, fn) {
  if (!value || typeof value !== "object") return;
  fn(value);
  for (const child of Object.values(value))
    if (Array.isArray(child)) child.forEach((v) => visit(v, fn));
    else visit(child, fn);
}
export async function validateAtomic(sql, { check = false } = {}) {
  if (
    typeof sql !== "string" ||
    !sql.trim() ||
    Buffer.byteLength(sql) > 1048576
  )
    throw new Error("Expected 1 byte to 1 MiB SQL");
  const tree = await parse(sql);
  const bytes = Buffer.from(sql);
  const statements = [];
  const relations = new Map();
  for (const raw of tree.stmts ?? []) {
    const kind = Object.keys(raw.stmt)[0],
      node = raw.stmt[kind];
    if (
      !(
        check
          ? ["SelectStmt"]
          : [
              "AlterTableStmt",
              "IndexStmt",
              "UpdateStmt",
              "DeleteStmt",
              "TruncateStmt",
              "DropStmt",
            ]
      ).includes(kind)
    )
      throw new Error(`Not eligible for atomic target profile: ${kind}`);
    if (
      node.concurrent ||
      node.concurrently ||
      node.behavior === "DROP_CASCADE" ||
      node.restart_seqs
    )
      throw new Error(
        "Concurrent, CASCADE and sequence operations require manual deployment",
      );
    if (
      kind === "DropStmt" &&
      !["OBJECT_TABLE", "OBJECT_INDEX"].includes(node.removeType)
    )
      throw new Error("Only explicit table/index DROP supported");
    if (kind === "DropStmt")
      for (const object of node.objects ?? []) {
        const parts = object.List?.items?.map((v) => v.String?.sval);
        if (parts?.length !== 2 || !appSchemas.includes(parts[0]))
          throw new Error("DROP requires an allowlisted schema-qualified name");
      }
    if (kind === "AlterTableStmt")
      for (const cmd of node.cmds ?? []) {
        if (
          !supportedAlter.has(cmd.AlterTableCmd?.subtype) ||
          cmd.AlterTableCmd?.behavior === "DROP_CASCADE"
        )
          throw new Error("Unsupported ALTER operation");
      }
    visit(raw.stmt, (object) => {
      if (
        object.RangeVar ||
        (typeof object.relname === "string" &&
          Object.hasOwn(object, "relpersistence"))
      ) {
        const r = object.RangeVar ?? object;
        if (
          !r.schemaname ||
          !(
            check
              ? [...appSchemas, "pg_catalog", "information_schema"]
              : appSchemas
          ).includes(r.schemaname)
        )
          throw new Error("All relations must use an approved explicit schema");
        if (appSchemas.includes(r.schemaname))
          relations.set(`${r.schemaname}.${r.relname}`, {
            schema: r.schemaname,
            name: r.relname,
          });
      }
      if (object.FuncCall) {
        const parts = object.FuncCall.funcname.map((v) => v.String?.sval);
        if (
          parts.length > 2 ||
          (parts.length === 2 && parts[0] !== "pg_catalog") ||
          !pureFunctions.has(parts.at(-1))
        )
          throw new Error(
            `Function requires manual review: ${parts.join(".")}`,
          );
      }
      if (object.TypeName || object.typeName) {
        const parts =
          (object.TypeName ?? object.typeName).names?.map(
            (v) => v.String?.sval,
          ) ?? [];
        if (
          parts.length > 2 ||
          (parts.length === 2 && parts[0] !== "pg_catalog") ||
          !safeTypes.has(parts.at(-1))
        )
          throw new Error("Type not supported by atomic target profile");
      }
      if (
        object.SelectStmt?.intoClause ||
        object.SelectStmt?.lockingClause ||
        object.SelectStmt?.withClause?.ctes?.some(
          (c) => !c.CommonTableExpr?.ctequery?.SelectStmt,
        )
      )
        throw new Error("Mutating SELECT or CTE unavailable");
      if (
        object.ColumnDef?.identity ||
        object.ColumnDef?.generated ||
        object.A_Expr?.name?.length > 1
      )
        throw new Error(
          "Identity/generated columns or custom operators require manual review",
        );
      if (
        object.NextValueExpr ||
        object.SQLValueFunction ||
        object.CollateClause
      )
        throw new Error("Context-dependent expressions require manual review");
    });
    const start = raw.stmt_location ?? 0;
    statements.push({
      kind,
      sql: bytes
        .subarray(start, raw.stmt_len ? start + raw.stmt_len : bytes.length)
        .toString("utf8")
        .trim(),
    });
  }
  if (!statements.length || (check && statements.length !== 1))
    throw new Error("Empty SQL or multiple check statements");
  return { statements, relations: [...relations.values()] };
}
export async function validateChecks(checks) {
  if (!Array.isArray(checks) || !checks.length || checks.length > 30)
    throw new Error("Atomic execution requires 1–30 explicit postconditions");
  for (const c of checks) {
    if (!c.name || !Array.isArray(c.expectedRows))
      throw new Error("Check name and expectedRows required");
    await validateAtomic(c.sql, { check: true });
  }
}

export const tablesSQL = `SELECT n.nspname AS schema,c.relname AS name FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind='r' AND n.nspname NOT LIKE 'pg_%' AND n.nspname NOT IN ('information_schema','mfr_control') ORDER BY 1,2`;
// Logical fingerprints intentionally exclude remapped owners and physical object OIDs.
export async function fingerprint(query) {
  const tables = await query(tablesSQL);
  const metadata = await query(
    `SELECT n.nspname AS schema,c.relname AS name,c.relkind,c.relrowsecurity,c.relforcerowsecurity,a.attnum,a.attname,pg_catalog.format_type(a.atttypid,a.atttypmod) AS type,a.attnotnull,pg_catalog.pg_get_expr(d.adbin,d.adrelid) AS default_expr FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace LEFT JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname NOT IN ('information_schema','mfr_control') ORDER BY 1,2,a.attnum`,
  );
  const constraints = await query(
    `SELECT n.nspname AS schema,c.relname AS name,k.conname,pg_catalog.pg_get_constraintdef(k.oid) AS definition FROM pg_catalog.pg_constraint k JOIN pg_catalog.pg_class c ON c.oid=k.conrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname NOT IN ('information_schema','mfr_control') ORDER BY 1,2,3`,
  );
  const indexes = await query(
    `SELECT schemaname,tablename,indexname,indexdef FROM pg_catalog.pg_indexes WHERE schemaname NOT LIKE 'pg_%' AND schemaname NOT IN ('information_schema','mfr_control') ORDER BY 1,2,3`,
  );
  const triggers = await query(
    `SELECT n.nspname AS schema,c.relname AS name,t.tgname,pg_catalog.pg_get_triggerdef(t.oid) AS definition FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE NOT t.tgisinternal AND n.nspname NOT LIKE 'pg_%' AND n.nspname <> 'mfr_control' ORDER BY 1,2,3`,
  );
  const data = [];
  const sequences = [];
  for (const s of await query(
    "SELECT schemaname,sequencename FROM pg_catalog.pg_sequences WHERE schemaname NOT LIKE 'pg_%' ORDER BY 1,2",
  )) {
    sequences.push({
      ...s,
      state: await query(
        `SELECT last_value::text,is_called FROM ${quote(s.schemaname)}.${quote(s.sequencename)}`,
      ),
    });
  }
  for (const table of tables) {
    const rows = await query(
      `SELECT pg_catalog.to_jsonb(t)::text AS row FROM ${quote(table.schema)}.${quote(table.name)} t ORDER BY pg_catalog.to_jsonb(t)::text COLLATE "C"`,
    );
    const columns = metadata
      .filter(
        (m) => m.schema === table.schema && m.name === table.name && m.attname,
      )
      .map((m) => m.attname);
    const populated = Object.fromEntries(columns.map((c) => [c, 0]));
    for (const row of rows) {
      const value = JSON.parse(row.row);
      for (const c of columns) if (value[c] !== null) populated[c]++;
    }
    data.push({
      ...table,
      rows: rows.length,
      sha256: digest(rows.map((r) => r.row)),
      populated,
    });
  }
  // pg_dump omits dropped-column holes; attnum values are physical, not logical identity.
  const logicalMetadata = metadata.map(({ attnum, ...column }) => column);
  return {
    sha256: digest({
      metadata: logicalMetadata,
      constraints,
      indexes,
      triggers,
      data,
      sequences,
    }),
    schemaSha256: digest({
      metadata: logicalMetadata,
      constraints,
      indexes,
      triggers,
    }),
    tables: data,
  };
}
export async function assertExecutionEnvironment(query) {
  const unsafe = await query(
    `SELECT c.relname FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname NOT IN ('information_schema','mfr_control') AND (c.relkind IN ('f','p','v','m') OR c.relrowsecurity OR c.relforcerowsecurity)`,
  );
  const triggers = await query(
    `SELECT t.tgname FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE NOT t.tgisinternal AND n.nspname NOT LIKE 'pg_%' AND n.nspname <> 'mfr_control'`,
  );
  const rules = await query(
    `SELECT r.rulename FROM pg_catalog.pg_rewrite r JOIN pg_catalog.pg_class c ON c.oid=r.ev_class JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind='r' AND n.nspname NOT LIKE 'pg_%' AND n.nspname <> 'mfr_control'`,
  );
  const customTypes = await query(
    `SELECT t.typname FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n ON n.oid=t.typnamespace WHERE t.typtype='d' AND n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema'`,
  );
  const customOperators = await query(
    `SELECT o.oprname FROM pg_catalog.pg_operator o JOIN pg_catalog.pg_namespace n ON n.oid=o.oprnamespace WHERE n.nspname <> 'pg_catalog'`,
  );
  const customCasts = await query(
    `SELECT c.oid FROM pg_catalog.pg_cast c JOIN pg_catalog.pg_proc p ON p.oid=c.castfunc JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname <> 'pg_catalog'`,
  );
  if (
    unsafe.length ||
    triggers.length ||
    rules.length ||
    customTypes.length ||
    customOperators.length ||
    customCasts.length
  )
    throw new Error(
      "Views, partitions, foreign tables, RLS, user triggers/rules, domains, custom casts/operators require manual execution review",
    );
}
export async function runAtomic(
  client,
  { sql, checks, beforeExecute, beforeCommit },
) {
  const { statements } = await validateAtomic(sql);
  await validateChecks(checks);
  const evidence = { statements: [], checks: [] };
  let committing = false;
  await client.query("BEGIN");
  try {
    await client.query(
      "SET LOCAL search_path = pg_catalog; SET LOCAL lock_timeout='2s'; SET LOCAL statement_timeout='30s'; SET LOCAL idle_in_transaction_session_timeout='30s'",
    );
    const query = async (sql, args) => (await client.query(sql, args)).rows;
    await assertExecutionEnvironment(query);
    await beforeExecute?.(query);
    for (const statement of statements) {
      const start = Date.now();
      const result = await client.query(statement.sql);
      evidence.statements.push({
        ...statement,
        command: result.command,
        rowCount: result.rowCount,
        milliseconds: Date.now() - start,
      });
    }
    for (const check of checks) {
      const querySql = (await validateAtomic(check.sql, { check: true }))
        .statements[0].sql;
      const actualRows = (
        await client.query(
          `SELECT coalesce(json_agg(mfr_check),'[]') AS rows FROM (${querySql}) mfr_check`,
        )
      ).rows[0].rows;
      const passed = isDeepStrictEqual(actualRows, check.expectedRows);
      evidence.checks.push({ ...check, actualRows, passed });
      if (!passed) throw new Error(`Postcondition failed: ${check.name}`);
    }
    await beforeCommit?.(query, evidence);
    committing = true;
    await client.query("COMMIT");
    return { status: "COMMITTED", ...evidence };
  } catch (error) {
    let rollbackConfirmed = false;
    if (!committing) {
      try {
        await client.query("ROLLBACK");
        rollbackConfirmed = true;
      } catch {}
    }
    return {
      status:
        committing || !rollbackConfirmed ? "OUTCOME_UNKNOWN" : "ROLLED_BACK",
      error: error.message,
      ...evidence,
    };
  }
}
