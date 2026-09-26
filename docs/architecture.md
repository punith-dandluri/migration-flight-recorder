# Architecture

TrueForge provides the UI, model loop, session traces and tool approval gates. The PostgreSQL connector supplies read-only discovery/query tools. Two small Node services implement deterministic execution boundaries.

| Component | Access | Responsibility |
| --- | --- | --- |
| Inspection MCP, port 8001 | Restricted SELECT account | Discover relevant objects and run evidence queries |
| Rehearsal MCP, port 3002 | Operator-configured export account; local Docker | Consistent archive, isolated restore, migration/check execution, reports and cleanup |
| Target MCP, port 3003 | Private bearer token; separately configured `mfr_executor` | Restore-tested backup, immutable plan, transactional application and ledger reconciliation |
| TrueForge, port 8790 | Local operator UI | Decide tool calls and pause gated calls for human approval |

The model receives neither source/deployment passwords nor arbitrary Docker or shell access. SQL comments, data values and tool outputs are untrusted data, not instructions or approval.

## Tool contracts

The agent preloads four inspection tools: `list_schemas`, `list_objects`, `get_object_details`, `execute_sql`. It selects relevant SQL dynamically. There is no single-operation NOT NULL parser limiting investigation.

`rehearse_migration({sourceId, proposedSql, executionProfile, checks})` accepts only `sourceId: "migration_flight_recorder"`. A check is `{name, sql, expectedRows}`. It returns a job ID; `get_rehearsal_report({jobId})` reports progress and evidence. `COMPLETED` means a report exists, not that the SQL or checks passed.

Each rehearsal:

1. Confirms source identity/size and exports a consistent full archive using PostgreSQL utilities from the source container.
2. Restores into a fresh container using the exact source image, remapping objects to sandbox-only roles. A failed restore prevents execution.
3. Parses SQL with the PostgreSQL parser, preserving strings and procedural blocks; executes sequentially in one session and stops on error.
4. Captures statement timing/results, errors, transaction outcomes, schema/count changes, invalid indexes and explicit postconditions.
5. Removes run-owned ephemeral containers/archives and retains private JSON/Markdown reports.

The clone has no network or published ports, no host/Docker-socket mounts, 2 CPUs, 2 GiB memory, a read-only root filesystem and a ten-minute job limit. Only one rehearsal runs at a time. Sources larger than 1 GiB are rejected; no silent sampling. Temporary database storage is also bounded, so a sub-1-GiB source may still fail if its migration needs more space.

Two profiles exist:

- `submitted-transactions`: preserves submitted transaction boundaries, including nontransactional concurrent-index workflows. Reports partial commits. Not eligible for target deployment.
- `atomic-reviewed-v1`: validates a conservative SQL subset, runs one transaction and verifies postconditions before commit. Required for target deployment.

`prepare_target_migration({rehearsalRunId})` requires a successful atomic rehearsal with passed checks and complete cleanup. After its own approval, it compares the target to the rehearsal baseline, creates/restores a retained backup and verifies logical fingerprints. It returns an execution ID for polling with `get_target_execution`. Successful preparation produces a signed plan with a 15-minute expiry; it does not apply SQL.

`apply_target_migration({planId})` has a separate approval. It accepts only a stored plan ID, never replacement SQL or a database URL. It checks plan integrity, backup integrity, target identity, drift and replay state, then locks the application tables and applies the exact SQL in a transaction. Checks and invalid-index validation precede commit. The commit ledger is inserted in that same transaction.

## Evidence and outcomes

Fingerprints cover logical schema, constraints, indexes, table contents/counts, populated-column counts and sequence state. Clone-remapped owners and physical IDs are excluded. They detect value changes even when row counts match, but cannot explain whether changes satisfy business intent.

Inspection returns `BLOCKED`, `INCONCLUSIVE` or `NO_BLOCKERS_FOUND`. Rehearsal reports execution and verification separately. Target outcomes include `COMMITTED`, `ROLLED_BACK`, `PRECONDITION_FAILED`, `OUTCOME_UNKNOWN` and verification-incomplete status. A lost commit acknowledgment is not reported as rollback and is never automatically retried; the service reconciles from its ledger.

`artifacts/rehearsals/` stores SQL, reports and retained verified backups; `artifacts/rehearsal-jobs/` stores job state; `artifacts/target-execution/` stores plans, claims and execution records. TrueForge traces are an additional evidence record. Do not publish these directories: reports can contain schema and data.

Read [SECURITY.md](../SECURITY.md) before granting deployment access.
