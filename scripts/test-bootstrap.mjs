import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";

const id = randomUUID();
const name = `mfr-bootstrap-test-${id}`;
const image =
  "postgres:16-alpine@sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea";
function docker(args, input) {
  const result = spawnSync("docker", args, {
    input,
    encoding: "utf8",
    timeout: 60000,
    maxBuffer: 16 * 1024 ** 2,
  });
  if (result.status !== 0)
    throw new Error(
      result.stderr || result.error?.message || "Docker command failed",
    );
  return result.stdout.trim();
}
const query = (sql) =>
  docker(
    [
      "exec",
      "-i",
      name,
      "psql",
      "-X",
      "-U",
      "migration_agent",
      "-d",
      "migration_flight_recorder",
      "-At",
      "-v",
      "ON_ERROR_STOP=1",
    ],
    sql,
  );
let created = false;
try {
  docker([
    "run",
    "-d",
    "--name",
    name,
    "--label",
    `mfr.bootstrap.test=${id}`,
    "--network",
    "none",
    "--cpus",
    "2",
    "--memory",
    "2g",
    "-e",
    "POSTGRES_HOST_AUTH_METHOD=trust",
    "-e",
    "POSTGRES_USER=migration_agent",
    "-e",
    "POSTGRES_DB=migration_flight_recorder",
    image,
  ]);
  created = true;
  for (let attempt = 0; ; attempt++) {
    try {
      query("SELECT 1");
      break;
    } catch (error) {
      if (attempt >= 60) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  query(await readFile("db/migrations/000_baseline.sql", "utf8"));
  query(await readFile("db/seeds/001_production_like_data.sql", "utf8"));
  assert.equal(
    query(
      "SELECT count(*),count(*) FILTER(WHERE legacy_customer_reference IS NULL) FROM app.organizations;",
    ),
    "200|147",
  );
  assert.equal(query("SELECT count(*) FROM app.projects;"), "500");
  assert.equal(query("SELECT count(*) FROM audit.events;"), "25000");
  query(await readFile("sandbox/target-setup.sql", "utf8"));
  assert.equal(
    query(
      "SELECT rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls FROM pg_roles WHERE rolname='mfr_executor';",
    ),
    "f|f|f|f|f",
  );
  assert.equal(
    query("SELECT count(*) FROM pg_tables WHERE tableowner='mfr_executor';"),
    "12",
  );
  assert.equal(
    query(
      "SELECT has_table_privilege('mfr_executor','mfr_control.executions','SELECT'),has_table_privilege('mfr_executor','mfr_control.executions','INSERT'),has_table_privilege('mfr_executor','mfr_control.executions','UPDATE'),has_table_privilege('mfr_executor','mfr_control.executions','DELETE');",
    ),
    "t|t|f|f",
  );
  assert.equal(query("SELECT count(*) FROM mfr_control.executions;"), "0");
  assert.equal(
    query(
      "SELECT count(*),count(*) FILTER(WHERE legacy_customer_reference IS NULL) FROM app.organizations;",
    ),
    "200|147",
  );
  console.log(
    "PASS fresh baseline, seed counts, deployment-role flags, 12 table owners and protected empty ledger. Original database not accessed.",
  );
} finally {
  if (created) {
    assert.equal(
      docker([
        "inspect",
        "--format",
        '{{index .Config.Labels "mfr.bootstrap.test"}}',
        name,
      ]),
      id,
    );
    docker(["rm", "-f", "-v", name]);
  }
}
