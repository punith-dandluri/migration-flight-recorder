# Troubleshooting and shutdown

| Symptom | Check / response |
| --- | --- |
| Site cannot be reached | Start `npm run trueforge`; read its terminal for a port conflict or startup error. The MCP endpoints are not web pages. |
| Inspection cannot connect | Check Docker is running, `npm run db:up` health and `npm run mcp:up`. URLs inside MCP containers use `host.docker.internal`, not container-local localhost. |
| Installer reports duplicate names | Review the existing named agent/provider/connectors. Use `--update` only deliberately. A second checkout may point at a different target token/evidence directory. |
| `Outbound URL blocked` during registration | Use `npm run trueforge`, whose wrapper allows the required localhost endpoints. If starting TrueForge another way, explicitly configure its local-host outbound allowlist; do not disable all URL protections. |
| Tools missing or agent uses a shell | Start a fresh chat from the saved agent's Library page. Old/generic sessions have different configurations. |
| Agent asks conversational yes/no | Reinstall the current saved manifest, start a new session and confirm native approval selectors. No separate approval tool is required. |
| Expected check is incorrect | Deny the pending request. Ask for corrected verification based on actual evidence and a new approval. Do not edit a signed target plan. |
| Model is slow or returns empty normal output | Check Ollama model/context/memory; reasoning may consume its output budget. Do not infer tool success from elapsed time or automatically repeat execution. |
| `TARGET_SETUP_REQUIRED` | Review and perform the operator deployment setup; do not supply administrator credentials to the agent. |
| `BUSY` or a rehearsal lock exists | Retrieve the existing job. After a crash, inspect its records and process/container ownership before `npm run rehearsal:cleanup`. Never delete the lock during an active run. |
| Expiry / drift | Stop. Rehearse or prepare again as required and obtain fresh approvals. Do not bypass comparison checks. |
| `OUTCOME_UNKNOWN` | Preserve plan/claim/backup/ledger evidence. Retrieve status for ledger reconciliation; never retry automatically. |
| Restore/storage/unsupported SQL failure | Report the failed evidence. The clone has bounded storage and no network; there is no silent sampling or fallback to the source. |

## Stop without deleting data

Stop the host-service terminals with Ctrl-C. Do not interrupt an active apply without understanding that its commit outcome may need reconciliation. Then:

```sh
npm run mcp:stop
npm run db:stop
```

These commands retain the source volume, generated credentials, TrueForge state and reports. Resume with `npm run db:up`, `npm run mcp:up`, and the three host services. Do not rerun credential initialization.

There is intentionally no one-command destructive reset. Removing the named database volume loses the original database, including applied migrations and its audit ledger. Deleting `artifacts/` loses backups, plan claims and local TrueForge history. Treat either as a separate operator decision, and do not reset just to get tests passing.

## Direct rehearsal CLI

For deliberate operator-only clone testing:

```sh
npm run rehearse -- db/scenarios/01_easy_add_project_description.sql sandbox/example-checks.json
```

This CLI directly runs a rehearsal without TrueForge approval. The default submitted-transaction profile is not eligible for target apply. It never provides a general target execution CLI. See `report.json` and `report.md` under the printed private run directory.
