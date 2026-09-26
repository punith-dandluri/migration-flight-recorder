import pg from "pg";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
const config = Object.fromEntries(
  (await readFile("mcp/.env", "utf8"))
    .trim()
    .split("\n")
    .map((line) => {
      const i = line.indexOf("=");
      return [line.slice(0, i), line.slice(i + 1)];
    }),
);
const results = [];
for (const key of ["PRIMARY_DATABASE_URI", "SECONDARY_DATABASE_URI"]) {
  const uri = new URL(config[key]);
  uri.hostname = "127.0.0.1";
  const client = new pg.Client({ connectionString: uri.toString() });
  await client.connect();
  try {
    const role = (
      await client.query(
        "SELECT rolname,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls FROM pg_roles WHERE rolname=current_user",
      )
    ).rows[0];
    assert(
      Object.entries(role).every(
        ([name, value]) => name === "rolname" || value === false,
      ),
    );
    assert.equal(
      (
        await client.query(
          "SELECT count(*)::int AS n FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname=current_user)",
        )
      ).rows[0].n,
      0,
    );
    const databasePrivileges = (
      await client.query(
        "SELECT has_database_privilege(current_user,current_database(),'TEMP') AS temp, has_database_privilege(current_user,current_database(),'CREATE') AS create",
      )
    ).rows[0];
    assert.equal(databasePrivileges.temp, false);
    assert.equal(databasePrivileges.create, false);
    assert.equal(
      (
        await client.query(
          "SELECT count(*)::int AS n FROM pg_class WHERE relowner=(SELECT oid FROM pg_roles WHERE rolname=current_user)",
        )
      ).rows[0].n,
      0,
    );
    assert.equal(
      (
        await client.query(
          "SELECT count(*)::int AS n FROM pg_namespace WHERE nspname NOT LIKE 'pg_%' AND has_schema_privilege(current_user,oid,'CREATE')",
        )
      ).rows[0].n,
      0,
    );
    assert.equal(
      (
        await client.query(
          "SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind IN ('r','p') AND n.nspname NOT IN ('pg_catalog','information_schema') AND (has_table_privilege(current_user,c.oid,'INSERT') OR has_table_privilege(current_user,c.oid,'UPDATE') OR has_table_privilege(current_user,c.oid,'DELETE') OR has_table_privilege(current_user,c.oid,'TRUNCATE'))",
        )
      ).rows[0].n,
      0,
    );
    assert.equal(
      (
        await client.query(
          "SELECT count(*)::int AS n FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND p.prosecdef AND has_function_privilege(current_user,p.oid,'EXECUTE')",
        )
      ).rows[0].n,
      0,
    );
    if (key === "SECONDARY_DATABASE_URI") {
      // Demonstrate that actual privileges, not just a session default, prevent writes.
      await client.query("SET default_transaction_read_only=off");
      for (const sql of [
        "INSERT INTO inventory.products VALUES (77,'NO',0)",
        "ALTER TABLE inventory.products ADD COLUMN forbidden text",
        "SELECT inventory.unsafe_write()",
        "SET ROLE migration_agent",
      ]) {
        await assert.rejects(client.query(sql), (error) =>
          ["42501"].includes(error.code),
        );
      }
      assert.equal(
        (
          await client.query(
            "SELECT count(*)::int AS n FROM inventory.products",
          )
        ).rows[0].n,
        3,
      );
    }
    results.push({
      role: role.rolname,
      privileges: "restricted",
      passed: true,
    });
    console.log(
      `PASS ${role.rolname}: no write/owner/admin privileges; no executable custom security-definer functions`,
    );
  } finally {
    await client.end();
  }
}
await mkdir("artifacts", { recursive: true });
await writeFile(
  "artifacts/role-verification.json",
  JSON.stringify(results, null, 2),
);
