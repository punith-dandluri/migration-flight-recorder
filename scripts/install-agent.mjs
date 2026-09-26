import { mkdir, readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { api, base } from "./trueforge-api.mjs";
import { agentManifest, assertApprovalPolicy } from "./agent-config.mjs";

const { values } = parseArgs({
  options: {
    update: { type: "boolean", default: false },
    model: { type: "string" },
  },
});
const name = "migration-flight-recorder";
const rehearsalPort = Number(process.env.MFR_REHEARSAL_PORT ?? 3002);
const targetPort = Number(process.env.MFR_TARGET_PORT ?? 3003);
if (
  ![rehearsalPort, targetPort].every(
    (p) => Number.isInteger(p) && p >= 1024 && p <= 65535,
  )
)
  throw new Error("Invalid connector port");
const agents = (await api(`/agents?agent_name=${name}&limit=100`)).data;
const existing = agents.find((agent) => agent.name === name);
if (existing && !values.update)
  throw new Error(
    "Agent already exists. Use --update only after reviewing local configuration changes.",
  );
const token = (await readFile("sandbox/target-mcp.token", "utf8")).trim();
if (!/^[a-f0-9]{64}$/.test(token))
  throw new Error(
    "Start npm run mcp:target first to generate its connector token.",
  );

await mkdir("artifacts/agent-backups", { recursive: true, mode: 0o700 });
if (existing) {
  const previous = (await api(`/agents/${existing.id}`)).data;
  await writeFile(
    `artifacts/agent-backups/${Date.now()}.json`,
    JSON.stringify(previous, null, 2),
    { mode: 0o600 },
  );
}
if (!values.model) {
  const providers = (await api("/settings/model-providers")).data;
  const provider = providers.find((p) => p.manifest.name === "ollama-local");
  if (provider) {
    const model = provider.manifest.models.find(
      (m) => m.name === "qwen3-5-27b-local",
    );
    if (
      !model ||
      provider.manifest.base_url !== "http://127.0.0.1:11434/v1" ||
      model.model_id !== "mfr-qwen-27b"
    ) {
      throw new Error(
        "An incompatible ollama-local provider exists. Choose its configured FQN with --model, or review it in TrueForge Settings. No provider was overwritten.",
      );
    }
  } else {
    const response = await fetch("http://127.0.0.1:11434/api/tags", {
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok)
      throw new Error(
        "Ollama is unavailable. Follow docs/setup.md before registering the agent.",
      );
    const tags = await response.json();
    if (
      !tags.models?.some(
        (m) => m.name === "mfr-qwen-27b:latest" || m.name === "mfr-qwen-27b",
      )
    )
      throw new Error(
        "Create the mfr-qwen-27b model with agent/Modelfile first.",
      );
    await api("/settings/model-providers", {
      manifest: {
        type: "custom",
        name: "ollama-local",
        base_url: "http://127.0.0.1:11434/v1",
        auth: { api_key: "ollama-local-no-auth" },
        models: [
          {
            name: "qwen3-5-27b-local",
            model_id: "mfr-qwen-27b",
            properties: { context_length: 16384, max_output_tokens: 4096 },
          },
        ],
      },
    });
  }
}

const connectors = [
  {
    type: "remote",
    name: "postgres-demo-readonly",
    url: "http://127.0.0.1:8001/sse",
    description: "Restricted inspection of the local migration demo.",
  },
  {
    type: "remote",
    name: "local-docker-rehearsal",
    url: `http://127.0.0.1:${rehearsalPort}/mcp`,
    description:
      "Approval-gated full-copy local Docker rehearsal; no source writes.",
  },
  {
    type: "remote",
    name: "approved-local-target",
    url: `http://127.0.0.1:${targetPort}/mcp`,
    description:
      "Separately approved backup preparation and transactional local deployment.",
    auth: { type: "header", headers: { Authorization: "Bearer " + token } },
  },
];
const configured = (await api("/settings/mcp-servers")).data;
if (
  !values.update &&
  configured.some((c) => connectors.some((w) => w.name === c.manifest.name))
) {
  throw new Error(
    "A connector name is already in use. Review Settings before using --update; no connector was overwritten.",
  );
}
for (const manifest of connectors) {
  await api(
    "/settings/mcp-servers",
    { manifest },
    values.update ? "PUT" : "POST",
  );
  await api(`/mcp-servers/${manifest.name}/tools`);
}
const manifest = await agentManifest(values.model);
assertApprovalPolicy(manifest);
const payload = {
  description:
    "Inspect PostgreSQL migrations, rehearse on disposable clones, and apply reviewed local plans through separate native approvals.",
  manifest,
};
const agent = existing
  ? (await api(`/agents/${existing.id}`, payload, "PUT")).data
  : (await api("/agents", { name, ...payload })).data;
assertApprovalPolicy((await api(`/agents/${agent.id}`)).data.manifest);
await writeFile(
  "artifacts/agent-install.json",
  JSON.stringify(
    { base, agentId: agent.id, model: manifest.model.name },
    null,
    2,
  ),
  { mode: 0o600 },
);
console.log(
  `Installed ${name}: ${base}/library/${agent.id}?agentId=${agent.id}&tab=overview`,
);
console.log(
  "Start a new session from this saved agent. Existing sessions keep their previous policies.",
);
