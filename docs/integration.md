# Shortleash integration

Shortleash integrates two existing surfaces: an OMP extension for interactive runs and an argv-based Beads adapter for definitions stored on issues. The execution and policy contracts are shared across those surfaces.

## Inputs and planning

A definition is JSON with a top-level `shortleash` object; the legacy top-level `swarm` key is accepted when it is the only definition key. The parser accepts named agents, `waits_for`/`reports_to` relationships, optional workspace isolation/history inheritance, and top-level or agent-scoped policy references.

New definitions and serialized examples use `shortleash` consistently across the definition format, package APIs, commands, metadata, state paths, and policy module paths.

A Beads input is an issue ID or `issue://<id>`. The adapter reads:

```bash
bd show <id> --json
```

and validates the object under `metadata.shortleash` with the same parser and semantic graph checks used for files. Other metadata remains outside the Shortleash definition. `plan` resolves the input, loads exactly the referenced `.ts` policy modules, validates references, detects cycles, and prints the topological waves.

```text
/shortleash plan path/to/shortleash.json
/shortleash plan issue://shrtlsh-123
```

The plan is not execution state. A run creates `<workspace>/.shortleash_<name>/` and persists its state there.

## OMP extension

The package exposes `./src/extension.ts` as its OMP extension entrypoint. The extension registers:

```text
/shortleash run <file.json|issue-id> [--resume|--restart]
/shortleash plan <file.json|issue-id>
/shortleash status <name> [--json]
/shortleash evaluate <file.json|issue-id> [--json]
/shortleash reconcile <file.json|issue-id> [--json]
```

Declared-agent runs attach the Shortleash dashboard and execute workers through OMP's structured subagent API. OMP resolves the configured `agent` profile (or the default `task` profile), constructs the child session, applies the host tool/isolation policy, and returns the normalized worker result. Agents in a runnable dependency wave are bounded by the host `task.maxConcurrency` setting; later waves wait for dependencies.

A definition without `agents` is intentionally different: it sends its task to the current OMP session. The extension captures the session's final result, runs the same policy boundaries, persists attempt history, and sends corrective feedback as a follow-up message when policy rejects the attempt.

The extension also registers Beads hooks. A simple `bd show` call is validated and rendered through the documented Bash surface; complex shell commands are not rewritten. A valid direct `bd update <id> --claim` with `metadata.shortleash` starts the persisted run after the claim succeeds. Existing running or completed state is not silently duplicated.


## Gas City backend

`/shortleash run <file.json|issue-id> --gascity` validates the definition, snapshots referenced policy modules, writes executable policy bridges, cooks a Gas City v2 workflow, and routes its root to the configured target. The extension defaults to the `omp` target; pass `--gascity-target <target>` for another configured agent or pool. An epic input gets one Shortleash bridge child; a non-epic input is attached directly. The persisted materialization identity lives under `<city>/.omp/shortleash/gascity/<formula>/`.

The extension performs the equivalent of:

```text
gc formula cook <formula>
gc sling <target> <root-bead-id> --no-formula
gc bd ready
gc status
```

Gas City policy steps invoke the same TypeScript policy registry through a content-hash-verified bridge. A rejected check/evaluator exits non-zero and leaves the Gas City workflow blocked; bridge history and result artifacts are stored beside the workflow. Gas City owns scheduling, worker sessions, retries, and workflow state after routing. OMP-only worktree/history inheritance and `agent_timeout_ms` settings are reported as warnings and must be configured in Gas City/provider settings.

## Durable run contract

`StateTracker` owns the run lock, JSON persistence, normalization of recoverable state, and update methods. The persisted record contains definition identity, agent states, attempt-indexed results, policy decisions, policy observations, projection history, and the optional run manifest.

```text
<workspace>/.shortleash_<name>/
  run.lock
  state/pipeline.json
  logs/orchestrator.log
  logs/<agent>.log
  context/
```

State writes are serialized and use a temporary file, `fsync`, rename, and directory synchronization. The lock contains the process ID, run ID, definition hash, workspace, and start time. A live lock is rejected. A stale lock is removed only in the explicit resume/restart recovery path.

`/shortleash run ... --resume` restores non-failed latest results and reruns missing or failed agents. Compatibility requires the definition hash, workspace, and agent set to match. A completed persisted run requires `/shortleash run ... --restart`; restart intentionally creates a fresh state snapshot after acquiring a recoverable lock.

## Worker and policy sequence

For each topological wave:

1. Mark runnable agents in durable state.
2. Execute the agents subject to the host's `task.maxConcurrency` setting and the configured timeout.
3. Capture optional agent-scoped before/after observations.
4. Evaluate agent policies during finalization.
5. If rejected, send findings to the same worker session journal and persist the next attempt.
6. Evaluate wave policies and apply `failure_policy`.
7. After the graph, evaluate completion policies and persist the terminal status.

For `workspace_isolation: worktree`, OMP closes isolated sessions after each turn. Shortleash therefore reopens the same child session journal in a fresh isolated invocation for corrective attempts, so each correction retains transcript context and produces a mergeable patch.

Checks and evaluators are direct `.ts` modules. A check file default-exports `{ description, check }`; an evaluator file default-exports `{ version, description, evaluate }`. References are paths relative to the definition file, or `{ path, params }` objects for scalar parameters. A check returns a boolean or structured result. An evaluator returns an outcome, explanation, findings, and evidence references. Supported policy boundaries are `agent`, `wave`, and `complete`; a blocking rejection prevents a completed run. Policy context includes the normalized definition, paths, boundary, optional attempt/wave/agent, scalar reference parameters, latest results, result history, and current durable state.
OMP-hosted policy contexts also expose optional `context.judge({ prompt, outputSchema, agent?, model?, schemaMode? })`. It uses a separate durable structured-subagent child session and returns parsed data plus a `shortleash://` evidence reference. Standalone and Gas City policy execution does not provide a host-backed judge.


The graph is executed once. Corrective attempts are bounded follow-up turns for the same worker; they are not target counts, batch iterations, or repeated graph passes.

## Beads projection

Beads is an input and operator-visible projection, not the workflow state authority. `createShortleashBeadsProjector` appends idempotent lifecycle notes to the existing issue, for example:

```text
[shortleash:streaming-retry] started: running
[shortleash:streaming-retry] completed: completed — 0 error(s)
```

The projector preserves existing notes and never closes the issue. Reconciliation reports a missing issue or manual closure while the persisted Shortleash run is not completed as drift. Completion is valid only when the persisted state is `completed` after its policy boundaries pass.

## Deliberate scope

The core does not create one Beads child per agent, expose arbitrary `bd` commands as a new model-facing tool, or replace the host's OMP task/subagent primitives. Beads, graph rendering, and the dashboard are adapters and presentation. The direct policy module boundary is the part that enforces project-specific implementation checks and evaluations.

## Verification

From the repository root:

```bash
bun install
bun run check
bun run test
```
