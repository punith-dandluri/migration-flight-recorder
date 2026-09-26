import { readFile } from "node:fs/promises";
import { runRehearsal, cleanupInterrupted } from "./rehearsal.mjs";
if (process.argv[2] === "--cleanup") {
  console.log(JSON.stringify(await cleanupInterrupted(), null, 2));
} else {
  const file = process.argv[2];
  const checkFile = process.argv[3];
  if (!file)
    throw new Error("Usage: npm run rehearse -- migration.sql [checks.json]");
  const result = await runRehearsal({
    proposedSql: await readFile(file, "utf8"),
    checks: checkFile ? JSON.parse(await readFile(checkFile, "utf8")) : [],
  });
  console.log(
    JSON.stringify(
      {
        runId: result.runId,
        status: result.report.status,
        execution: result.report.execution.status,
        verification: result.report.verification.status,
        directory: result.directory,
      },
      null,
      2,
    ),
  );
  if (result.report.status !== "REHEARSAL_COMPLETED") process.exitCode = 1;
}
