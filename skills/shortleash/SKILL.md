---
name: shortleash
description: Use Shortleash to design, run, inspect, evaluate, resume, and reconcile durable OMP multi-agent workflows. Apply when an engineering objective benefits from DAG dependencies, dependency waves, bounded corrective attempts, structured policy checks or evaluators, Beads-backed execution, or restart-safe state.
license: MIT
compatibility: Requires the Shortleash extension in oh-my-pi. Beads-backed runs require a working bd installation plus valid metadata.shortleash.
metadata:
  package: "shortleash"
  format: agentskills
---

# Shortleash

Shortleash is the OMP extension for durable multi-agent orchestration. It reads one JSON definition, validates the dependency graph and policy references, runs agents in dependency waves, persists results and policy decisions, and exposes recovery and reconciliation commands.

Treat the persisted Shortleash state as the authoritative execution record. A Beads issue is an external projection and coordination handle; a Bead being open or closed is not proof that the Shortleash run is accepted.

## Decide whether to use it

Use Shortleash when at least one of these is true:

- independent work can run concurrently;
- work has explicit dependencies that form a DAG;
- a large objective needs one guarded graph run with corrective attempts;
- deterministic checks or structured evaluators must block completion;
- progress must survive an OMP, terminal, or host-process restart;
- a meaningful Beads issue should expose the run without representing every internal activity.

Do not create artificial agents for a small linear edit. Use ordinary OMP execution when the work needs one uninterrupted context and has no useful wave boundary. Do not use Shortleash as a Ralph-style loop or as a substitute for a real acceptance/evaluation contract.

## Start safely

1. Confirm the extension is loaded in OMP. A project or user settings file can point to the package directory:

   ```json
   {
     "extensions": ["/absolute/path/to/oh-my-pi/packages/shortleash"]
   }
   ```

2. Keep one durable logical run for the objective. Choose a stable `shortleash.name` and a workspace that all agents may safely share.
3. Inspect the definition before running it:

   ```bash
   /shortleash plan path/to/shortleash.json
   ```

   In an OMP TUI, use `/shortleash plan path/to/shortleash.json` or `/shortleash inspect path/to/shortleash.json`.
4. Fix unknown fields, missing dependencies, policy reference errors, and cycles before starting. The parser rejects unknown keys and the removed `rules` and `must` fields; use `checks` and `evals` instead.

## Write a definition

The file must contain a top-level `shortleash` object. The legacy top-level `swarm` key remains accepted when it is the only definition key. JSON uses snake_case fields. `name` may contain letters, numbers, dots, underscores, and dashes. `workspace` is required and is resolved relative to the definition file (or the current directory for a Beads input).

New definitions and serialized examples use the `shortleash` spelling consistently across the definition format, package APIs, commands, metadata, state paths, and policy module paths.

```json
{
  "shortleash": {
    "name": "api-hardening",
    "workspace": "./workspace",
    "failure_policy": "skip_dependents",
    "model": "claude-sonnet-4-5",
    "isolation": "none",
    "inherit_history": false,
    "checks": ["./policies/architecture.ts"],
    "evals": ["./policies/completion.ts"],
    "agents": {
      "inspect": {
        "role": "investigator",
        "task": "Inspect the repository and record concrete implementation constraints.",
        "reports_to": ["implement"]
      },
      "implement": {
        "role": "implementer",
        "task": "Implement the approved change and leave deterministic evidence.",
        "waits_for": ["inspect"]
      },
      "verify": {
        "role": "verifier",
        "task": "Run focused verification and report failures with evidence references.",
        "waits_for": ["implement"]
      }
    }
  }
}
```

### Definition rules

- The runtime executes the configured dependency graph once. Agents with no dependencies form the initial wave; later waves wait for their dependencies. Agent-scoped policy rejections create bounded corrective attempts in the same worker session; they do not rerun the graph.
- `waits_for` makes the named agents dependencies. If `A.reports_to` contains `B`, `B` also depends on `A`.
- Cycles, unknown dependency names, self-dependencies, and invalid policy references reject the plan before execution.
- Every declared agent requires `role` and `task`. Optional fields are `extra_context`, `reports_to`, `waits_for`, `model`, `isolation`/`workspace_isolation`, `inherit_history`/`history`/`parent_history`, `checks`, and `evals`.
- `failure_policy: fail_fast` stops after a failed wave; `continue` allows later work to run; `skip_dependents` (the default) marks downstream agents blocked by a failed dependency.
- `workspace_isolation: worktree` uses the existing OMP isolation lifecycle and merges the captured patch. Use it only when concurrent changes must not share a working tree.
- Parent-history inheritance requires an interactive OMP session.
- When `agents` is omitted, `task` describes work for the current OMP session. Run that form with `/shortleash run`.

## Run and inspect

Use the OMP TUI for direct current-session work or declared-agent runs with the dashboard:

```text
/shortleash run path/to/shortleash.json
/shortleash run path/to/shortleash.json --resume
/shortleash run path/to/shortleash.json --restart
/shortleash run path/to/shortleash.json --gascity
/shortleash status api-hardening
/shortleash evaluate path/to/shortleash.json --json
/shortleash reconcile issue://beads-id --json
```

The state directory is `.shortleash_<name>/` under the resolved workspace:

```text
.shortleash_<name>/
  state/pipeline.json       # durable status, results, policy history, projections
  logs/orchestrator.log     # wave and lifecycle events
  logs/<agent>.log          # per-agent attempts and errors
  context/                  # parent-history and worker artifacts
  run.lock                  # active-run ownership
```

Inspect `pipeline.json` and the logs when a run fails. Do not delete a valid lock or state directory to make a run appear healthy.

## Use policy checks and evaluators

Policies are executable runtime contracts, not prompt instructions.

- A check module default-exports `{ description, check }` and may include `boundary` and `capture`. The check returns `boolean` or `{ passed, message?, findings?, evidenceRefs? }`.
- An evaluator module default-exports `{ version, description, evaluate }` and may include `boundary`, `blocking`, and `capture`. The evaluator returns `{ outcome: "pass" | "fail", explanation, findings?, evidenceRefs? }`.
- A failed check blocks its boundary. A failed evaluator blocks by default; set `blocking: false` only for explicitly advisory findings.
- Results are structured and persisted with the boundary, evaluator version, findings, and evidence references. A prose paragraph alone is not an evaluator result.
- Optional `capture(context)` functions can record before/after observations. Those observations are persisted and supplied to the corresponding evaluation.
- Boundaries are `agent`, `wave`, and `complete`. A policy with no explicit boundary defaults to `agent` for agent-scoped references and `complete` for top-level references; set `boundary` explicitly when placement matters.
- Top-level checks and evaluators are inherited by declared agents as applicable. Agent-scoped failures can return corrective feedback to the same worker; a later successful attempt does not erase the rejected result from policy history.
- In an OMP-hosted run, `context.judge({ prompt, outputSchema, agent?, model?, schemaMode? })` is available for model-backed structured judgments. Treat it as optional: standalone and Gas City policy execution do not provide a judge, and deterministic checks/evaluators should remain the acceptance authority.


Each `checks` or `evals` entry is a path to one `.ts` module, resolved relative to the definition file. Use an object when the module needs scalar parameters:

```json
{
  "checks": [
    "./policies/architecture.ts",
    {
      "path": "./policies/changed-files.ts",
      "params": {
        "extension": ".rs",
        "minimum": 3,
        "strict": true
      }
    }
  ],
  "evals": ["./policies/completion.ts"]
}
```

Check module:

```ts
import type { ShortleashCheckModule } from "shortleash";

export default {
  description: "The declared module boundary is preserved.",
  boundary: "complete",
  check: async ({ workspace }) => ({
    passed: await Bun.file(`${workspace}/ARCHITECTURE.md`).exists(),
    message: "ARCHITECTURE.md is required.",
    evidenceRefs: [`workspace://${workspace}/ARCHITECTURE.md`],
  }),
} satisfies ShortleashCheckModule;
```

Evaluator module:

```ts
import type { ShortleashEvaluationModule } from "shortleash";

export default {
  version: "1",
  description: "Completion evidence is present.",
  boundary: "complete",
  evaluate: ({ latestResults }) => ({
    outcome: latestResults.size > 0 ? "pass" : "fail",
    explanation: "At least one worker result must be available.",
    evidenceRefs: ["state://latest-results"],
  }),
} satisfies ShortleashEvaluationModule;
```

Keep policy code deterministic where possible. Make findings actionable, attach stable evidence references, and ensure the evaluator checks the repository revision and artifacts it claims to assess. The parser rejects non-`.ts` paths and unknown reference fields; there is no separate plugin list or discovery search.

## Gas City backend

Use `--gascity` when Gas City should own durable scheduling and worker lifecycle:

```text
/shortleash run path/to/shortleash.json --gascity [--gascity-target <target>]
gc status
gc dashboard
```

The extension validates the definition, snapshots and hash-checks the referenced policy modules, compiles a Gas City v2 formula, writes bridge history/evidence under `<city>/.omp/shortleash/gascity/<formula>/`, and routes the cooked root to `omp` by default. Pass `--gascity-target <target>` for another configured agent or pool. Gas City owns retries and workflow state after routing. OMP-only worktree isolation, parent transcript inheritance, and `agent_timeout_ms` are reported as warnings and must be configured through Gas City/provider settings.

## Use Beads as a projection

A Beads-backed input stores the same definition under `metadata.shortleash`; it is not a separate compact schema:

```json
{
  "shortleash": {
    "name": "api-hardening",
    "workspace": ".",
    "agents": {
      "inspect": {
        "role": "investigator",
        "task": "Inspect the repository and report constraints."
      }
    }
  },
  "workflow": "external metadata is preserved but not interpreted by Shortleash"
}
```

Run it with a bare Beads ID or an issue reference:

```bash
/shortleash run issue://issue-id
```

The adapter reads `bd show <id> --json`, validates `metadata.shortleash`, and projects lifecycle notes such as `[shortleash:name] started: running` or `[shortleash:name] completed: completed`. It preserves existing notes and does not close the Bead. Use Beads for meaningful milestones, blockers, decisions, and discovered external work—not for every worker attempt.

A manually closed, missing, or otherwise divergent Bead is drift. Reconcile it explicitly:

```bash
/shortleash reconcile issue://issue-id --json
```

A reconciliation warning must not be converted into a successful workflow result. The Shortleash state and policy decision remain authoritative.

## Recover instead of restarting blindly

After a host or process restart:

1. Reuse the same definition path, `shortleash.name`, workspace, and Beads reference.
2. Run `/shortleash run ... --resume`.
3. Confirm the definition hash, workspace, and agent set still match. Shortleash refuses incompatible resumes.
4. Inspect `state/pipeline.json`, `policyHistory`, `projectionHistory`, and logs.
5. If the evaluator blocked progress, fix the repository or policy evidence and resume. The failed decision remains in history.
6. Use `--restart` only when intentionally beginning a new execution after accepting the loss of the prior unfinished run's continuation point.

A completed run cannot be resumed; use an intentional restart. A valid active `run.lock` prevents concurrent execution. Stale locks may be recovered only through `--resume` or `--restart`; corrupt locks require diagnosis rather than automatic deletion.

## Completion checklist

Before reporting success, verify all of the following:

- `plan --json` validates the definition and shows the expected waves.
- Every worker result is present, and failures are understood rather than hidden.
- Required checks and evaluators returned accepted/pass outcomes with concrete evidence references.
- The final state is `completed`, not merely that the last agent exited successfully.
- `status <name> --json` and the persisted logs agree with the report.
- For Beads input, `reconcile ... --json` reports no projection drift.
- If recovery was part of the objective, a real restart followed by `--resume` succeeded with the same logical run.

When a policy blocks completion, report the blocking module path, evaluator version (when applicable), findings, and evidence references; do not claim completion from an agent message or a closed Bead alone.
