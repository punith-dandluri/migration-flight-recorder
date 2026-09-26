import { readFile } from "node:fs/promises";

export const base = process.env.TRUEFORGE_URL ?? "http://127.0.0.1:8790";
const url = new URL(base);
if (
  !["localhost", "127.0.0.1"].includes(url.hostname) ||
  url.protocol !== "http:" ||
  url.username ||
  url.password ||
  url.pathname !== "/" ||
  url.search ||
  url.hash
) {
  throw new Error(
    "TRUEFORGE_URL must be a local HTTP origin, without credentials or a path.",
  );
}
export async function api(path, body, method = "POST") {
  const response = await fetch(
    base + "/api/v1" + path,
    body === undefined
      ? { signal: AbortSignal.timeout(60000) }
      : {
          method,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(60000),
        },
  );
  if (!response.ok)
    throw new Error(
      `TrueForge ${method} ${path}: HTTP ${response.status}. Check its local logs; response omitted to protect credentials.`,
    );
  return response.json();
}
export async function installedAgent() {
  const state = JSON.parse(
    await readFile("artifacts/agent-install.json", "utf8"),
  );
  if (state.base !== base)
    throw new Error("Agent was installed on a different TRUEFORGE_URL.");
  return (await api(`/agents/${state.agentId}`)).data;
}
