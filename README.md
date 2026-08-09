# Shortleash

Shortleash is an oh-my-pi extension for guarded multi-agent implementation workflows. Define an acyclic dependency graph in JSON. Each declared agent runs as an oh-my-pi worker with the tools available to that host; the orchestrator owns ordering, persistence, policy boundaries, and recovery.

The implementation deliberately keeps the product name **Shortleash** separate from the definition format: the top-level configuration key is `swarm` because that is the parser contract, while Beads stores the same definition under `metadata.shortleash`.

The `swarm` spelling is retained only as the on-disk definition-format key; package APIs, commands, metadata, state paths, and policy module paths use **Shortleash**.

## Setup

Requirements:

- Bun `>=1.3.14`.
- oh-my-pi `^17` when loading the extension in the TUI.

Install the extension directly from GitHub:

```bash
omp install git:github.com/smallstepman/shortleash
```

From this repository root:

```bash
bun install
bun run check
```

The package exposes the `./src/extension.ts` OMP extension entrypoint. Load it through OMP project or user settings, then use the `/shortleash` commands.

## Running


### Resume and restart

Shortleash persists state under the configured workspace. A second run never silently overwrites an existing run:

```text
# Continue an unfinished run after a host/process restart.
/shortleash run path/to/shortleash.json --resume

# Intentionally discard the previous in-memory run state and start again.
/shortleash run path/to/shortleash.json --restart
```

`--resume` requires the persisted definition hash, workspace, and agent set to remain compatible. Successful results already recorded for completed agents are reused; missing or failed work runs again. A stale valid `run.lock` is recoverable only with `--resume` or `--restart`; a corrupt lock is never removed automatically. A completed run requires `--restart` rather than `--resume`.

`/shortleash evaluate` reads the persisted results and runs the configured policy evaluators without starting agents. A blocked decision is reported and stored in the state; it does not silently mark the pipeline complete.

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
/shortleash run path/to/shortleash.json [--resume|--restart]
/shortleash run shrtlsh-123
/shortleash run issue://shrtlsh-123
/shortleash plan path/to/shortleash.json
/shortleash inspect path/to/shortleash.json
/shortleash status <name> [--json]
/shortleash evaluate path/to/shortleash.json [--json]
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

## Execution model

Declared agents execute through the oh-my-pi worker executor. The dependency graph determines runnable waves; agents in a wave run concurrently subject to the host `task.maxConcurrency` setting, and later waves wait for their dependencies. The Shortleash widget and dashboard remain available in the TUI.

The TUI uses the same host worker execution path for declared agents and current-session work. `isolation: worktree` uses the host worktree-isolation lifecycle, and `inherit_history` requires an interactive OMP session.

## Durable state and monitoring

State is stored in `<workspace>/.shortleash_<name>/`:

```text
.shortleash_<name>/
  run.lock                 # active-run identity and recovery metadata
  state/pipeline.json      # pipeline, agent, results, policy, and projection state
  logs/orchestrator.log    # wave and policy lifecycle
  logs/<agent>.log         # per-agent timestamps and errors
  context/                 # child-session artifacts and inherited history
```

Inspect a run while it is active:

```bash
python -m json.tool <workspace>/.shortleash_mypipeline/state/pipeline.json

tail -f <workspace>/.shortleash_mypipeline/logs/orchestrator.log

/shortleash status mypipeline
/shortleash status mypipeline --json
```

The state file records the definition hash, agent status, result history, policy decisions and observations, Beads projection history, manifest, timestamps, and recovery metadata. Writes use a temporary file plus rename, and a run lock prevents concurrent execution of the same logical run.

## Configuration reference

Every definition is one JSON document with exactly one top-level `swarm` object. `name` and `workspace` are required. Unknown keys are rejected. The parser also rejects the removed `rules` and `must` policy fields; use `checks` instead.

<details>
<summary>Minimal current-session definition</summary>

Use this form from `/shortleash run` when the current OMP session should do the work directly. `agents` is intentionally omitted; `task` is optional and has a generated fallback when omitted.

```json
{
  "swarm": {
    "name": "repository-maintenance",
    "workspace": ".",
    "task": "Inspect the repository, implement the requested change, and report evidence."
  }
}
```

</details>

<details>
<summary>Minimal declared-agent definition</summary>

Use `agents` for TUI runs or any DAG with multiple workers.

```json
{
  "swarm": {
    "name": "codebase-audit",
    "workspace": "./workspace",
    "agents": {
      "security": {
        "role": "security auditor",
        "task": "Audit src/ and write reports/security.md."
      },
      "performance": {
        "role": "performance analyst",
        "task": "Inspect src/ for bottlenecks and write reports/performance.md."
      }
    }
  }
}
```

</details>

<details>
<summary>Full JSON configuration example</summary>

```json
{
  "swarm": {
    "name": "feature-implementation",
    "workspace": "./workspace",
    "failure_policy": "skip_dependents",
    "agent_timeout_ms": 3600000,
    "model": "claude-opus-4-6",
    "isolation": "none",
    "inherit_history": false,
    "checks": ["./policies/architecture-boundary.ts"],
    "evals": ["./policies/architecture-evaluator.ts"],
    "agents": {
      "planner": {
        "role": "architect",
        "task": "Read the feature spec and write plan.md.",
        "reports_to": ["api", "ui"]
      },
      "api": {
        "role": "backend developer",
        "task": "Implement the API described in plan.md.",
        "waits_for": ["planner"]
      },
      "ui": {
        "role": "frontend developer",
        "task": "Implement the UI described in plan.md.",
        "waits_for": ["planner"]
      }
    }
  }
}
```


</details>

<details>
<summary>Equivalent JSON shape</summary>

The JSON definition uses snake_case keys:

```json
{
  "swarm": {
    "name": "feature-implementation",
    "workspace": "./workspace",
    "failure_policy": "continue",
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
<summary>Isolation and execution timeout</summary>

Use `isolation` to choose shared workspace execution or host-managed worktrees. An agent-level value overrides the global value:

```json
{
  "swarm": {
    "name": "isolated-build",
    "workspace": "./workspace",
    "isolation": "worktree",
    "agent_timeout_ms": 900000,
    "agents": {
      "reviewer": {
        "role": "reviewer",
        "task": "Inspect the isolated result and write review.md.",
        "isolation": "none"
      }
    }
  }
}
```

`none` keeps workers in the configured workspace. `worktree` runs each worker in a host-managed copy-on-write worktree and merges a successful patch. `agent_timeout_ms` is enforced through an abort-signal scope for each attempt.

</details>

### Top-level fields

| Field | Required | Default | Source-verified behavior |
| --- | --- | --- | --- |
| `name` | yes | — | Non-empty; may contain letters, numbers, `.`, `_`, and `-`. State is stored under `.shortleash_<name>/`. |
| `workspace` | yes | — | Non-empty path. Relative paths resolve from the definition file (or the Beads workspace for metadata input). |
| `task` | no | generated direct-session prompt | Used by a definition without `agents`; it is ignored as an agent task when declared agents are present. |
| `failure_policy` | no | `skip_dependents` | `fail_fast` stops after the failing wave; `continue` runs later work; `skip_dependents` records dependent agents as skipped. |
| `agent_timeout_ms` | no | host/default timeout | Positive integer timeout applied to each agent attempt. |
| `model` | no | OMP session default | Default model ID; an agent-level `model` overrides it. Shortleash does not validate model IDs against a bundled catalog. |
| `isolation` | no | `none` | `none` or `worktree`. Worktree mode uses host-managed copy-on-write isolation and merges the captured patch. `workspace_isolation` is an accepted alias. |
| `inherit_history` | no | `false` | Boolean or `parent`/`inherit` for true, `none`/`isolated` for false. `history` and `parent_history` are accepted aliases. Parent history requires an interactive OMP session. |
| `checks` | no | `[]` | Paths to `.ts` check modules, resolved relative to the definition file; use `{ "path": "...", "params": { ... } }` for parameters. |
| `evals` | no | `[]` | Paths to `.ts` evaluator modules, resolved relative to the definition file; failures block unless the evaluator sets `blocking: false`. |
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

The orchestrator rejects unknown agents, self-dependencies, and cycles. Explicit `waits_for` and `reports_to` edges define the graph; agents with no dependencies form the initial wave. Agents in the same wave run concurrently, subject to the host's `task.maxConcurrency` setting; the next wave waits for the previous wave.
The parser rejects legacy scheduling keys such as `mode`, `max_concurrency`, and `target_count`; use dependency edges and the host setting instead.

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
  --metadata '{"shortleash":{"name":"streaming-retry","workspace":".","agents":{"backend":{"role":"backend engineer","task":"Implement streaming retry logic."}}}}'
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

For a Beads input, lifecycle milestones are appended to the issue notes as idempotent lines such as `[shortleash:streaming-retry] started: running`. Existing notes are preserved. Shortleash never closes the Bead as part of a run.

```bash
/shortleash reconcile issue://shrtlsh-123 --json
```

Reconciliation checks that the projected Bead still exists and reports drift when a Bead is manually closed while authoritative Shortleash state is not `completed`. A closed Bead is never converted into an accepted workflow result.

</details>

## Policies and direct TypeScript modules

Policies are executable runtime contracts, not prompt instructions:

- A **check module** default-exports `{ description, check }` and may set `boundary` and `capture`. `check` returns `boolean` or `{ passed, message, findings, evidenceRefs }`. A failed check blocks its boundary.
- An **evaluator module** default-exports `{ version, description, evaluate }` and may set `boundary`, `blocking`, and `capture`. `evaluate` returns `{ outcome, explanation, findings, evidenceRefs }`; failures block by default.
- Supported boundaries are `agent`, `wave`, and `complete`. A top-level policy defaults to `complete`; an agent-scoped policy defaults to `agent`.
- Top-level references are evaluated for the whole definition and inherited into each declared agent's scoped policy set. Agent-scoped policies run during finalization and can return corrective feedback to the same worker session.
- Every policy context includes the normalized definition, `cwd`, `workspace`, `shortleashDir`, boundary, optional attempt/wave/agent, normalized `params`, optional before/after `observation`, latest results, result history, and durable state.
- A policy can define `capture(context)` to record before/after snapshots. The snapshots and structured decisions are persisted in `state/pipeline.json`.

<details>
<summary>Policy paths and parameters</summary>

String references are paths to `.ts` files, resolved relative to the definition file:

```json
{
  "checks": ["./policies/architecture-boundary.ts"],
  "evals": ["./policies/completion.ts"]
}
```

Use an object when the module needs parameters:

```json
{
  "checks": [
    {
      "path": "./policies/changed-files.ts",
      "params": {
        "extension": ".rs",
        "minimum": 3,
        "include_untracked": true
      }
    }
  ]
}
```

Parameter values are strings, finite numbers, booleans, or `null`. Parameter keys must start with a letter or underscore and may contain letters, numbers, underscores, and hyphens. The parser rejects non-`.ts` paths and unknown reference fields.

</details>

<details>
<summary>Check module implementation</summary>

Each referenced file exports exactly one check contract. No registration step or separate plugin list is required:

```ts
import type { ShortleashCheckModule } from "shortleash";

export default {
  description: "The architecture boundary is documented.",
  boundary: "complete",
  check: async ({ workspace }) => ({
    passed: await Bun.file(`${workspace}/ARCHITECTURE.md`).exists(),
    message: "ARCHITECTURE.md is required before completion.",
    evidenceRefs: ["workspace://ARCHITECTURE.md"]
  })
} satisfies ShortleashCheckModule;
```

</details>

<details>
<summary>Evaluator module implementation</summary>

Evaluator files use the same direct-export convention:

```ts
import type { ShortleashEvaluationModule } from "shortleash";

export default {
  version: "1",
  description: "Checks the latest agent evidence.",
  boundary: "complete",
  evaluate: ({ latestResults }) => ({
    outcome: latestResults.size > 0 ? "pass" : "fail",
    explanation: "The evaluator inspected the latest agent results.",
    findings: [],
    evidenceRefs: ["workspace://ARCHITECTURE.md"]
  })
} satisfies ShortleashEvaluationModule;
```

</details>

## Execution graph and guarded attempts

<details>
<summary>One graph run with guarded corrective attempts</summary>

The runtime executes the declared dependency graph once. Agents with no dependencies form the initial wave; each later wave waits for its dependencies. In-wave concurrency follows the host's `task.maxConcurrency` setting, not the workflow definition. A failed agent or policy decision is persisted and controls the run according to `failure_policy`.

Agent-scoped policies run at finalization. When one rejects a result, Shortleash sends structured findings back through the same worker session and records the follow-up as the next attempt. The retry budget is fixed by the execution adapter; it never reruns the dependency graph.

```json
{
  "swarm": {
    "name": "guarded-implementation",
    "workspace": "./workspace",
    "failure_policy": "skip_dependents",
    "agents": {
      "implement": {
        "role": "engineer",
        "task": "Implement the requested change and leave evidence in reports/implementation.md.",
        "checks": ["./policies/architecture-boundary.ts"]
      },
      "verify": {
        "role": "reviewer",
        "task": "Run the focused checks and write reports/verification.md.",
        "waits_for": ["implement"]
      }
    }
  }
}
```

</details>

<details>
<summary>Parallel fan-in: independent specialists and a lead</summary>

```json
{
  "swarm": {
    "name": "codebase-audit",
    "workspace": "./workspace",
    "agents": {
      "security": {
        "role": "security auditor",
        "task": "Write reports/security.md.",
        "reports_to": ["lead"]
      },
      "performance": {
        "role": "performance analyst",
        "task": "Write reports/performance.md.",
        "reports_to": ["lead"]
      },
      "architecture": {
        "role": "architecture reviewer",
        "task": "Write reports/architecture.md.",
        "reports_to": ["lead"]
      },
      "lead": {
        "role": "engineering lead",
        "task": "Read all reports and write output/action_plan.md."
      }
    }
  }
}
```

The three specialists form wave 1 and `lead` forms wave 2.

</details>


<details>
<summary>Diamond: planner, parallel workers, integrator</summary>

```json
{
  "swarm": {
    "name": "feature-implementation",
    "workspace": "./workspace",
    "agents": {
      "planner": {
        "role": "architect",
        "task": "Write plan.md with independent file assignments.",
        "reports_to": ["api", "ui", "tests"]
      },
      "api": {
        "role": "backend developer",
        "task": "Implement the API assignment from plan.md.",
        "reports_to": ["integrator"]
      },
      "ui": {
        "role": "frontend developer",
        "task": "Implement the UI assignment from plan.md.",
        "reports_to": ["integrator"]
      },
      "tests": {
        "role": "test engineer",
        "task": "Add tests for the assignments in plan.md.",
        "reports_to": ["integrator"]
      },
      "integrator": {
        "role": "tech lead",
        "task": "Review, integrate, and verify all changes."
      }
    }
  }
}
```

This produces planner (wave 1), `api` + `ui` + `tests` (wave 2), and integrator (wave 3).

</details>

<details>
<summary>Hybrid DAG: mixed fan-out and fan-in</summary>

```json
{
  "swarm": {
    "name": "data-pipeline",
    "workspace": "./workspace",
    "agents": {
      "scraper_a": {
        "role": "web scraper",
        "task": "Write raw/source_a.json.",
        "reports_to": ["transformer"]
      },
      "scraper_b": {
        "role": "web scraper",
        "task": "Write raw/source_b.json.",
        "reports_to": ["transformer"]
      },
      "transformer": {
        "role": "data engineer",
        "task": "Merge both raw files into processed/merged.json.",
        "reports_to": ["loader", "validator"]
      },
      "validator": {
        "role": "QA analyst",
        "task": "Validate processed/merged.json and write qa/validation.md."
      },
      "loader": {
        "role": "data engineer",
        "task": "Append processed/merged.json to output/dataset.jsonl."
      }
    }
  }
}
```
The dependency graph, not the visual order of the JSON, determines the waves. Cycles are rejected before execution.

</details>

<details>
<summary>Writing agent tasks and workspace protocols</summary>

Each declared worker receives a full oh-my-pi execution environment in the configured workspace. Agents communicate through the shared filesystem; the orchestrator does not automatically pass arbitrary output text between agents.

Useful protocols include:

- **Signal files:** `signals/worker_out.txt` containing a short parseable status such as `DONE:42`.
- **Structured artifacts:** `reports/security.md`, `results/report.json`, or another durable output path.
- **Status and evidence files:** `tracking/status.json`, `reports/verification.md`, or another durable output path that later checks can inspect.

Reliable task prompts should name exact paths, tell agents how to handle failure, avoid duplicate work, and scope each worker to one clear objective.

</details>

<details>
<summary>Model selection and precedence</summary>

Any model ID configured in oh-my-pi may be used:

```json
{
  "swarm": {
    "name": "writing-team",
    "workspace": "./workspace",
    "model": "claude-opus-4-6",
    "agents": {
      "writer": {
        "role": "technical writer",
        "task": "Write the draft."
      },
      "reviewer": {
        "role": "reviewer",
        "model": "claude-sonnet-4-5",
        "task": "Review the draft."
      }
    }
  }
}
```

Precedence is `agents.<name>.model` → `swarm.model` → the OMP session default. Shortleash does not ship or validate a model catalog.

</details>

## Architecture

```text
src/
  extension.ts                 OMP TUI command, dashboard, and Beads hook registration
  index.ts                     public TypeScript exports
  beads/
    client.ts                  bounded argv/JSON Beads helpers
    hooks.ts                   direct bd command validation, show cards, and claim delegation
    render.ts                  Beads call/result rendering
  orchestration/
    definition/
      schema.ts                JSON parsing, normalization, and validation
      metadata.ts              Beads metadata schema and validation
      plan.ts                  input resolution, policy module loading, and executable plan
      manifest.ts              durable run manifest and definition fingerprint
    execution/
      dag.ts                   dependency graph, cycle detection, topological waves
      executor.ts              OMP worker execution and worktree isolation
      pipeline.ts              graph execution, policy boundaries, and projection
      state.ts                 atomic filesystem state, locks, history, and recovery
      auto.ts                  claimed-Bead run lifecycle
      concurrency.ts           bounded asynchronous work
      signals.ts               cancellation and timeout scopes
    policy/
      policies.ts              direct module loading, captures, and evaluation
      policy-types.ts           durable check/evaluation result contracts
    adapters/
      beads.ts                 Beads input, lifecycle projection, and reconciliation
    presentation/
      dashboard.ts              TUI widget and dashboard overlay
      graph.ts                  dependency graph rendering
      render.ts                 progress and terminal rendering
```

