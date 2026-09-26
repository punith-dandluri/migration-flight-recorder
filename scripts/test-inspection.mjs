import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { mkdir, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";

const records = [];
async function connect(port) {
  const client = new Client({ name: "mfr-acceptance", version: "1.0.0" });
  await client.connect(
    new SSEClientTransport(new URL(`http://127.0.0.1:${port}/sse`)),
  );
  return client;
}
async function check(client, name, sql, expected, error = false) {
  const start = Date.now();
  const result = await client.callTool({
    name: "execute_sql",
    arguments: { sql },
  });
  const output = result.content.map((c) => c.text ?? "").join("\n");
  const passed =
    expected.test(output) &&
    (error
      ? /error|denied|not allowed|timeout|timed out|read.only|does not exist/i.test(
          output,
        )
      : !result.isError && !/^Error:/i.test(output));
  records.push({ name, sql, output, elapsedMs: Date.now() - start, passed });
  console.log(`${passed ? "PASS" : "FAIL"} ${name}: ${output.slice(0, 250)}`);
}
const primary = await connect(8001);
const secondary = await connect(8002);
try {
  for (const [client, expected] of [
    [primary, "app"],
    [secondary, "inventory"],
  ]) {
    const tools = await client.listTools();
    for (const name of [
      "list_schemas",
      "list_objects",
      "get_object_details",
      "execute_sql",
    ])
      assert(tools.tools.some((t) => t.name === name));
    const schemas = await client.callTool({
      name: "list_schemas",
      arguments: {},
    });
    assert(JSON.stringify(schemas).includes(expected));
    const objects = await client.callTool({
      name: "list_objects",
      arguments: { schema_name: expected },
    });
    assert(!objects.isError);
    const details = await client.callTool({
      name: "get_object_details",
      arguments: {
        schema_name: expected,
        object_name: expected === "app" ? "organizations" : "products",
      },
    });
    assert(!details.isError);
  }
  await check(
    primary,
    "primary identity",
    "SELECT current_database(), current_user, version()",
    /mfr_inspector/,
  );
  await check(
    primary,
    "five-second database timeout",
    "SHOW statement_timeout",
    /5s/,
  );
  await check(
    primary,
    "known NOT NULL blocker",
    "SELECT count(*) AS total, count(*) FILTER (WHERE legacy_customer_reference IS NULL) AS nulls FROM app.organizations",
    /'total': 200, 'nulls': 147/,
  );
  await check(
    primary,
    "nullable column is not yet present",
    "SELECT count(*) AS existing_columns FROM information_schema.columns WHERE table_schema='app' AND table_name='projects' AND column_name='description'",
    /'existing_columns': 0/,
  );
  await check(
    primary,
    "backfill covers current NULLs",
    "SELECT count(*) AS total, count(*) FILTER (WHERE c.billing_email IS NULL) AS nulls, count(*) FILTER (WHERE c.billing_email IS NULL AND o.id IS NULL) AS unresolved FROM billing.customers c LEFT JOIN app.organizations o ON c.organization_id=o.id",
    /'unresolved': 0/,
  );
  await check(
    primary,
    "proposed billing backfill expression",
    "SELECT count(*) FILTER (WHERE COALESCE(c.billing_email, 'billing+' || o.slug || '@migration-demo.invalid') IS NULL) AS remaining_nulls FROM billing.customers c LEFT JOIN app.organizations o ON c.organization_id=o.id",
    /'remaining_nulls': 0/,
  );
  await check(
    primary,
    "index source evidence without querying future actor_ip",
    "SELECT count(*) AS total, count(*) FILTER (WHERE payload ? 'ip') AS has_ip, count(*) FILTER (WHERE NULLIF(payload->>'ip','') IS NULL) AS no_ip FROM audit.events",
    /'total': 25000/,
  );
  await check(
    primary,
    "audit IP source values can cast",
    "SELECT count(NULLIF(payload->>'ip','')::inet) AS castable FROM audit.events WHERE payload ? 'ip'",
    /'castable': 25000/,
  );
  await check(
    primary,
    "integer widening range",
    "SELECT count(*) AS total, min(duration_ms) AS minimum, max(duration_ms) AS maximum FROM operations.deployment_runs",
    /'total': 2000/,
  );
  await check(
    primary,
    "destructive drop loses existing values",
    "SELECT count(legacy_customer_reference) AS populated FROM app.organizations",
    /'populated': 53/,
  );
  await check(
    primary,
    "column-specific referenced constraints",
    "SELECT count(*) AS referencing_constraints FROM pg_catalog.pg_constraint c JOIN pg_catalog.pg_attribute a ON a.attrelid=c.confrelid AND a.attnum=ANY(c.confkey) WHERE c.confrelid='app.organizations'::regclass AND a.attname='legacy_customer_reference'",
    /'referencing_constraints': 0/,
  );
  await check(
    secondary,
    "second database identity",
    "SELECT current_database(), current_user",
    /mfr_inspection_acceptance/,
  );
  await check(
    secondary,
    "unrelated schema same query tool",
    "SELECT count(*) AS total, count(*) FILTER (WHERE sku IS NULL) AS nulls FROM inventory.products",
    /'total': 3, 'nulls': 1/,
  );
  await check(
    secondary,
    "unique constraint duplicate evidence",
    "SELECT sku, count(*) AS duplicates FROM inventory.products GROUP BY sku HAVING count(*) > 1",
    /'duplicates': 2/,
  );
  await check(
    secondary,
    "missing object error",
    "SELECT count(*) FROM inventory.missing_table",
    /does not exist/i,
    true,
  );
  await check(
    secondary,
    "permission gap error",
    "SELECT * FROM private.secrets",
    /permission denied/i,
    true,
  );
  for (const [name, sql] of [
    ["INSERT", "INSERT INTO inventory.products VALUES (4,'BAD',1)"],
    ["UPDATE", "UPDATE inventory.products SET quantity=0"],
    ["DELETE", "DELETE FROM inventory.products"],
    ["DDL", "ALTER TABLE inventory.products ADD COLUMN unwanted text"],
    [
      "writable CTE",
      "WITH changed AS (DELETE FROM inventory.products RETURNING *) SELECT * FROM changed",
    ],
    [
      "transaction escape",
      "COMMIT; SET default_transaction_read_only=off; DELETE FROM inventory.products",
    ],
    ["role escape", "SET ROLE migration_agent"],
    [
      "configuration escape",
      "SELECT set_config('transaction_read_only','off',false)",
    ],
    ["privileged function", "SELECT inventory.unsafe_write()"],
    ["file read", "SELECT pg_read_file('/etc/passwd')"],
  ])
    await check(
      secondary,
      `blocked ${name}`,
      sql,
      /Error|not allowed|denied|read.only/i,
      true,
    );
  await check(
    secondary,
    "expensive query cancelled",
    "SELECT sum(a.x*b.x) FROM generate_series(1,1000000) a(x) CROSS JOIN generate_series(1,1000000) b(x)",
    /statement timeout|timed out/i,
    true,
  );
  await check(
    secondary,
    "data preserved after attempts",
    "SELECT count(*) AS total, sum(quantity) AS quantity FROM inventory.products",
    /'total': 3, 'quantity': 15/,
  );
} finally {
  await primary.close();
  await secondary.close();
  await mkdir("artifacts", { recursive: true });
  await writeFile(
    "artifacts/mcp-acceptance.json",
    JSON.stringify(
      {
        recordedAt: new Date().toISOString(),
        layer: "MCP integration; agent reasoning tested separately",
        records,
      },
      null,
      2,
    ),
  );
}
assert(
  records.every((r) => r.passed),
  "One or more MCP acceptance checks failed. See artifacts/mcp-acceptance.json.",
);
console.log(`All ${records.length} MCP checks passed.`);
