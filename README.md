# Shortleash

Shortleash is an oh-my-pi extension and standalone runner for multi-agent orchestration. Define a pipeline, parallel fan-out, sequential chain, or arbitrary acyclic dependency graph in JSON or YAML. Each declared agent runs as an oh-my-pi worker with the tools available to that host; the orchestrator owns ordering, persistence, policy boundaries, and recovery.

The implementation deliberately keeps the product name **Shortleash** separate from the definition format: the top-level configuration key is `swarm` because that is the parser contract, while Beads stores the same definition under `metadata.shortleash`.

## Setup

Requirements:

- Bun `>=1.3.14`.
- oh-my-pi `^17` when loading the extension in the TUI.
- Herdr is optional at runtime. It is used by default for declared-agent TUI runs when available.

From this repository root:

```bash
bun install
bun run check
```

The package declares the `omp-shortleash` binary and the `./src/extension.ts` OMP extension entrypoint. When the package is linked or installed, use `omp-shortleash`; from a checkout, `bun run src/cli.ts` is equivalent.

## Running

### Standalone CLI

The standalone runner executes declared agents without a TUI or Herdr session:

```bash
# Run a JSON/YAML definition until it completes or fails.
bun run src/cli.ts path/to/swarm.yaml

# The package bin has the same interface after it is installed or linked.
omp-shortleash path/to/swarm.yaml

# A Beads ID or issue:// reference is also accepted.
omp-shortleash shrtlsh-123
omp-shortleash issue://shrtlsh-123
```

A definition without `agents` is a current-session execution and must be run from the OMP TUI; the standalone CLI rejects it because it has no current conversation to continue.

The CLI commands are:

```text
omp-shortleash <file.json|file.yaml|beads-id> [--resume|--restart]  run
omp-shortleash plan <file.json|file.yaml|beads-id> [--json]         validate and inspect
omp-shortleash inspect <file.json|file.yaml|beads-id> [--json]      alias for plan
omp-shortleash status <name> [--json]                               read persisted state
omp-shortleash evaluate <file.json|file.yaml|beads-id> [--json]     evaluate persisted results
omp-shortleash reconcile <beads-id|issue://beads-id> [--json]       check Beads drift
omp-shortleash dashboard <file.json|file.yaml|beads-id>             render the terminal dashboard
```

`--json` prints structured output for `plan`, `status`, `evaluate`, and `reconcile`; a run also prints a final JSON envelope when `--json` is supplied. `dashboard` renders the live terminal view and stops when the persisted run reaches a terminal state.

### Resume and restart

Shortleash persists state under the configured workspace. A second run never silently overwrites an existing run:

```bash
# Continue an unfinished run after a host/process restart.
omp-shortleash path/to/swarm.yaml --resume

# Intentionally discard the previous in-memory run state and start again.
omp-shortleash path/to/swarm.yaml --restart
```

`--resume` requires the persisted definition hash, workspace, mode, `target_count`, and agent set to remain compatible. Successful results already recorded for the unfinished iteration are reused; missing or failed work runs again. A stale valid `run.lock` is recoverable only with `--resume` or `--restart`; a corrupt lock is never removed automatically. A completed run requires `--restart` rather than `--resume`.

`evaluate` reads the persisted results and runs the configured policy evaluators without starting agents. A blocked decision exits non-zero and is stored in the state; it does not silently mark the pipeline complete.

### OMP TUI

Load the extension in project settings (`.omp/settings.json`) or user settings (`~/.omp/agent/settings.json`):

```json
{
  "extensions": [
    "/absolute/path/to/shortleash/src/extension.ts"
  ]
}
```

Then use:

```text
/shortleash run path/to/swarm.yaml [--resume|--restart]
/shortleash run shrtlsh-123
/shortleash run issue://shrtlsh-123
/shortleash plan path/to/swarm.yaml
/shortleash inspect path/to/swarm.yaml
/shortleash status <name> [--json]
/shortleash evaluate path/to/swarm.yaml [--json]
/shortleash reconcile shrtlsh-123 [--json]
/shortleash help
```

`plan` and `inspect` validate and display the executable plan. `reconcile` requires a Beads input. When the current Beads workspace has open issues with valid `metadata.shortleash`, argument completion suggests `run issue://<id>` entries and filters them by Bead ID, title, or Shortleash name.

### Dashboard controls

While a TUI run is active, Shortleash renders a compact widget below the editor. Press `Alt+W` to open the animated dashboard overlay.

- `c`, `Ctrl+C`, or `x`: request cancellation.
- `q`, `Esc`, or `Alt+W`: close the overlay without cancelling.
- `j`/`k`: scroll one line; `h`/`l`: scroll one page.

Closing the overlay does not stop the run.

## Execution backends

- `agent_execution: herdr` is the default for definitions with declared agents in the TUI. Shortleash creates one Herdr tab with a dashboard pane, creates one pane per runnable agent in the current DAG wave, closes those panes in cleanup, then rotates to the next wave. The tab closes after the run reaches a terminal state.
- `agent_execution: subagents` uses the existing oh-my-pi subagent executor in the current session and never creates a Herdr tab. The Shortleash widget and dashboard remain available in the TUI.
- The standalone CLI always uses the in-process executor because it has no TUI/Herdr session.
- `isolation: worktree` uses the host worktree-isolation lifecycle and therefore skips the Herdr tab for that definition.
- If Herdr is unavailable, its tab or pane response is invalid, or startup fails, Shortleash closes any tab it created and falls back to the in-process executor without discarding durable state.
- The default Herdr worker kind is `omp`. Set `OMP_SWARM_HERDR_AGENT` to another supported Herdr kind when needed. Select `agent_execution: subagents` when Herdr should not be used; there is no separate `OMP_SWARM_HERDR=off` switch in the current source.

The adapter delegates argv-safe commands to `@andrewjacop/pi-herdr` `0.2.5`. That package currently exposes no runtime entrypoint, so the source-path import is isolated in `src/orchestration/adapters/herdr.ts`; consumers do not need to import it directly.

## Durable state and monitoring

State is stored in `<workspace>/.swarm_<name>/`:

```text
.swarm_<name>/
  run.lock                 # active-run identity and recovery metadata
  state/pipeline.json      # pipeline, agent, results, policy, and projection state
  logs/orchestrator.log    # wave and iteration lifecycle
  logs/<agent>.log         # per-agent timestamps and errors
  context/                 # child-session artifacts and inherited history
```

Inspect a run while it is active:

```bash
python -m json.tool <workspace>/.swarm_mypipeline/state/pipeline.json

tail -f <workspace>/.swarm_mypipeline/logs/orchestrator.log

omp-shortleash status mypipeline
omp-shortleash status mypipeline --json
```

The state file records the definition hash, agent status, result history, policy decisions and observations, Beads projection history, manifest, timestamps, and recovery metadata. Writes use a temporary file plus rename, and a run lock prevents concurrent execution of the same logical run.

## Configuration reference

Every definition is one JSON or YAML document with exactly one top-level `swarm` object. `name` and `workspace` are required. Unknown keys are rejected. The parser also rejects the removed `rules` and `must` policy fields; use `checks` instead.

<details>
<summary>Minimal current-session definition</summary>

Use this form from `/shortleash run` when the current OMP session should do the work directly. `agents` is intentionally omitted; `task` is optional and has a generated fallback when omitted.

```yaml
swarm:
  name: repository-maintenance
  workspace: .
  task: Inspect the repository, implement the requested change, and report evidence.
```

</details>

<details>
<summary>Minimal declared-agent definition</summary>

Use `agents` for standalone runs, Herdr-backed runs, subagent execution, or any DAG with multiple workers.

```yaml
swarm:
  name: codebase-audit
  workspace: ./workspace
  mode: parallel
  agent_execution: subagents
  agents:
    security:
      role: security auditor
      task: Audit src/ and write reports/security.md.
    performance:
      role: performance analyst
      task: Inspect src/ for bottlenecks and write reports/performance.md.
```

</details>

<details>
<summary>Full YAML configuration example</summary>

```yaml
swarm:
  name: feature-implementation
  workspace: ./workspace
  mode: pipeline
  agent_execution: subagents
  target_count: 3
  failure_policy: skip_dependents
  max_concurrency: 4
  agent_timeout_ms: 3600000
  model: claude-opus-4-6
  isolation: none
  inherit_history: false
  plugins:
    - ./policies/obligations.ts
  checks:
    - obligations:architecture-boundary
  evals:
    - obligations:architecture-evaluator
  agents:
    planner:
      role: architect
      task: Read the feature spec and write plan.md.
      reports_to:
        - api
        - ui
    api:
      role: backend developer
      task: Implement the API described in plan.md.
      waits_for:
        - planner
    ui:
      role: frontend developer
      task: Implement the UI described in plan.md.
      waits_for:
        - planner
```

`token_budget` and `request_budget` are also accepted as positive integers by the current parser and metadata schema, but the current execution path does not pass them to the oh-my-pi worker. They are therefore not enforcement controls yet.

</details>

<details>
<summary>Equivalent JSON shape</summary>

The JSON form uses the same snake_case keys as YAML:

```json
{
  "swarm": {
    "name": "feature-implementation",
    "workspace": "./workspace",
    "mode": "parallel",
    "agent_execution": "subagents",
    "failure_policy": "continue",
    "max_concurrency": 2,
    "agents": {
      "planner": {
        "role": "architect",
        "task": "Write plan.md.",
        "reports_to": ["implementer"]
      },
      "implementer": {
        "role": "engineer",
        "task": "Implement plan.md.",
        "waits_for": ["planner"]
      }
    }
  }
}
```

</details>

<details>
<summary>Isolation and resource budgets</summary>

Use `isolation` to choose shared workspace execution or host-managed worktrees. An agent-level value overrides the global value:

```yaml
swarm:
  name: isolated-build
  workspace: ./workspace
  isolation: worktree
  agent_timeout_ms: 900000
  token_budget: 200000
  request_budget: 100
  agents:
    reviewer:
      role: reviewer
      task: Inspect the isolated result and write review.md.
      isolation: none
```

`none` keeps workers in the configured workspace. `worktree` runs each worker in a host-managed copy-on-write worktree and merges a successful patch; if any agent's effective isolation is `worktree`, the Herdr adapter skips the tab for that definition. `agent_timeout_ms` is enforced through an abort-signal scope for each attempt. `token_budget` and `request_budget` are parsed and persisted but are not passed to the current oh-my-pi worker API, so they do not enforce limits yet.

</details>

### Top-level fields

| Field | Required | Default | Source-verified behavior |
| --- | --- | --- | --- |
| `name` | yes | — | Non-empty; may contain letters, numbers, `.`, `_`, and `-`. State is stored under `.swarm_<name>/`. |
| `workspace` | yes | — | Non-empty path. Relative paths resolve from the definition file (or the Beads workspace for metadata input). |
| `task` | no | generated direct-session prompt | Used by a definition without `agents`; it is ignored as an agent task when declared agents are present. |
| `mode` | no | `sequential` | `pipeline`, `parallel`, or `sequential`. |
| `agent_execution` | no | `herdr` | `herdr` or `subagents`; relevant to declared agents in the TUI. |
| `target_count` | no | `1` | Positive integer. Repeats the full graph only in `pipeline` mode; definitions without agents support exactly one target. |
| `failure_policy` | no | `skip_dependents` | `fail_fast` stops after the failing wave; `continue` runs later work; `skip_dependents` records dependent agents as skipped. |
| `max_concurrency` | no | all runnable agents in a wave | Positive integer cap applied per wave. |
| `agent_timeout_ms` | no | host/default timeout | Positive integer timeout applied to each agent attempt. |
| `token_budget` | no | — | Positive integer accepted and persisted, but not currently enforced by the worker path. |
| `request_budget` | no | — | Positive integer accepted and persisted, but not currently enforced by the worker path. |
| `model` | no | OMP session default | Default model ID; an agent-level `model` overrides it. Shortleash does not validate model IDs against a bundled catalog. |
| `isolation` | no | `none` | `none` or `worktree`. Worktree mode uses host-managed copy-on-write isolation and merges the captured patch. `workspace_isolation` is an accepted alias. |
| `inherit_history` | no | `false` | Boolean or `parent`/`inherit` for true, `none`/`isolated` for false. `history` and `parent_history` are accepted aliases. Parent history requires an interactive OMP session. |
| `plugins` | no | `[]` plus auto-discovery | Paths to code plugin modules/directories, resolved relative to the definition file. |
| `checks` | no | `[]` | Blocking check references. |
| `evals` | no | `[]` | Structured evaluator references; failures block unless the evaluator definition sets `blocking: false`. |
| `agents` | no | omitted | If present, must contain at least one named agent. |

### Agent fields and dependency graph

| Field | Required | Behavior |
| --- | --- | --- |
| `role` | yes | Short role text used to build the worker system prompt. |
| `task` | yes | Complete user prompt for the worker. |
| `extra_context` | no | Additional system-prompt text. |
| `reports_to` | no | Each listed target depends on this agent. |
| `waits_for` | no | Explicit dependencies for this agent. |
| `model` | no | Overrides `swarm.model`. |
| `isolation` | no | Overrides global isolation; `workspace_isolation` is an alias. |
| `inherit_history` | no | Overrides global parent-history behavior; `history` and `parent_history` are aliases. |
| `checks` | no | Agent-scoped check references, merged with top-level checks. |
| `evals` | no | Agent-scoped evaluator references, merged with top-level evals. |

The orchestrator rejects unknown agents, self-dependencies, and cycles. Explicit `waits_for` edges and `reports_to` edges are combined. With no explicit dependencies, `pipeline` and `sequential` modes chain agents in declaration order; `parallel` mode places them in one wave. Agents in a wave run concurrently, subject to `max_concurrency`; the next wave waits for the previous wave.

## Beads integration

A Beads input is a projection target, not the authoritative Shortleash state. The runner reads `bd show <id> --json` and expects a valid definition at `metadata.shortleash`.

<details>
<summary>Beads metadata shape</summary>

The value under `metadata.shortleash` uses exactly the same schema as a file definition. Other Beads metadata is preserved and ignored by the Shortleash parser.

```json
{
  "shortleash": {
    "name": "streaming-retry",
    "workspace": ".",
    "mode": "sequential",
    "agent_execution": "subagents",
    "agents": {
      "backend": {
        "role": "backend engineer",
        "task": "Implement streaming retry logic."
      }
    }
  },
  "acceptance": "Existing retry clients remain compatible."
}
```

Create/update metadata with Beads' JSON option, for example:

```bash
bd create "Streaming retry" \
  --metadata '{"shortleash":{"name":"streaming-retry","workspace":".","mode":"sequential","agents":{"backend":{"role":"backend engineer","task":"Implement streaming retry logic."}}}}'
```

</details>

<details>
<summary>Claim behavior and Beads hooks</summary>

The extension keeps Beads model-visible operations on the normal CLI surface; it does not register a separate model-facing `beads` tool.

- A direct, simple `bd show <id>` call is converted to a bounded argv `bd show <id> --json` lookup and rendered as a structured issue card. Complex shell commands containing pipes, redirects, chains, substitutions, or glob syntax pass through unchanged.
- Direct `bd create` and `bd update` commands carrying `--metadata` are validated when the metadata contains `shortleash`. Inline JSON and `--metadata @file.json` are supported by the hook validator.
- A valid `bd update <id> --claim` executes normally, then starts the persisted Shortleash run in the same logical OMP session. Invalid or missing `metadata.shortleash` is not autorun.
- A persisted claim is idempotent. Existing `running` and `completed` runs are reported without silently duplicating work. Use `/shortleash run issue://<id> --restart` to intentionally rerun a completed, failed, or aborted run.

</details>

<details>
<summary>Projection and reconciliation</summary>

For a Beads input, lifecycle milestones are appended to the issue notes as idempotent lines such as `[swarm:streaming-retry] started: running`. Existing notes are preserved. Shortleash never closes the Bead as part of a run.

```bash
omp-shortleash reconcile shrtlsh-123 --json
/shortleash reconcile issue://shrtlsh-123 --json
```

Reconciliation checks that the projected Bead still exists and reports drift when a Bead is manually closed while authoritative Shortleash state is not `completed`. A closed Bead is never converted into an accepted workflow result.

</details>

## Policies and code-defined plugins

Policies are executable runtime contracts, not prompt instructions:

- A **check** returns `boolean` or `{ passed, message, findings, evidenceRefs }`. A failed check blocks its boundary.
- An **evaluator** returns `{ outcome, explanation, findings, evidenceRefs }` and has an explicit `id`, `version`, `description`, optional `boundary`, optional `capture`, and optional `blocking` flag. A failed evaluator blocks by default; `blocking: false` makes it advisory.
- Supported boundaries are `agent`, `wave`, `iteration`, and `complete`. A global policy defaults to `complete`; an agent-scoped policy defaults to `agent`.
- Top-level references are evaluated for the whole definition and inherited into each declared agent's scoped policy set. Agent-scoped policies run during finalization and can return corrective feedback to the same worker session.
- Every policy context includes the normalized definition, `cwd`, `workspace`, `swarmDir`, boundary, iteration, optional attempt/wave/agent, normalized `params`, optional before/after `observation`, latest results, result history, and durable state.
- A policy can define `capture(context)` to record before/after snapshots. The snapshots and structured decisions are persisted in `state/pipeline.json`.

<details>
<summary>Policy reference forms and parameters</summary>

String references use `plugin:id`:

```yaml
checks:
  - obligations:architecture-boundary
  - git:changed-files::extension=.rs::minimum=3::include_untracked=true
```

Object references use the same identity and scalar parameters:

```yaml
checks:
  - plugin: git
    id: changed-files
    params:
      extension: ".rs"
      minimum: 3
      include_untracked: true
```

Inline values are decoded as strings, finite numbers, booleans, or `null`. Parameter keys must start with a letter or underscore and may contain letters, numbers, underscores, and hyphens.

</details>

<details>
<summary>Code plugin implementation</summary>

Plugin modules default-export `defineSwarmPlugin(...)` or a compatible plugin factory:

```ts
import { defineSwarmPlugin } from "@oh-my-pi/shortleash/plugin";

export default defineSwarmPlugin({
  name: "obligations",
  setup(api) {
    api.registerCheck({
      id: "architecture-boundary",
      description: "The architecture boundary is documented.",
      boundary: "complete",
      check: async ({ workspace }) => ({
        passed: await Bun.file(`${workspace}/ARCHITECTURE.md`).exists(),
        message: "ARCHITECTURE.md is required before completion.",
        evidenceRefs: ["workspace://ARCHITECTURE.md"]
      })
    });

    api.registerEval({
      id: "architecture-evaluator",
      version: "1",
      description: "Checks the latest agent evidence.",
      boundary: "complete",
      evaluate: ({ latestResults }) => ({
        outcome: latestResults.size > 0 ? "pass" : "fail",
        explanation: "The evaluator inspected the latest agent results.",
        findings: [],
        evidenceRefs: ["workspace://ARCHITECTURE.md"]
      })
    });
  }
});
```

</details>

<details>
<summary>Plugin discovery order</summary>

Shortleash de-duplicates discovered paths and searches in this order:

1. Project-local `.omp/swarm/` and `.swarm/plugins/` roots.
2. The same roots under the definition file's directory when it differs from the current directory.
3. Enabled OMP plugins that declare `swarm` in their manifest, an enabled feature, or a conventional `swarm/` directory.
4. Paths listed in `swarm.plugins`.

A configured path may be a `.ts`, `.js`, `.mjs`, or `.cjs` module, a directory with `index.*`, or a directory containing one level of module files/child `index.*` entries.

</details>

## Execution modes and patterns

<details>
<summary>Pipeline: repeat the full graph</summary>

Use `pipeline` with `target_count` for accumulative work:

```yaml
swarm:
  name: research-collector
  workspace: ./workspace
  mode: pipeline
  target_count: 25
  agents:
    finder:
      role: researcher
      task: |
        Find one new high-quality source and append it to processed.txt.
    analyzer:
      role: analyst
      task: Analyze the newest source and append findings to output/report.md.
      waits_for:
        - finder
```

Each iteration runs every wave in order. Results and policy history remain in the same durable state directory.

</details>

<details>
<summary>Parallel fan-in: independent specialists and a lead</summary>

```yaml
swarm:
  name: codebase-audit
  workspace: ./workspace
  mode: parallel
  agents:
    security:
      role: security auditor
      task: Write reports/security.md.
      reports_to: [lead]
    performance:
      role: performance analyst
      task: Write reports/performance.md.
      reports_to: [lead]
    architecture:
      role: architecture reviewer
      task: Write reports/architecture.md.
      reports_to: [lead]
    lead:
      role: engineering lead
      task: Read all reports and write output/action_plan.md.
```

The three specialists form wave 1 and `lead` forms wave 2.

</details>

<details>
<summary>Sequential chain: declaration-order stages</summary>

```yaml
swarm:
  name: blog-post
  workspace: ./workspace
  mode: sequential
  agents:
    researcher:
      role: researcher
      task: Write research/notes.md.
    writer:
      role: technical writer
      task: Read the notes and write drafts/post.md.
    editor:
      role: editor
      task: Edit drafts/post.md in place.
```

With no explicit `waits_for` or `reports_to` edges, `sequential` chains agents by declaration order.

</details>

<details>
<summary>Diamond: planner, parallel workers, integrator</summary>

```yaml
swarm:
  name: feature-implementation
  workspace: ./workspace
  agents:
    planner:
      role: architect
      task: Write plan.md with independent file assignments.
      reports_to: [api, ui, tests]
    api:
      role: backend developer
      task: Implement the API assignment from plan.md.
      reports_to: [integrator]
    ui:
      role: frontend developer
      task: Implement the UI assignment from plan.md.
      reports_to: [integrator]
    tests:
      role: test engineer
      task: Add tests for the assignments in plan.md.
      reports_to: [integrator]
    integrator:
      role: tech lead
      task: Review, integrate, and verify all changes.
```

This produces planner (wave 1), `api` + `ui` + `tests` (wave 2), and integrator (wave 3).

</details>

<details>
<summary>Hybrid DAG: mixed fan-out and fan-in</summary>

```yaml
swarm:
  name: data-pipeline
  workspace: ./workspace
  mode: pipeline
  target_count: 10
  agents:
    scraper_a:
      role: web scraper
      task: Write raw/source_a.json.
      reports_to: [transformer]
    scraper_b:
      role: web scraper
      task: Write raw/source_b.json.
      reports_to: [transformer]
    transformer:
      role: data engineer
      task: Merge both raw files into processed/merged.json.
      reports_to: [loader, validator]
    validator:
      role: QA analyst
      task: Validate processed/merged.json and write qa/validation.md.
    loader:
      role: data engineer
      task: Append processed/merged.json to output/dataset.jsonl.
```

The dependency graph, not the visual order of the YAML, determines the waves. Cycles are rejected before execution.

</details>

<details>
<summary>Writing agent tasks and workspace protocols</summary>

Each declared worker receives a full oh-my-pi execution environment in the configured workspace. Agents communicate through the shared filesystem; the orchestrator does not automatically pass arbitrary output text between agents.

Useful protocols include:

- **Signal files:** `signals/worker_out.txt` containing a short parseable status such as `DONE:42`.
- **Structured artifacts:** `reports/security.md`, `results/report.json`, or another durable output path.
- **Tracking files:** `processed.txt`, `tracking/count.txt`, and `tracking/status.json` to make pipeline iterations idempotent.

Reliable task prompts should name exact paths, tell agents how to handle failure, avoid duplicate work, and scope each worker to one clear objective.

</details>

<details>
<summary>Model selection and precedence</summary>

Any model ID configured in oh-my-pi may be used:

```yaml
swarm:
  name: writing-team
  workspace: ./workspace
  model: claude-opus-4-6
  agents:
    writer:
      role: technical writer
      task: Write the draft.
    reviewer:
      role: reviewer
      model: claude-sonnet-4-5
      task: Review the draft.
```

Precedence is `agents.<name>.model` → `swarm.model` → the OMP session default. Shortleash does not ship or validate a model catalog.

</details>

## Architecture

```text
src/
  extension.ts                 OMP TUI command, dashboard, and Beads hook registration
  cli.ts                       standalone runner, plan/status/evaluate/reconcile/dashboard commands
  index.ts                     public TypeScript exports
  beads/
    client.ts                  bounded argv/JSON Beads helpers
    hooks.ts                   direct bd command validation, show cards, and claim delegation
    render.ts                  Beads call/result rendering
  orchestration/
    definition/
      schema.ts                JSON/YAML parsing, normalization, and validation
      metadata.ts              Beads metadata schema and validation
      plan.ts                  input resolution, plugin loading, and executable plan
      manifest.ts              durable run manifest and definition fingerprint
    execution/
      dag.ts                   dependency graph, cycle detection, topological waves
      executor.ts              OMP worker execution and worktree isolation
      pipeline.ts              iteration loop, policy boundaries, and projection
      state.ts                 atomic filesystem state, locks, history, and recovery
      auto.ts                  claimed-Bead run lifecycle
      concurrency.ts           bounded asynchronous work
      signals.ts               cancellation and timeout scopes
    policy/
      plugins.ts               plugin discovery, registration, captures, and evaluation
      policy-types.ts           durable check/evaluation result contracts
    adapters/
      beads.ts                 Beads input, lifecycle projection, and reconciliation
      herdr.ts                 Herdr tab and agent-pane execution adapter
    presentation/
      dashboard.ts              TUI widget and dashboard overlay
      graph.ts                  dependency graph rendering
      render.ts                 progress and terminal rendering
```

