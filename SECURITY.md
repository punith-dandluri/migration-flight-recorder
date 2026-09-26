# Security boundaries

This is a local, single-operator demo. Do not expose TrueForge or the MCP services publicly, connect them to production, or treat local connectors as isolated user accounts.

## Approval and credentials

TrueForge enforces approval on rehearsal, backup preparation and target apply. The service itself trusts the local operator/runtime; direct CLI calls bypass the chat approval workflow. The target service uses a bearer token, rejects browser-origin requests and checks its loopback Host. The rehearsal service checks origin/Host but is not independently authenticated. Local processes and administrators are inside the trust boundary.

An approval covers exactly the pending arguments. Rehearsal approval is not permission to change the source. Backup preparation is not target approval. Changed SQL/checks, a new attempt, expired plans or drift require fresh review. Never implement automatic approval or retries to make a demo pass.

Generated credentials are mode 0600 and Git-ignored. The export account is powerful in this local setup even though export sessions force read-only mode. Do not give its connection string to the model or a clone. The deployment role owns application tables and can change their schema/data; its secret is therefore privileged. The target token also signs stored plans. Preserve it with private execution state; rotating it invalidates existing plan signatures.

## Target execution limits

The atomic profile supports a reviewed subset of schema-qualified ALTER TABLE, ordinary CREATE INDEX, UPDATE, DELETE, TRUNCATE without sequence reset, and DROP TABLE/INDEX without CASCADE. It rejects explicit transaction controls, INSERT/sequence manipulation, concurrent indexes, dynamic code, functions/admin operations and unreviewed expressions/types/operators.

Existing views/materialized views, partitions, foreign tables, RLS, user triggers/rules, domains and custom casts/operators cause execution-environment checks to fail closed. Unsupported cases require manual review, not bypasses. Rehearsal has a broader SQL surface but remains disposable and does not authorize promotion to the target.

Target apply uses an advisory lock and ACCESS EXCLUSIVE locks on application tables. This intentionally broad locking is only suitable for the small demo. Lock timeout is two seconds, statement timeout thirty seconds and apply deadline ten minutes. Do not run simultaneous administrative DDL or standalone sequence operations: relation locks do not globally freeze those operations.

Destructive changes need measured clone impact and explicit user acceptance. Counts and hashes do not establish business acceptability. Backups are restore-tested but not automatically restored to the target; point-in-time recovery, permission fidelity, recovery downtime and production traffic are not validated.

## Isolation and model limitations

Docker access on the host is privileged. The model gets narrow MCP tools, not Docker commands. SQL executes as a non-superuser in a networkless clone, but this project is not a sandbox for hostile untrusted tenants or a replacement for database patching. Temporary storage, memory, timeouts and SQL restrictions can still make legitimate proposals unsupported.

The model can miss dependencies, misinterpret data or invent expected values. Require query-backed findings, inspect verification SQL and expected results, and never equate `NO_BLOCKERS_FOUND` or clone success with production safety. Empty metadata may reflect permissions. Application-code dependencies and business requirements are outside database-only inspection.

## Private evidence and publication

Never commit `.env` files, `*.env`, `*.token`, `*.dump`, `artifacts/`, database volumes or provider keys. Do not upload actual customer data as a bug report. Use the synthetic fixture and redact private paths/identifiers from logs.

Before publishing changes, inspect `git status`, staged diffs and the actual staged file list. Run the tests and review dependency audit results. Git ignore rules do not remove secrets already committed; a leaked credential must be revoked, not merely deleted from the latest revision.
