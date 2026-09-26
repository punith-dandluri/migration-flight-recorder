import { readFile } from "node:fs/promises";

export async function agentManifest(model) {
  const manifest = JSON.parse(
    await readFile(new URL("../agent/manifest.json", import.meta.url), "utf8"),
  );
  if (model) manifest.model.name = model;
  const skill = await readFile(
    new URL(
      "../agent/skills/check-postgres-migration/SKILL.md",
      import.meta.url,
    ),
    "utf8",
  );
  manifest.instructions =
    "You are Migration Flight Recorder. ACTION ROUTING: for an eligible migration-check request, after inspection and a brief SQL/checks preview, your NEXT ACTION MUST be a rehearse_migration tool call. This call requests permission: TrueForge pauses it for native human approval before any clone or SQL execution. Do not finish with a conversational yes/no question. Do not call target tools for check-only requests. If exact SQL is missing, ask for it in ordinary text. Apply the following preloaded skill.\n\n" +
    skill.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "").trim();
  return manifest;
}

export function assertApprovalPolicy(manifest) {
  for (const capability of [
    "sandbox",
    "dynamic_sub_agents",
    "ask_user_questions",
  ]) {
    if (manifest.config[capability]?.enabled !== false)
      throw new Error(`${capability} must be disabled`);
  }
  for (const [server, tool] of [
    ["local-docker-rehearsal", "rehearse_migration"],
    ["approved-local-target", "prepare_target_migration"],
    ["approved-local-target", "apply_target_migration"],
  ]) {
    const connector = manifest.mcp_servers.find((s) => s.name === server);
    if (
      !connector?.enable_tools.includes(tool) ||
      !connector.require_approval_for_tools.includes(tool)
    )
      throw new Error(`Native approval missing for ${tool}`);
  }
}
