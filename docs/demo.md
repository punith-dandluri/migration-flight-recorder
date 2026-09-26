# Demo walkthrough

Use a new session from the saved **migration-flight-recorder** agent. Services from [setup](setup.md) must be running. Review each approval's exact SQL and expected results; cancel if they are wrong. A pending request can be denied without executing anything.

## Inspect and rehearse

```text
Check this migration:
ALTER TABLE app.projects ADD COLUMN description text;
Do not apply it to the original database.
```

The agent should inspect the selected database, preview checks and request native approval for rehearsal. After approval it creates a fresh clone, runs the SQL/checks, reports evidence and confirms the source column is still absent. It must not request target apply for this check-only prompt.

For inspection without any clone, explicitly say `Inspection only; do not rehearse or execute anywhere.`

## Full flow through original-database apply

Use the following only when you intend to change the local demo target. If `url` already exists from a previous successful run, stop; do not automatically drop it or repeat the migration.

```text
Check, rehearse, and after my separate native approval apply this migration
to the original local migration_flight_recorder database:

ALTER TABLE app.projects ADD COLUMN url text;

Confirm the selected database and that url is absent. Record the current
project count. Use atomic-reviewed-v1 for rehearsal. Verify the added
column is named url, has type text and is nullable; exactly one matching
column should exist. Verify the project count is unchanged and all
existing rows have url IS NULL, using the observed count.

Request native approval for rehearsal and report the results. Confirm
the source is unchanged. If all checks pass, request separate native
approval to prepare and restore-test the target backup. Show the exact
SQL, target, fingerprint, backup evidence, risks and plan expiry, then
request a separate native approval for applying that stored plan.

After I approve target apply, report the execution ID, commit outcome,
audit evidence and source verification. This prompt is not execution
approval. Stop on blockers, drift, failed checks or uncertain outcomes;
do not repair SQL or retry automatically.
```

Expected approvals, in order:

1. **Rehearsal:** full local copy and execution on a disposable clone.
2. **Preparation:** retained private backup and restore test; no source migration.
3. **Apply:** real mutation of the original local demo database.

For a fresh fixture the observed project count is 500. The single-column metadata check expects 1, not the table's total number of columns. The final expected state is a nullable text `app.projects.url`, unchanged project count and a recorded committed plan. The service can reject application even after successful rehearsal if data drifted or the plan expired.

## Additional scenarios

| Proposal | Expected evidence/outcome on a fresh fixture |
| --- | --- |
| `ALTER TABLE app.organizations ALTER COLUMN legacy_customer_reference SET NOT NULL;` | BLOCKED: 147 NULLs among 200 organizations. Diagnostic rehearsal only if explicitly requested. |
| `db/scenarios/01_easy_add_project_description.sql` | Nullable-column addition; verify type/nullability, row preservation and source-after state. |
| `02_medium_backfill_billing_email.sql` | Multi-statement backfill and constraint. Synthetic email rule is a demo assumption, not advice for real customer data. |
| `03_high_add_audit_actor_ip_index.sql` | Later statements use a newly created column; current-source checks must use the original JSON expression. Concurrent index is rehearsal-only, not atomic-target eligible. |
| `04_high_widen_deployment_duration.sql` | Type widening; clone success does not prove acceptable production lock/rewrite behavior. |
| `05_destructive_drop_legacy_customer_reference.sql` | Drops 53 populated values on a fresh fixture; requires explicit destructive-impact review. |

Paste file contents into chat. These files are proposals, not automatically applied initialization scripts. They include transaction controls, procedural checks or migration-history INSERTs outside the conservative atomic target profile; use `submitted-transactions` for these complete fixture scenarios. Do not strip statements automatically to make them target-eligible. The simple `url` proposal above is the target-deployment example. No generated example report is shipped as if it were fresh evidence.
