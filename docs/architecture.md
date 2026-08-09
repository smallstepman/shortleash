# Shortleash architecture

Shortleash is a policy-enforced worker runner for a declared implementation graph. A definition names the workspace, agents, dependencies, and code-defined checks/evaluators. The runner executes the graph once, persists every agent attempt and policy decision, and optionally projects lifecycle notes to a Beads issue.

## Product boundary

The core workflow is:

```text
JSON or metadata.shortleash
  -> parse and normalize ShortleashDefinition
  -> validate policy references and dependency graph
  -> build topological execution waves
  -> run each agent through OMP's structured subagent API in its configured workspace
  -> finalize agent output through checks/evaluators
  -> send corrective findings to the worker's persistent child session journal when rejected
  -> persist state and project lifecycle notes
```

The graph is the execution plan. Agents with no dependencies form the initial wave; each later wave waits for its dependencies. In-wave concurrency follows the host's `task.maxConcurrency` setting. Explicit `waits_for` and `reports_to` relationships define the graph. Every configured graph runs once; corrective follow-up is an attempt on the same agent, not a second graph pass.

The orchestration core does not require Beads:

- `src/orchestration/definition/schema.ts` parses and normalizes the `swarm` configuration.
- `src/orchestration/definition/plan.ts` resolves a file or `issue://` input, loads the referenced TypeScript policy modules, validates the graph, and produces waves.
- `src/orchestration/execution/dag.ts` builds dependencies, detects cycles, and topologically sorts waves.
- `src/orchestration/execution/pipeline.ts` coordinates waves, failure policy, policy boundaries, persistence, and projection.
- `src/orchestration/execution/executor.ts` resolves OMP agent profiles, creates durable child sessions, delegates tool/isolation policy to the structured subagent API, and performs corrective turns.
- `src/orchestration/execution/state.ts` owns the durable run state and run lock.

The OMP extension is the adapter around that core. It provides the TUI dashboard, current-session execution for definitions without declared agents, and Beads claim hooks.

## Authority and persistence

`StateTracker`'s JSON snapshot is the authoritative persisted record for a Shortleash run. It lives at `<workspace>/.shortleash_<name>/state/pipeline.json` and contains:

- definition hash, workspace, manifest, and run status;
- per-agent status, wave, current attempt, bounded native-tool history, and errors;
- result records keyed by agent and attempt;
- policy decisions and before/after observations;
- Beads projection attempts and their errors.

Writes use a serialized temporary-file, `fsync`, rename, and directory-sync sequence. A `run.lock` records the process identity, definition hash, and workspace. A live lock is never stolen. A stale lock is recoverable only through explicit `--resume` or `--restart` handling.

The `logs/` directory is supplemental operator history, not a second state machine:

```text
.shortleash_<name>/
  run.lock
  state/pipeline.json
  logs/orchestrator.log
  logs/<agent>.log
  context/
```

Resume requires the persisted definition hash, workspace, and agent set to remain compatible. Successful result records are reused; failed or missing agents run again. `--restart` intentionally initializes a new run after the caller has chosen to start over. A completed run cannot be resumed.

## Policy boundary

Policies are direct JavaScript/TypeScript module contracts. Each path in `checks` or `evals` resolves relative to the definition file and must end in `.ts`; there is no separate plugin registry or discovery step. A check module default-exports `{ description, check }`. An evaluator module default-exports `{ version, description, evaluate }`. Use `{ path, params }` when a module needs scalar parameters.

- A check returns `boolean` or `{ passed, message, findings, evidenceRefs }`.
- An evaluator returns `{ outcome, explanation, findings, evidenceRefs }`; its declared `version` and `blocking` behavior are recorded with the decision.
- Supported boundaries are `agent`, `wave`, and `complete`.
- Agent policies run after an agent result is produced. A rejection is converted into corrective feedback and sent through the existing worker session; each follow-up result is persisted under its attempt number.
- Wave and completion policies run after the corresponding graph boundary. A rejected blocking decision marks the run failed and remains in policy history.
- Captures are optional before/after snapshots. They are evidence for the policy decision, not acceptance by themselves.

The policy context includes the normalized definition, current workspace paths, boundary, optional wave/agent/attempt, reference parameters, latest results, historical results, and the durable `ShortleashState`. Policy code decides domain acceptance; the runtime supplies execution ordering, persistence, and blocking semantics.

## Failure, recovery, and projection

`failure_policy` controls graph failures:

- `fail_fast` stops after the failing wave;
- `continue` runs later waves and reports failures;
- `skip_dependents` records dependent agents as skipped.

A failed policy decision blocks completion regardless of a worker's exit message. The persisted state, not an agent's prose or a closed Beads issue, determines completion.

For a Beads-backed input, `src/orchestration/adapters/beads.ts` reads `bd show <id> --json` and validates `metadata.shortleash` against the same definition schema. Lifecycle events are projected as idempotent notes such as `[shortleash:name] started: running`; the adapter does not close the issue or replace the authoritative state. `reconcile` reports a missing Bead or manual closure while the Shortleash state is non-terminal/non-completed as drift.

The OMP extension registers `/shortleash run`, `plan`, `status`, `evaluate`, and `reconcile`, attaches the dashboard, handles Beads claim hooks, and keeps no-agent definitions in the current OMP session.

## Deliberate non-goals

Shortleash does not create a Beads child for every agent, treat prompt instructions as enforcement, or repeat an entire graph to simulate batch processing. Repeated or accumulative work should be represented explicitly in the task and its durable artifacts, or decomposed into separate tracker work items. Custom policy modules remain the differentiator; graph visualization and host adapters are optional presentation and execution layers.

## Verification surface

The repository tests cover definition parsing and metadata validation, dependency waves, state persistence and recovery, policy capture/evaluation, same-session corrective attempts, executor options, Beads projection/reconciliation, extension command handling, and TUI rendering.
