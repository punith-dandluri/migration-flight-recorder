# Migration Flight Recorder

Inspect a proposed PostgreSQL migration, test it on a disposable database copy, and apply a reviewed plan to the local target through separate human approvals.

TrueForge is the chat interface and agent runtime. The model selects read-only inspection queries; deterministic services handle cloning, SQL execution, verification, backups and deployment. There is no separate application UI and no Daytona requirement.

## What works

- Schema and data inspection through Crystal DBA Postgres MCP with a restricted database account.
- Multi-statement proposals, real query evidence and explicit evidence gaps.
- Full-copy Docker rehearsals with statement results, postconditions, schema/data fingerprints and cleanup.
- Three native approval gates: rehearsal, backup preparation, target apply.
- Transactional local deployment with a restore-tested backup, drift checks, expiring signed plans and a commit ledger.

**Scope:** inspection can use other PostgreSQL connectors. Rehearsal and deployment are deliberately restricted to the bundled `migration_flight_recorder` demo database. This is a local, single-operator project, not a production deployment service or multi-user credential vault. A successful rehearsal is not a production-safety guarantee.

## Start here

Follow **[Setup from scratch](docs/setup.md)**. It covers prerequisites, generated credentials, database seeding, model installation, connector services and creation of the saved TrueForge agent. Nothing depends on the original author's accounts, agent IDs or private files.

Then use **[Demo walkthrough](docs/demo.md)** for a check-only prompt and the full approved deployment flow. Start chat from the saved **migration-flight-recorder** agent, not the generic TrueForge homepage.

```text
User SQL → read-only inspection → approval → cloned-database rehearsal
                                      ↓
                          evidence and explicit checks
                                      ↓
                   approval → create and restore-test backup
                                      ↓
                   approval → apply exact plan to local target
```

The bundled model configuration uses Qwen 3.5 27B through Ollama with a 16K context, temperature 0 and serial tool calls. Model quality is not deterministic: it has produced incorrect expected verification values and can be slow. Review the SQL and expected results in every approval. The deterministic test suite does not certify the model's reasoning.

## Repository map

| Path | Purpose |
| --- | --- |
| `agent/` | Saved-agent template, model settings and authoritative migration skill |
| `db/` | Synthetic PostgreSQL schema, seed data and example proposals |
| `mcp/` | Pinned, restricted inspection connectors |
| `sandbox/` | Reviewed deployment-role SQL and example verification checks |
| `scripts/` | Setup, MCP services, rehearsal/deployment engine and integration tests |
| `tests/` | Offline parser, policy and configuration checks |
| `docs/` | Setup, architecture, safety boundaries, tests and troubleshooting |
| `artifacts/` | Generated private evidence and local TrueForge state; never committed |

## Development

```sh
npm ci
npm run check
npm test
npm run test:approval
```

These checks do not require a model or a database. See [Testing](docs/testing.md) for Docker integration suites and the optional live-model routing test. Run integration suites sequentially, never during an active user rehearsal or deployment.

The earlier prototype, native-sandbox experiments, private reports, credentials and historical session exports are intentionally excluded.

## Further reading

- [Architecture and tool contracts](docs/architecture.md)
- [Security boundaries and deployment limitations](SECURITY.md)
- [Troubleshooting and shutdown](docs/troubleshooting.md)
- [TrueForge](https://github.com/truefoundry/trueforge), [Postgres MCP](https://github.com/crystaldba/postgres-mcp), [Ollama](https://docs.ollama.com/)

No license has been selected for this project's own code yet. Add the intended license before public distribution; dependencies retain their respective licenses.
