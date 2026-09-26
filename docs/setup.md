# Setup from scratch

Run every command from the repository root. This creates a new synthetic local database; it does not connect to a production database. Initial setup changes database permissions and ownership as described below.

## 1. Prerequisites

| Dependency | Requirement |
| --- | --- |
| Node.js and npm | Node 22.14 or later; `.nvmrc` supplies a baseline |
| Docker Desktop | Running, with Compose v2 and the `--wait` option |
| Ollama | Required for the included local-model path; not required if you configure another tool-capable model in TrueForge |
| Git | To clone/version the repository |
| Resources | Docker needs room for the source plus a 2 GiB rehearsal; Qwen additionally requires substantial model memory and a roughly 17 GB download |

The original runtime used macOS on an M4 Pro with 48 GB unified memory, Node 24.11 and Docker 28.5.1. The documented database networking uses Docker Desktop's `host.docker.internal`. Native Linux Docker networking and Windows setup have not been verified; do not assume this localhost configuration works unchanged there. Local `psql`, Python, a cloud account and Daytona are not required. PostgreSQL utilities run inside Docker.

`package-lock.json` locks JavaScript dependencies, including TrueForge 0.2.1. Both Docker images are pinned by digest. The rehearsal runner uses the source container's exact image; its hardening assumes the PostgreSQL Alpine image's user ID 70.

`npm ci` installs these directly used packages; no separate global npm installation is needed:

| Package | Pinned version | Use |
| --- | --- | --- |
| `@truefoundry/trueforge` | 0.2.1 | Local chat/runtime and approval-policy tests |
| `fastmcp` | 3.35.0 | Rehearsal and target MCP HTTP services |
| `@modelcontextprotocol/sdk` | 1.30.1 | Connector integration tests |
| `pg` | 8.23.0 | PostgreSQL setup and transactional target connection |
| `pgsql-parser` | 18.2.8 | PostgreSQL statement boundaries and AST restrictions |
| `zod` | 3.25.76 | MCP argument validation |

The parser uses PostgreSQL 18 grammar; the actual PostgreSQL 16 source/clone is authoritative for syntax compatibility. Installation can require network access and native package build tools if a dependency has no prebuilt binary for your Node/OS combination. On macOS, install Xcode Command Line Tools if npm reports a native compilation failure.

Required free ports: **54329, 8001, 8002, 3002, 3003, 8790**, plus Ollama's **11434**. Stop conflicting services deliberately; do not terminate processes without checking ownership.

## 2. Install and initialize

After cloning/downloading this repository:

```sh
npm ci
npm run setup:local
npm run db:up
```

`setup:local` generates a random administrator password in ignored, mode-0600 `db/.env` and `sandbox/.env`. It refuses existing credentials, demo containers or the named demo volume. Do not copy someone else's `.env`, target token, reports or TrueForge state.

`db:up` initializes the baseline and seed **only on an empty volume**. The database is `migration_flight_recorder`; the container is `migration-flight-recorder-postgres`, bound to `127.0.0.1:54329`. The initial `migration_agent` account is an administrator used by operator setup and read-only exports, never the LLM inspection connector.

Expected initial data includes 200 organizations, 147 NULL `legacy_customer_reference` values, 500 projects and 25,000 audit events. UUIDs and timestamps vary between fresh installations. There is initially no `url` or `description` column on `app.projects`.

**Existing checkout/database:** this bootstrap is not an upgrade or credential recovery tool. Keep using the working checkout until you have reviewed how to transfer its private configuration. Do not run `db:up` from a second checkout against the existing named container/volume, and never remove that volume merely to make setup pass.

## 3. Create restricted inspection access

```sh
npm run setup:inspection
npm run mcp:up
npm run test:roles
npm run test:inspection
```

Setup creates random-password, non-owner inspection accounts and saves their URLs in ignored `mcp/.env`. It grants SELECT on approved tables, revokes public create/temporary-object and unsafe custom-function privileges, and sets a five-second query timeout. Review `scripts/setup-inspection.mjs` before using these permission changes anywhere else. The script refuses existing accounts/configuration; if interrupted, inspect what was created instead of rerunning or resetting blindly.

The primary connector is `http://127.0.0.1:8001/sse`. Port 8002 serves a separate small `mfr_inspection_acceptance` database for duplicate, permission and denied-write tests. It is not attached to the default agent. Both connectors explicitly use `--access-mode=restricted`.

Container startup may take several seconds after `mcp:up` returns. If the inspection test initially reports connection refused, wait for startup and rerun that test; do not rerun account setup.

## 4. Provision local deployment access

Read [the security boundaries](../SECURITY.md) and `sandbox/target-setup.sql` before proceeding. This is a separate operator decision, not agent approval of a migration.

```sh
npm run setup:target -- --reviewed-local-setup
npm run test:roles
```

This creates non-superuser `mfr_executor`, grants privileges on seven application schemas, transfers ownership of their application tables, creates protected `mfr_control.executions`, and writes a generated password to ignored `sandbox/target.env` with mode 0600. PostgreSQL requires ownership for ALTER/DROP. Existing inspection grants remain; the executor cannot update/delete the commit ledger. No application migration is run. There is no automatic ownership rollback.

You may skip this step for inspection/rehearsal only. Target preparation then returns `TARGET_SETUP_REQUIRED`; do not substitute administrator credentials.

## 5. Configure the model

For the included Qwen configuration, install/start Ollama, then:

```sh
ollama pull qwen3.5:27b
ollama create mfr-qwen-27b -f agent/Modelfile
ollama list
```

The derived model fixes context to 16,384 tokens. The installer registers its OpenAI-compatible endpoint at `http://127.0.0.1:11434/v1` using a non-secret placeholder key. Keep Ollama running on the host. This recipe does not put TrueForge in Docker.

Model limitations: expect multi-minute investigations on the tested laptop. Ollama's OpenAI-compatible behavior with reasoning controls can differ from its native API; do not assume `think:false` disables reasoning. A known run generated an incorrect verification count (10 instead of 1). The packaged skill clarifies this case, but that is not proof of reliable reasoning. The upstream model tag is not an immutable model digest.

To use a different tool-capable model, configure it in TrueForge Settings after the next step, then supply its displayed `provider/model` name to `setup:agent -- --model ...`. Review its context/output limits and any external data-transfer implications. Hosted models receive prompts and tool results; database credentials still must not enter prompts.

## 6. Start the three host services

Leave each running in its own terminal, from the repository root:

```sh
# Terminal A
npm run mcp:rehearsal
```

```sh
# Terminal B
npm run mcp:target
```

```sh
# Terminal C
npm run trueforge
```

The first two bind to `127.0.0.1:3002/mcp` and `127.0.0.1:3003/mcp`. Starting the target service creates ignored `sandbox/target-mcp.token` with mode 0600. This is a privileged local secret; do not paste it into chat or commit it.

The wrapper starts pinned TrueForge in local mode on `http://127.0.0.1:8790`, using ignored `artifacts/trueforge/state.db`. It explicitly allows outbound `127.0.0.1`/`localhost` connections so TrueForge can reach the local model and MCP servers; without this allowlist, the default outbound-URL protection rejects these connectors. Other outbound protections remain in place. Local mode has no user-isolation boundary. Do not expose it through a public tunnel or reverse proxy. Startup errors appear in the service's terminal.

## 7. Install the saved agent

In another terminal:

```sh
npm run setup:agent
```

Or, only when you configured another model in TrueForge:

```sh
npm run setup:agent -- --model your-provider/your-model
```

The installer creates the model provider (default path), registers and discovers all three MCP connectors, creates a new saved agent and verifies the native approval policies. It prints the agent's Library URL; open that URL and start a new chat. It does not depend on an existing agent ID and does not run a migration.

The instructions are loaded from `agent/skills/check-postgres-migration/SKILL.md` into the manifest. This TrueForge setup does not load local skill folders through its hosted skill registry. Native sandbox, dynamic subagents and conversational approval-question tools are disabled; native MCP approval gates remain enabled. The current model tuning is in `agent/manifest.json`.

An existing agent/connector is not overwritten by default. After reviewing your local changes, run `npm run setup:agent -- --update` to replace this named agent/connectors; it saves the previous agent privately. Supply `--model` again if you use a custom model. Start a **new** session after updating; old sessions retain their old configuration.

## 8. Verify and try a migration

```sh
npm run check
npm test
npm run test:approval
npm run test:target
```

The last command writes only to its own disposable test database. Follow [Testing](testing.md) for the remaining suites, then [Demo walkthrough](demo.md). Native human approvals are still required for every real rehearsal, backup preparation and target apply.

For alternative host-service ports, set `PORT` for TrueForge and the corresponding `TRUEFORGE_URL` for installation/tests. Set `MFR_REHEARSAL_PORT` and `MFR_TARGET_PORT` consistently on their services **and** the installer. Source database name/port/container remain fixed; these settings do not enable arbitrary target URLs.
