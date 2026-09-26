import pg from "pg";
import { randomBytes } from "node:crypto";
import { readFile, writeFile, access, mkdir } from "node:fs/promises";

// This changes local role grants, never application rows.
const local = await readFile("sandbox/.env", "utf8").catch(() => "");
const adminUri =
  process.env.ADMIN_DATABASE_URL ??
  local
    .split("\n")
    .find((line) => line.startsWith("REHEARSAL_SOURCE_URL="))
    ?.slice("REHEARSAL_SOURCE_URL=".length)
    .trim();
if (!adminUri)
  throw new Error(
    "Set ADMIN_DATABASE_URL to the local demo administrator connection.",
  );
const parsed = new URL(adminUri);
if (
  !["postgres:", "postgresql:"].includes(parsed.protocol) ||
  !["localhost", "127.0.0.1"].includes(parsed.hostname) ||
  parsed.port !== "54329" ||
  parsed.pathname !== "/migration_flight_recorder" ||
  parsed.search
) {
  throw new Error(
    "This bootstrap only targets the local demo database on port 54329.",
  );
}
try {
  await access("mcp/.env");
  throw new Error(
    "mcp/.env already exists; refusing to rotate existing credentials.",
  );
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
const admin = new pg.Client({ connectionString: adminUri });
await admin.connect();
const roles = ["mfr_inspector", "mfr_secondary_inspector"];
const database = "mfr_inspection_acceptance";
const passwords = roles.map(() => randomBytes(24).toString("hex"));
try {
  const existing = await admin.query(
    "SELECT rolname FROM pg_roles WHERE rolname = ANY($1)",
    [roles],
  );
  const existingDb = await admin.query(
    "SELECT datname FROM pg_database WHERE datname=$1",
    [database],
  );
  if (existing.rowCount || existingDb.rowCount)
    throw new Error("Setup targets already exist; refusing to overwrite.");
  for (let i = 0; i < roles.length; i++) {
    await admin.query(
      `CREATE ROLE ${roles[i]} LOGIN PASSWORD '${passwords[i]}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`,
    );
    await admin.query(`ALTER ROLE ${roles[i]} SET statement_timeout = '5s'`);
    await admin.query(`ALTER ROLE ${roles[i]} SET lock_timeout = '1s'`);
    await admin.query(
      `ALTER ROLE ${roles[i]} SET default_transaction_read_only = on`,
    );
    await admin.query(`ALTER ROLE ${roles[i]} SET search_path = pg_catalog`);
  }
  // PUBLIC grants are inherited even by NOINHERIT roles. These local-demo
  // revocations are intentional; owners retain access. Do not use unchanged
  // on a shared database without reviewing existing grants.
  await admin.query(
    "REVOKE CONNECT, TEMPORARY ON DATABASE migration_flight_recorder FROM PUBLIC",
  );
  await admin.query(
    "GRANT CONNECT ON DATABASE migration_flight_recorder TO mfr_inspector",
  );
  await admin.query("REVOKE CREATE ON SCHEMA public FROM PUBLIC");
  for (const schema of [
    "auth",
    "app",
    "billing",
    "operations",
    "audit",
    "analytics",
    "control",
  ]) {
    await admin.query(`REVOKE CREATE ON SCHEMA ${schema} FROM PUBLIC`);
    await admin.query(`GRANT USAGE ON SCHEMA ${schema} TO mfr_inspector`);
    await admin.query(
      `GRANT SELECT ON ALL TABLES IN SCHEMA ${schema} TO mfr_inspector`,
    );
    await admin.query(
      `REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA ${schema} FROM PUBLIC`,
    );
    // New objects need explicit review/grants; do not auto-grant future data.
  }
  await admin.query(`CREATE DATABASE ${database}`);
} finally {
  await admin.end();
}

const secondaryUri = new URL(adminUri);
secondaryUri.pathname = `/${database}`;
const secondary = new pg.Client({ connectionString: secondaryUri.toString() });
await secondary.connect();
try {
  await secondary.query(`
    REVOKE CONNECT, TEMPORARY ON DATABASE mfr_inspection_acceptance FROM PUBLIC;
    GRANT CONNECT ON DATABASE mfr_inspection_acceptance TO mfr_secondary_inspector;
    REVOKE CREATE ON SCHEMA public FROM PUBLIC;
    CREATE SCHEMA inventory;
    CREATE TABLE inventory.products(id integer PRIMARY KEY, sku text, quantity integer);
    INSERT INTO inventory.products VALUES (1,'SKU-A',3),(2,'SKU-A',4),(3,NULL,8);
    CREATE SCHEMA private;
    CREATE TABLE private.secrets(id integer);
    INSERT INTO private.secrets VALUES (1);
    CREATE FUNCTION inventory.unsafe_write() RETURNS integer LANGUAGE sql SECURITY DEFINER AS
      'INSERT INTO inventory.products VALUES (99,''unsafe'',0) RETURNING id';
    REVOKE EXECUTE ON FUNCTION inventory.unsafe_write() FROM PUBLIC;
    GRANT USAGE ON SCHEMA inventory TO mfr_secondary_inspector;
    GRANT SELECT ON ALL TABLES IN SCHEMA inventory TO mfr_secondary_inspector;
  `);
} finally {
  await secondary.end();
}
const uris = roles.map((role, i) => {
  const uri = new URL(adminUri);
  uri.username = role;
  uri.password = passwords[i];
  uri.hostname = "host.docker.internal";
  uri.pathname = i === 0 ? "/migration_flight_recorder" : `/${database}`;
  return uri.toString();
});
await mkdir("mcp", { recursive: true });
await writeFile(
  "mcp/.env",
  `PRIMARY_DATABASE_URI=${uris[0]}\nSECONDARY_DATABASE_URI=${uris[1]}\n`,
  { mode: 0o600, flag: "wx" },
);
console.log(
  "Created restricted accounts, independent acceptance database, and private mcp/.env. No existing application data changed.",
);
