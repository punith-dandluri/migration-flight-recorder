import { randomBytes } from "node:crypto";
import { access, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";

const docker = spawnSync("docker", ["info"], { stdio: "ignore" });
if (docker.status !== 0)
  throw new Error("Docker must be installed and running before local setup.");
for (const [kind, name] of [
  ["container", "migration-flight-recorder-postgres"],
  ["volume", "migration-flight-recorder-db_migration-flight-recorder-db-data"],
]) {
  if (
    spawnSync("docker", [kind, "inspect", name], { stdio: "ignore" }).status ===
    0
  ) {
    throw new Error(
      `Existing demo ${kind} detected. Do not initialize a second checkout against it; see docs/setup.md.`,
    );
  }
}

for (const file of ["db/.env", "sandbox/.env"]) {
  try {
    await access(file);
  } catch (error) {
    if (error.code === "ENOENT") continue;
    throw error;
  }
  throw new Error(`${file} already exists. Refusing to replace credentials.`);
}
const password = randomBytes(32).toString("hex");
await writeFile("db/.env", `POSTGRES_PASSWORD=${password}\n`, {
  mode: 0o600,
  flag: "wx",
});
await writeFile(
  "sandbox/.env",
  `REHEARSAL_SOURCE_URL=postgresql://migration_agent:${password}@127.0.0.1:54329/migration_flight_recorder\n`,
  { mode: 0o600, flag: "wx" },
);
console.log(
  "Created private local database configuration. Next: npm run db:up",
);
