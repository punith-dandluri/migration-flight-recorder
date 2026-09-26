# Testing

Run from the repository root. Integration suites are operator tools, not model tools; they directly invoke their test services without chat approvals. Run them sequentially while no user rehearsal/deployment is active.

## Without Docker, model or running TrueForge

```sh
npm ci
npm run check
npm test
npm run test:approval
```

`test` covers parser boundaries, source-size rejection, atomic SQL restrictions, explicit checks and the portable manifest. `test:approval` uses the installed TrueForge runtime with fake executors. It verifies pause/deny/exact-argument forwarding/fresh approval for changed arguments and ungated status retrieval. It does not run SQL or auto-approve a real call.

## Docker integration

Complete local database/inspection setup first. The source must still match the fresh demo for fixed-fixture assertions; run these before a real demo migration.

```sh
npm run test:roles
npm run test:bootstrap
npm run test:inspection
npm run test:rehearsal
npm run test:rehearsal:boundaries
npm run test:target
```

- Role checks verify no owner/write/admin privileges for inspection users.
- Bootstrap checks apply the exact baseline, seed and deployment-role SQL to a fresh networkless test container, verify seed counts/ownership/ledger privileges, and remove it. The original database is not accessed.
- Inspection checks cover real results, permission gaps, missing objects, timeout and denied escape/write attempts. Write-denial probes use only the separate synthetic acceptance database.
- Rehearsal checks use fresh clones: nullable addition, backfill, index, widening, destructive drop, known NULL blocker, ordered changes, rollback, partial commit, timeout and denied administration/file access. They compare source snapshots before/after.
- Boundary checks exercise corrupt restore, concurrent-run rejection, interrupted cleanup and strings/procedural blocks containing semicolons.
- Target checks create their own labeled disposable PostgreSQL container. They cover restore-tested backup, expiry, wrong identity, tampering, same-count data drift, apply/ledger/replay, failed-check rollback, SQL-error rollback, destructive rollback, lock timeout and lost commit acknowledgment. They do not use `sandbox/target.env` or write to the original database.

With the rehearsal service running on its default port, additionally run:

```sh
npm run test:rehearsal:mcp
```

This directly requests real clone jobs, tests HTTP boundaries and checks source preservation. Do not use it during an active demo. Service-side tests and CLI calls are trusted-operator execution, not tests of a human clicking approvals.

## Live model routing

After installing the saved agent:

```sh
npm run test:agent
```

This consumes model time (and provider credits if applicable), creates one session and waits up to ten minutes for native rehearsal approval. It **never approves**. The fixture must not already have `app.projects.url`. A passing result validates routing and unchanged SQL, not semantic correctness of the generated postconditions. Inspect the actual requested checks before proceeding.

Private test records are written under ignored `artifacts/`. A full human-approved source deployment is a separate acceptance walkthrough in [demo.md](demo.md); deterministic tests must not be described as proof that it happened.

## Validated package baseline

The source implementation previously passed 14 rehearsal checks. During packaging on 2026-09-26, the clean repository passed syntax validation, five offline tests, all three runtime approval gates, 12 disposable-target checks, and the fresh baseline/seed/deployment-role bootstrap test. Agent creation and update were verified in a separate empty TrueForge instance using a placeholder model, with real MCP tool discovery but no model calls or target mutations. The initializer also refused an existing demo container as intended. A dependency audit reported no known vulnerabilities at that time; this is not a security guarantee.

The packaged default Qwen installation and a full human-approved target walkthrough were not rerun during packaging. Consult your own command results for this checkout and environment; old results are not evidence about a new database or model. No private session exports or database archives are included in the repository.
