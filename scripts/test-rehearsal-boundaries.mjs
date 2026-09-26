import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import {
  restoreArchive,
  runRehearsal,
  cleanupInterrupted,
  sourceQuery,
} from "./rehearsal.mjs";

function docker(args, input) {
  return new Promise((resolve, reject) => {
    const process = spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    process.stdout.on("data", (part) => {
      stdout += part;
    });
    process.stderr.on("data", (part) => {
      stderr += part;
    });
    process.stdin.on("error", () => {});
    process.stdin.end(input);
    process.on("error", reject);
    process.on("close", (code) =>
      code === 0 ? resolve(stdout) : reject(new Error(stderr)),
    );
  });
}
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
const result = [];
const id = randomUUID();
const container = `mfr-rehearsal-${id}`;
const image = (
  await docker([
    "inspect",
    "migration-flight-recorder-postgres",
    "--format",
    "{{.Image}}",
  ])
).trim();
const sourceBefore = await sourceQuery(
  "SELECT count(*)::text || ':' || count(*) FILTER(WHERE legacy_customer_reference IS NULL)::text FROM app.organizations;",
);
try {
  await docker([
    "run",
    "-d",
    "--name",
    container,
    "--label",
    `mfr.rehearsal.run=${id}`,
    "--network",
    "none",
    "--user",
    "70:70",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--read-only",
    "--cpus",
    "2",
    "--memory",
    "2g",
    "--memory-swap",
    "2g",
    "--pids-limit",
    "128",
    "--tmpfs",
    "/var/lib/postgresql/data:rw,uid=70,gid=70,size=1536m",
    "--tmpfs",
    "/var/run/postgresql:rw,uid=70,gid=70,size=16m",
    "--tmpfs",
    "/tmp:rw,uid=70,gid=70,size=64m",
    "-e",
    "POSTGRES_HOST_AUTH_METHOD=trust",
    "-e",
    "POSTGRES_DB=rehearsal",
    image,
    "postgres",
    "-c",
    "listen_addresses=",
  ]);
  for (let i = 0; ; i++) {
    try {
      await docker([
        "exec",
        "--user",
        "postgres",
        container,
        "pg_isready",
        "-U",
        "postgres",
      ]);
      break;
    } catch (error) {
      if (i === 40) throw error;
      await delay(250);
    }
  }
  let migrationReached = false;
  await assert.rejects(async () => {
    await restoreArchive(
      (args) =>
        docker(
          ["exec", "-i", "--user", "postgres", container, ...args],
          "not a PostgreSQL archive",
        ),
      "corrupt.dump",
    );
    migrationReached = true;
  }, /input file|archive|header/i);
  assert.equal(migrationReached, false);
  result.push({
    name: "real-corrupt-archive-restore-fails-before-migration",
    passed: true,
  });
} finally {
  // This exact name was freshly generated above, and ownership is checked again.
  const actual = (
    await docker([
      "inspect",
      container,
      "--format",
      '{{index .Config.Labels "mfr.rehearsal.run"}}',
    ])
  ).trim();
  assert.equal(actual, id);
  await docker(["rm", "-f", "-v", container]);
}

const child = spawn(
  process.execPath,
  [
    "--input-type=module",
    "-e",
    "import {runRehearsal} from './scripts/rehearsal.mjs'; const r=await runRehearsal({proposedSql:'SELECT pg_sleep(35);'}); console.log(JSON.stringify({directory:r.directory,report:r.report}));",
  ],
  { stdio: ["ignore", "pipe", "pipe"] },
);
let output = "";
let errors = "";
child.stdout.on("data", (part) => {
  output += part;
});
child.stderr.on("data", (part) => {
  errors += part;
});
const closed = new Promise((resolve) => child.on("close", resolve));
try {
  let lock;
  for (let i = 0; ; i++) {
    try {
      lock = JSON.parse(
        await readFile("artifacts/rehearsals/active.lock", "utf8"),
      );
      if (lock.pid === child.pid) break;
    } catch {}
    if (i === 200) throw new Error("Child did not acquire lock");
    await delay(100);
  }
  await assert.rejects(
    runRehearsal({ proposedSql: "SELECT 1;" }),
    /lock exists/,
  );
  await assert.rejects(cleanupInterrupted(), /still active/);
  result.push({
    name: "concurrent-run-and-active-cleanup-rejected",
    passed: true,
  });
  for (let i = 0; ; i++) {
    const names = await docker([
      "ps",
      "-a",
      "--filter",
      `label=mfr.rehearsal.run=${lock.runId}`,
      "--format",
      "{{.Names}}",
    ]);
    if (names.includes(lock.runId)) break;
    if (i === 200) throw new Error("Child sandbox not created");
    await delay(100);
  }
  child.kill("SIGTERM");
  await closed;
  assert.equal(errors, "");
  const r = JSON.parse(output).report;
  assert.equal(r.status, "INTERRUPTED_OR_DEADLINE");
  assert.equal(r.cleanup, "REMOVED_EPHEMERAL_RESOURCES");
  const left = await docker([
    "ps",
    "-a",
    "--filter",
    `label=mfr.rehearsal.run=${lock.runId}`,
    "--format",
    "{{.Names}}",
  ]);
  assert.equal(left.trim(), "");
  result.push({ name: "signal-cleans-owned-container-and-lock", passed: true });
} finally {
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM");
    await closed;
  }
}
assert.equal(
  await sourceQuery(
    "SELECT count(*)::text || ':' || count(*) FILTER(WHERE legacy_customer_reference IS NULL)::text FROM app.organizations;",
  ),
  sourceBefore,
);
const lexical = await runRehearsal({
  proposedSql:
    "DO $$ BEGIN PERFORM ';'; END $$; SELECT 'é;' AS value -- trailing comment without terminator",
  checks: [
    {
      name: "comment-safe SELECT",
      sql: "SELECT 'é;' AS value; -- trailing comment",
      expectedRows: [{ value: "é;" }],
    },
  ],
});
assert.equal(lexical.report.execution.status, "SUCCEEDED");
assert.equal(lexical.report.execution.statements.length, 2);
assert.match(lexical.report.execution.statements[1].result, /é;/);
assert.equal(lexical.report.verification.status, "PASSED");
assert.equal(lexical.report.cleanup, "REMOVED_EPHEMERAL_RESOURCES");
result.push({
  name: "procedural-unicode-semicolons-and-trailing-comments",
  passed: true,
  runId: lexical.runId,
});
await writeFile(
  "artifacts/rehearsals/boundary-acceptance.json",
  JSON.stringify(result, null, 2),
  { mode: 0o600 },
);
console.log(JSON.stringify(result, null, 2));
