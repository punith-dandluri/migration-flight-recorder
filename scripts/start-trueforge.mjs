import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
const require = createRequire(import.meta.url);
const cli = resolve(
  dirname(require.resolve("@truefoundry/trueforge/package.json")),
  "dist/cli.js",
);
await mkdir("artifacts/trueforge", { recursive: true, mode: 0o700 });
const child = spawn(process.execPath, [cli], {
  stdio: "inherit",
  env: {
    ...process.env,
    HOST: "127.0.0.1",
    PORT: process.env.PORT ?? "8790",
    SQLITE_PATH: resolve("artifacts/trueforge/state.db"),
    OUTBOUND_URL_ALLOWED_HOSTS:
      process.env.OUTBOUND_URL_ALLOWED_HOSTS ?? '["127.0.0.1","localhost"]',
  },
});
child.on("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => child.kill(signal));
