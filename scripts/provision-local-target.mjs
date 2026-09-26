// Trusted operator entry point only. Never exposed as an MCP tool.
// Run only after explicit approval of sandbox/target-setup.sql ownership changes.
import { readFile, open, unlink } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import pg from "pg";
if (process.argv[2] !== "--reviewed-local-setup")
  throw new Error(
    "Review sandbox/target-setup.sql and obtain explicit operator approval first.",
  );
const text = await readFile("sandbox/.env", "utf8");
const uri = text
  .split("\n")
  .find((line) => line.startsWith("REHEARSAL_SOURCE_URL="))
  ?.slice("REHEARSAL_SOURCE_URL=".length)
  .trim();
const source = new URL(uri);
if (
  !["postgres:", "postgresql:"].includes(source.protocol) ||
  !["localhost", "127.0.0.1"].includes(source.hostname) ||
  source.port !== "54329" ||
  source.pathname !== "/migration_flight_recorder" ||
  source.search
)
  throw new Error("Wrong source identity; refusing setup");
const client = new pg.Client({
  connectionString: uri,
  connectionTimeoutMillis: 5000,
  query_timeout: 35000,
});
await client.connect();
let file,
  committing = false;
try {
  const existing = (
    await client.query(
      "SELECT rolname FROM pg_catalog.pg_roles WHERE rolname='mfr_executor'",
    )
  ).rows;
  if (existing.length)
    throw new Error(
      "Deployment role already exists: inspect manually; this script never resets existing credentials/ownership",
    );
  file = await open("sandbox/target.env", "wx", 0o600);
  const sql = await readFile("sandbox/target-setup.sql", "utf8");
  if (!sql.includes("\nCOMMIT;\n"))
    throw new Error("Unexpected reviewed setup format");
  await client.query(sql.replace("\nCOMMIT;\n", "\n"));
  const password = randomBytes(32).toString("hex");
  await client.query(`ALTER ROLE mfr_executor PASSWORD '${password}'`);
  await file.writeFile(
    `TARGET_DATABASE_URL=postgresql://mfr_executor:${password}@127.0.0.1:54329/migration_flight_recorder\n`,
  );
  await file.sync();
  committing = true;
  await client.query("COMMIT");
  console.log(
    "Deployment role/ledger provisioned. Private target.env written. No migration applied.",
  );
} catch (error) {
  if (!committing) {
    await client.query("ROLLBACK").catch(() => {});
    if (file) {
      await file.close();
      file = undefined;
      await unlink("sandbox/target.env");
    }
  }
  // On unknown COMMIT outcome preserve credentials for operator reconciliation.
  throw new Error(
    committing
      ? "Setup commit outcome uncertain; preserve target.env and inspect role/ledger before retrying."
      : error.message,
  );
} finally {
  await file?.close();
  await client.end();
}
