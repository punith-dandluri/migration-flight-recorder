import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { agentManifest, assertApprovalPolicy } from "./agent-config.mjs";
const require = createRequire(import.meta.url);
const { ToolSet } = require("@truefoundry/trueforge-core/core/mcp/ToolSet.js");
const manifest = await agentManifest();
assertApprovalPolicy(manifest);
for (const connector of manifest.mcp_servers.filter(
  (c) => c.name !== "postgres-demo-readonly",
)) {
  const calls = [];
  const source = {
    name: connector.name,
    id: connector.name,
    listTools: async () => ({
      result: { tools: connector.enable_tools.map((name) => ({ name })) },
    }),
    toolCallInfo: async (params) => ({
      name: params.name,
      arguments: params.arguments,
    }),
    callTool: async (params) => {
      calls.push(params);
      return { result: { content: [] } };
    },
  };
  const tools = new ToolSet({
    source,
    preload: true,
    selectors: {
      enableTools: connector.enable_tools,
      disableTools: [],
      preloadTools: [],
      requireApprovalForTools: connector.require_approval_for_tools,
    },
  });
  for (const name of connector.require_approval_for_tools.filter(
    (name) => !name.startsWith("@"),
  )) {
    const params = { name, arguments: { test: "fake-executor-only" } };
    const before = calls.length;
    assert((await tools.callTool(params)).approvalRequired);
    assert.equal(calls.length, before);
    await tools.callTool(params, { status: "deny" });
    assert.equal(calls.length, before);
    await tools.callTool(params, { status: "allow" });
    assert.deepEqual(calls.at(-1), params);
    assert(
      (await tools.callTool({ ...params, arguments: { test: "changed" } }))
        .approvalRequired,
    );
    assert.equal(calls.length, before + 1);
    console.log(
      `PASS ${name}: pause, denial, exact approved arguments, fresh approval for changed arguments`,
    );
  }
  const before = calls.length;
  await tools.callTool({
    name: connector.enable_tools.find((name) => name.startsWith("get_")),
    arguments: {},
  });
  assert.equal(calls.length, before + 1);
}
console.log(
  "Approval policy passed against the installed TrueForge runtime. Fake executors only; no SQL or model calls.",
);
