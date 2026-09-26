import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { api, base, installedAgent } from "./trueforge-api.mjs";
import { assertApprovalPolicy } from "./agent-config.mjs";

const agent = await installedAgent();
assertApprovalPolicy(agent.manifest);
const session = (await api("/sessions", { agent: { spec: agent.manifest } }))
  .data;
const sql = "ALTER TABLE app.projects ADD COLUMN url text;";
let turn = (
  await api(`/sessions/${session.id}/turns`, {
    input: [
      {
        type: "user.message",
        content: `Check whether this migration is possible: ${sql}`,
      },
    ],
    stream: false,
  })
).data;
console.log(`Review pending request: ${base}/sessions/${session.id}`);
const deadline = Date.now() + 600000;
while (turn.state.status === "running" && Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 15000));
  turn = (await api(`/sessions/${session.id}/turns/${turn.id}`)).data;
}
const events = [];
let token;
do {
  const page = await api(
    `/sessions/${session.id}/turns/${turn.id}/events?limit=100${token ? "&page_token=" + encodeURIComponent(token) : ""}`,
  );
  events.push(...page.data);
  token = page.pagination?.next_page_token;
} while (token);
await mkdir("artifacts/agent-tests", { recursive: true, mode: 0o700 });
await writeFile(
  `artifacts/agent-tests/${session.id}.json`,
  JSON.stringify({ sessionId: session.id, turn, events }, null, 2),
  { mode: 0o600 },
);
assert(
  turn.state.required_actions?.some(
    (action) => action.type === "tool.approval_required",
  ),
  "Native approval was not reached; inspect the saved trace. No approval was submitted.",
);
const requested = events
  .flatMap((event) => event.tool_calls ?? [])
  .find((call) => call.function?.name === "rehearse_migration");
assert(requested);
assert.equal(JSON.parse(requested.function.arguments).proposedSql, sql);
assert(
  !events.some(
    (event) =>
      event.type === "tool.response" && event.tool_call_id === requested.id,
  ),
);
console.log(
  "PASS: native approval reached with unchanged SQL and no rehearsal execution.",
);
console.log(
  "This tests routing, not correctness of model-generated checks. Review every expected result before approving.",
);
