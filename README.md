# Shortleash

Multi-agent orchestration for oh-my-pi. Define agent workflows in JSON or YAML — pipelines, parallel fan-outs, sequential chains, or any DAG — and run them unattended until completion.

Each agent is a full oh-my-pi subagent with access to every tool: bash, python, read, write, edit, grep, find, fetch, web_search, browser. The orchestrator manages lifecycle and ordering; agents communicate through the shared workspace filesystem.

Use it for anything: research pipelines, code generation, data processing, content creation, analysis workflows, CI-like automation — any multi-step task that benefits from specialized agents working in coordination.

## Setup

```bash
cd packages/shortleash
bun install
```

Swarm definitions accept the same structure in either `.json` or `.yaml`/`.yml` files.

## Running

### Standalone (recommended for long-running work)

```bash
# Foreground — runs until complete, no timeout:
omp-shortleash path/to/swarm.yaml

# Beads issue input also works:
omp-shortleash obligated-gty
omp-shortleash issue://obligated-gty
  > pipeline.log 2>&1 & disown
```

The standalone runner has no timeout. It runs iteration after iteration until the pipeline finishes or you kill it.

### Restart and resume

The state directory is the durable execution record. A second run does not silently overwrite it:

```bash
# Continue the unfinished logical run after a host restart.
omp-shortleash path/to/swarm.yaml --resume

# Intentionally discard the prior run and start a new one.
omp-shortleash path/to/swarm.yaml --restart
```

`--resume` requires the persisted definition hash, agent set, mode, workspace, and target count to remain compatible. Successful results already recorded for the unfinished iteration are reused; only missing or failed work runs again. A valid stale `run.lock` is recoverable only with `--resume` or `--restart`; a corrupt lock is never removed automatically.

Run evaluators against the persisted results without starting agents:

```bash
omp-shortleash evaluate path/to/swarm.yaml --json
```

Evaluation writes the structured policy decision to `state/pipeline.json`; a blocked decision exits non-zero but does not silently mark the pipeline complete.

### Inside oh-my-pi (TUI)

Register the extension in your project settings (`.omp/settings.json`) or user settings (`~/.omp/agent/settings.json`):

```json
{
	"extensions": ["/absolute/path/to/oh-my-pi/packages/shortleash"]
}
```

Then:

```
/shortleash run path/to/swarm.yaml
/shortleash run obligated-gty
/shortleash run issue://obligated-gty
/shortleash status <name>
/shortleash evaluate obligated-gty --json
/shortleash reconcile obligated-gty
/shortleash help
```
While `/shortleash run` or a metadata-backed Beads claim is active, the TUI shows a compact widget below the editor. Press `Alt+W` to open a colorized, animated right-anchored dashboard overlay; nodes are arranged by dependency depth, edges show the DAG, and up to five recent native tool actions are shown for each active worker. Press `c` or `Ctrl+C` in the dashboard to cancel the active run; `q`, `Esc`, or `Alt+W` only closes the dashboard and restores the editor.

### Herdr-backed Beads runs

When a Beads issue contains valid `metadata.shortleash`, the Beads `claim` operation delegates to the persisted Shortleash runner. Definitions with declared `agents` use Herdr when available:


1. The tab is labeled `shortleash: <name>` and its initial pane runs the live swarm dashboard.
2. The current DAG wave gets one visible agent pane per runnable agent.
3. Agents in a wave execute concurrently; each pane is closed in its `finally` path when that agent completes or fails.
4. The next wave opens only after the previous wave's panes have closed, so a diamond `1-3-1` run reuses one tab while rotating `1`, then `3`, then `1` agent panes.
5. The tab is closed after the persisted run reaches a terminal state.

When `metadata.shortleash.agents` is omitted, claim execution stays in the current OMP session instead of creating a Herdr tab or subagent. The extension still creates the durable run state, evaluates the configured policies at the start and completion boundaries, records the result, and reports completion or corrective feedback through the same session.

Start Herdr from an interactive terminal so its server inherits the PATH needed by spawned agents:

```bash
herdr
herdr status
```

The default worker kind is `omp`; set `OMP_SWARM_HERDR_AGENT` to another Herdr-supported kind when required. Set `OMP_SWARM_HERDR=off` to force the existing in-process executor. Worktree-isolated swarms also use the in-process executor because a single visible tab cannot safely represent independent worktree lifecycles. If Herdr is missing, stopped, or returns an invalid pane response, the extension closes any tab it created and falls back without losing the durable Shortleash state.

The integration delegates argv-safe CLI execution to the `@andrewjacop/pi-herdr` dependency. Its current package surface has no runtime export, so the adapter isolates the source-path import; no private OMP APIs are used. OMP workers submit prompts without relying on Herdr's agent state transition (the installed OMP binary can remain `idle` while work runs); the adapter polls the pane's active-work marker before reading the result.

## Monitoring

State persists to `<workspace>/.swarm_<name>/` while the pipeline runs:

```
.swarm_<name>/
  state/pipeline.json    # Live pipeline + per-agent status
  logs/orchestrator.log  # Wave transitions, iteration progress
  logs/<agent>.log       # Per-agent timestamps and errors
  context/               # Agent session artifacts
```

Check on a running pipeline:

```bash
# Quick status
cat workspace/.swarm_mypipeline/state/pipeline.json | python -m json.tool

# Watch the orchestrator log
tail -f workspace/.swarm_mypipeline/logs/orchestrator.log
```

---

## JSON/YAML Reference

Every swarm is a single JSON or YAML file with a top-level `swarm` key:

```yaml
swarm:
  name: my-pipeline # Identifier (state stored in .swarm_<name>/)
  workspace: ./workspace # Working directory (relative to the definition file location)
  task: "Complete this objective directly." # Optional; used when agents is omitted.
  mode: pipeline # pipeline | parallel | sequential
  target_count: 10 # Iterations (pipeline mode only, default: 1)
  model: claude-opus-4-6 # Default model for agents without an override (optional)
  workspace_isolation: none # none | worktree; default: none
  inherit_history: false # pass the current OMP branch to workers; default: false
  failure_policy: skip_dependents # fail_fast | continue | skip_dependents
  max_concurrency: 4 # Optional per-wave agent limit
  agent_timeout_ms: 3600000 # Optional per-agent timeout

  plugins:
    - ./policies/obligations.ts
  checks:
    - obligations:architecture-boundary # Inherited by every declared agent; direct definitions evaluate it in the current session.
    - obligations:acceptance-evidence
  evals:
    - obligations:architecture-evaluator

  agents:
    first_agent:
      role: short-role-name
      task: |
        Full instructions for this agent.
      extra_context: |
        Optional additional system prompt text.
      reports_to:
        - downstream_agent
      waits_for:
        - upstream_agent
      model: claude-sonnet-4-5 # Optional per-agent override
      workspace_isolation: worktree # Optional per-agent override
      inherit_history: true # Optional per-agent override; TUI runs only
      checks:
        - obligations:architecture-boundary
        - obligations:acceptance-evidence
      evals:
        - obligations:architecture-evaluator
```

When `agents` is omitted, `/shortleash run` queues `task` in the current OMP session and never invokes a subagent. The top-level `checks` and `evals` are evaluated for that session. When agents are declared, those top-level policy references are inherited by every agent and run before any agent-local references.

The equivalent JSON form uses the same snake_case field names:

```json
{
	"swarm": {
		"name": "my-pipeline",
		"workspace": "./workspace",
		"mode": "pipeline",
		"target_count": 10,
		"model": "claude-opus-4-6",
		"agents": {
			"first_agent": {
				"role": "short-role-name",
				"task": "Full instructions for this agent.",
				"extra_context": "Optional additional system prompt text.",
				"reports_to": ["downstream_agent"],
				"waits_for": ["upstream_agent"],
				"model": "claude-sonnet-4-5",
				"checks": ["obligations:architecture-boundary", "obligations:acceptance-evidence"],
				"evals": ["obligations:architecture-evaluator"]
			}
		}
	}
}
```

### Beads-backed definitions

The TUI and standalone runner also accept a bare Beads ID or an `issue://` reference. The runner executes `bd show <id> --json` in the current project and reads the issue's `metadata` object:

```text
/shortleash run obligated-gty
/shortleash run issue://obligated-gty
```

A Beads metadata object must contain the standard swarm definition under `metadata.shortleash`; it is not a separate compact schema:

```json
{
	"shortleash": {
		"name": "streaming-retry",
		"workspace": ".",
		"mode": "sequential",
		"agents": {
			"backend": {
				"role": "backend",
				"task": "Implement streaming retry logic."
			}
		}
	}
}
```

The value under `metadata.shortleash` uses exactly the same structure as a file definition. Other metadata such as `workflow`, `acceptance`, or `risk` is preserved by Beads but is not interpreted as swarm configuration.

### Beads projection and reconciliation

When the input is a Beads issue, lifecycle events are projected as notes on that issue. The adapter uses the installed CLI contract (`bd show <id> --json` followed by `bd update <id> --notes ...`) and preserves existing notes. It never closes the issue: the workflow state and its accepted result remain authoritative.

Inspect projection drift after a process restart or operator change:

```bash
omp-shortleash reconcile obligated-gty --json
```

The command compares the persisted authoritative Shortleash status with the projected Bead status and reports missing projections. A manually closed Bead while the Shortleash run is not `completed` is reported as drift and returns a non-zero status; it is not silently converted into workflow completion.

### Top-Level Fields

| Field          | Required | Default         | Description                                                                    |
| -------------- | -------- | --------------- | ------------------------------------------------------------------------------ |
| `name`         | yes      | —               | Pipeline identifier. State directory is `.swarm_<name>/`                       |
| `workspace`    | yes      | —               | Shared working directory. Relative paths resolve from the definition file location |
| `mode`         | no       | `sequential`    | Execution mode (see below)                                                     |
| `target_count` | no       | `1`             | How many times to repeat the full pipeline. Only meaningful in `pipeline` mode |
| `model`        | no       | session default | Default model for agents that do not set `agents.<name>.model`                |
| `workspace_isolation` | no       | `none`          | Worker isolation mode. `worktree` uses the existing OMP isolation lifecycle and merges the captured patch back. |
| `inherit_history`    | no       | `false`         | Copy the current interactive OMP branch into the worker session before its task. Standalone runs cannot inherit a parent conversation. |
| `plugins`      | no       | auto-discovered | Code module paths, resolved relative to the definition file                   |
| `checks`       | no       | `[]`            | Blocking check references (`plugin:id`)                                      |
| `evals`        | no       | `[]`            | Structured evaluator references (`plugin:id`)                                  |

### Agent Fields

| Field           | Required | Description                                                                                  |
| --------------- | -------- | -------------------------------------------------------------------------------------------- |
| `role`          | yes      | Short role identifier — becomes the agent's system prompt                                    |
| `workspace_isolation` | no       | Global value | Per-agent isolation override: `none` or `worktree`. |
| `inherit_history`    | no       | Global value | Per-agent parent-history override: boolean, `parent`, or `none`. |
| `task`          | yes      | Complete instructions sent as user prompt. Use JSON strings or YAML `|` for multi-line       |
| `extra_context` | no       | Additional text appended to system prompt                                                    |
| `model`         | no       | Model override for this agent only                                                           |
| `reports_to`    | no       | List of agent names that depend on this agent                                                |
| `waits_for`     | no       | List of agent names this agent depends on                                                   |
| `checks`        | no       | Agent-scoped blocking check references (`plugin:id`)                         |
| `evals`         | no       | Agent-scoped structured evaluator references (`plugin:id`)                                  |


### Code-defined policy plugins

Policy modules use the same small, code-loaded extension shape as tools. They are not prompt instructions: the swarm controller executes them at declared DAG boundaries and records the structured result in `.swarm_<name>/state/pipeline.json`.

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
        evidenceRefs: ["workspace://ARCHITECTURE.md"],
      }),
    });

    api.registerCheck({
      id: "acceptance-evidence",
      description: "Every completion claim has evidence.",
      boundary: "complete",
      check: ({ latestResults }) => latestResults.size > 0,
    });

    api.registerEval({
      id: "architecture-evaluator",
      version: "1",
      description: "Checks the architecture evidence.",
      boundary: "complete",
      evaluate: ({ latestResults }) => ({
        outcome: latestResults.size > 0 ? "pass" : "fail",
        explanation: "The evaluator inspected the latest agent results.",
        findings: [],
        evidenceRefs: ["workspace://ARCHITECTURE.md"],
      }),
    });
  },
});
```

Discovery order is project-local `.omp/swarm/`, project-local `.swarm/plugins/`, enabled plugin packages, then paths listed in `swarm.plugins`. A directory may expose `index.ts` or one level of module files. Installed plugin packages may declare `omp.swarm` or provide a conventional `swarm/` directory.

`checks` return a boolean or `{ passed, message, findings, evidenceRefs }`; failures block the current boundary. `evals` return `{ outcome, explanation, findings, evidenceRefs }`. A failed evaluation blocks by default; set `blocking: false` for advisory findings. Supported boundaries are `wave`, `iteration`, and `complete`; omitted boundaries run at `complete`.
The same `checks` and `evals` fields may be declared under `agents.<name>`. Top-level references run against the whole swarm; agent-scoped references run with `context.agent` set to that agent and are aggregated into the boundary decision. Both scopes are validated before execution.

#### Parameterized references and attempt snapshots

Policy references can carry a validated scalar parameter object. The same policy can therefore be configured more than once without duplicating plugin code:

```yaml
checks:
  - plugin: git
    id: changed-files
    params:
      extension: ".rs"
      minimum: 3
      include_untracked: true
```

String references remain valid. Inline parameters use `::key=value` segments (values are decoded as strings, finite numbers, booleans, or `null`), for example `git:changed-files::extension=.rs::minimum=3`.

Policy callbacks receive the normalized values as `context.params`. A check or evaluator may also define `capture(context)`. The runtime captures `before` and `after` snapshots for each agent attempt, passes the pair as `context.observation`, and persists the snapshots in `.swarm_<name>/state/pipeline.json` keyed by agent, iteration, attempt, and policy reference. Capture values should be durable, JSON-serializable references such as a Git status record or a Nix profile snapshot.

Agent-scoped blocking policies are checked before finalization. A rejection is returned as structured corrective feedback to the same keep-alive OMP session, which may continue through follow-up turns. If the policy remains rejected after the runtime retry budget, the agent fails instead of finalizing. Evaluators registered with `blocking: false` remain advisory and do not reject the boundary.

### Execution Modes

**`pipeline`** — Repeat the full agent graph `target_count` times. Each iteration runs all waves in order. Use for accumulative work: "find 50 things, one per iteration."

**`sequential`** — Run agents once, chained by declaration order (unless explicit dependencies override). The default mode.

**`parallel`** — Run all agents simultaneously (unless explicit dependencies impose ordering).

### Dependency Resolution

The orchestrator builds a DAG from `waits_for` and `reports_to`, then groups agents into **waves** using topological sort. Agents in the same wave run in parallel; waves execute in sequence.

- `waits_for: [a, b]` — this agent won't start until both `a` and `b` finish
- `reports_to: [x]` — equivalent to `x` having `waits_for: [this_agent]`
- No explicit deps + `pipeline`/`sequential` mode — agents chain by definition declaration order
- No explicit deps + `parallel` mode — all agents run in one wave
- Cycles are detected and rejected before execution

---

## Patterns

### Pipeline: Iterative Accumulation

Run the same agent chain N times. Each iteration builds on the previous one's output. Good for: research collection, data gathering, batch processing, iterative refinement.

```yaml
swarm:
  name: research-collector
  workspace: ./workspace
  mode: pipeline
  target_count: 25
  model: claude-opus-4-6

  agents:
    finder:
      role: researcher
      task: |
        Find ONE new source on the topic defined in workspace/topic.md.

        1. Read processed.txt to see what's already been found
        2. Use web_search to find a new, high-quality source
        3. Append the URL to processed.txt
        4. Write the URL to signals/finder_out.txt: FOUND:<url>

    analyzer:
      role: analyst
      task: |
        Read signals/finder_out.txt for the URL.
        Fetch the page and extract key findings.
        Read tracking/count.txt, increment it, write back.
        Write analysis to analyzed/item_<N>.md
        Write to signals/analyzer_out.txt: DONE:<N>

    compiler:
      role: technical-writer
      task: |
        Read signals/analyzer_out.txt for the item number.
        Read analyzed/item_<N>.md.
        Append a summary to output/report.md under a new section.
```

After 25 iterations: 25 sources found, analyzed, and compiled into a single report.

### Fan-In: Parallel Specialists

Multiple agents work independently, one synthesizer combines results. Good for: multi-perspective analysis, parallel code review, comprehensive audits.

```yaml
swarm:
  name: codebase-audit
  workspace: ./workspace

  agents:
    security:
      role: security-auditor
      task: |
        Audit all code in src/ for security vulnerabilities.
        Write findings to reports/security.md with severity ratings.
      reports_to:
        - lead

    performance:
      role: performance-analyst
      task: |
        Profile and analyze src/ for performance bottlenecks.
        Write findings to reports/performance.md with benchmarks.
      reports_to:
        - lead

    architecture:
      role: architecture-reviewer
      task: |
        Review src/ for architectural issues, coupling, and tech debt.
        Write findings to reports/architecture.md with refactoring suggestions.
      reports_to:
        - lead

    lead:
      role: engineering-lead
      task: |
        Read all reports in reports/.
        Create a prioritized action plan in output/action_plan.md.
        Rank issues by impact and effort.
      waits_for:
        - security
        - performance
        - architecture
```

Execution: security + performance + architecture run in parallel (wave 1), lead starts after all three complete (wave 2).

### Sequential Chain: Staged Handoff

Linear progression through distinct phases. Good for: content pipelines, multi-stage processing, review chains.

```yaml
swarm:
  name: blog-post
  workspace: ./workspace
  mode: sequential

  agents:
    researcher:
      role: researcher
      task: |
        Research the topic in topic.md using web_search.
        Write raw findings and source links to research/notes.md

    writer:
      role: technical-writer
      task: |
        Read research/notes.md.
        Write a complete blog post draft to drafts/post.md.
        Include code examples where relevant.

    editor:
      role: editor
      task: |
        Read drafts/post.md.
        Fix grammar, improve flow, tighten prose.
        Rewrite to drafts/post.md.

    reviewer:
      role: senior-reviewer
      task: |
        Read drafts/post.md.
        Check technical accuracy against research/notes.md.
        Add an editorial note at top if issues found, otherwise
        copy to output/final.md.
```

Execution: researcher -> writer -> editor -> reviewer, one after another.

### Diamond: Fan-Out Then Fan-In

One planner, parallel workers, one integrator. Good for: divide-and-conquer, modular code generation, multi-file refactors.

```yaml
swarm:
  name: feature-implementation
  workspace: ./workspace

  agents:
    planner:
      role: architect
      task: |
        Read the feature spec in spec.md.
        Break it into independent implementation tasks.
        Write the plan to plan.md with file assignments.
      reports_to:
        - api
        - ui
        - tests

    api:
      role: backend-developer
      task: |
        Read plan.md for your assigned files.
        Implement the API layer. Write to src/api/.
      reports_to:
        - integrator

    ui:
      role: frontend-developer
      task: |
        Read plan.md for your assigned files.
        Implement the UI components. Write to src/ui/.
      reports_to:
        - integrator

    tests:
      role: test-engineer
      task: |
        Read plan.md for the full feature scope.
        Write integration tests to tests/.
      reports_to:
        - integrator

    integrator:
      role: tech-lead
      task: |
        Read plan.md and review all code in src/ and tests/.
        Wire everything together. Fix any integration issues.
        Run the tests and fix failures.
        Write status to output/done.md.
```

Execution: planner (wave 1) -> api + ui + tests in parallel (wave 2) -> integrator (wave 3).

### Hybrid: Mixed Dependencies

Any DAG is valid. Combine patterns freely.

```yaml
swarm:
  name: data-pipeline
  workspace: ./workspace
  mode: pipeline
  target_count: 10

  agents:
    scraper_a:
      role: web-scraper
      task: |
        Scrape data source A. Write to raw/source_a.json
      reports_to:
        - transformer

    scraper_b:
      role: web-scraper
      task: |
        Scrape data source B. Write to raw/source_b.json
      reports_to:
        - transformer

    transformer:
      role: data-engineer
      task: |
        Read raw/source_a.json and raw/source_b.json.
        Clean, normalize, merge. Write to processed/merged.json
      reports_to:
        - loader
        - validator

    validator:
      role: qa-analyst
      task: |
        Read processed/merged.json.
        Validate schema, check for anomalies.
        Write report to qa/validation.md

    loader:
      role: data-engineer
      task: |
        Read processed/merged.json.
        Append to output/dataset.jsonl
```

Execution per iteration: scraper_a + scraper_b (wave 1) -> transformer (wave 2) -> loader + validator (wave 3).

---

## Writing Agent Tasks

### What Agents Can Do

Each agent is a full oh-my-pi session. It can:

- **bash/python**: Run commands, scripts, install packages, process data
- **read/write/edit**: Create and modify files in the workspace
- **grep/find**: Search the workspace (or anywhere on disk)
- **web_search**: Search the internet (via configured provider)
- **fetch**: Download web pages, APIs, documents
- **browser**: Navigate websites, scrape dynamic content, take screenshots

### Inter-Agent Communication

The orchestrator starts and stops agents in the right order. It does **not** pass data between them. Agents communicate through files in the shared workspace.

Design your own protocol. Common patterns:

**Signal files** — lightweight status flags an agent writes when done:

```
signals/finder_out.txt    -> "FOUND:https://example.com"
signals/analyzer_out.txt  -> "DONE:42"
signals/reviewer_out.txt  -> "APPROVED" or "REJECTED:reason"
```

**Structured output** — detailed results other agents read:

```
analyzed/item_1.md        -> Full analysis document
results/report.json       -> Machine-readable data
output/final.docx         -> Accumulated deliverable
```

**Tracking files** — prevent duplicate work across pipeline iterations:

```
processed.txt             -> Items already handled (one per line)
tracking/count.txt        -> Current item counter
tracking/status.json      -> Cumulative state
```

### Tips for Reliable Agents

- **Be explicit about paths.** Agents start fresh each iteration — they don't remember previous runs. Tell them exactly where to read input and write output.
- **Check existing state.** In pipeline mode, tell agents to read tracking files before doing work: "Read processed.txt to avoid duplicates."
- **Use numbered outputs.** `item_1.md`, `item_2.md` etc. so iterations don't clobber each other.
- **Handle failure.** Tell agents what to do when things go wrong: "If the source lacks depth, write SKIP to signals/out.txt and explain why."
- **Keep signal files simple.** One line, parseable format. Complex data goes in structured output files.
- **Scope the task tightly.** An agent that tries to do five things will do zero well. One clear objective per agent.

---

## Models

Any model configured in omp works. Set a swarm default and optionally override per agent:

```yaml
swarm:
  model: claude-opus-4-6
  agents:
    writer:
      role: technical-writer
      task: |
        Write the draft.
    reviewer:
      role: reviewer
      model: claude-sonnet-4-5
      task: |
        Review the draft.
```

Precedence: `agents.<name>.model` → `swarm.model` → session default. Check `packages/ai/src/models.json` for available model IDs.

---

## Architecture

```
src/extension.ts                 TUI entry point (registers /shortleash command)
src/cli.ts                       Standalone runner (no TUI, no timeout)
src/orchestration/
  definition/
    schema.ts                    JSON/YAML parsing, normalization, and validation
    metadata.ts                  Beads metadata schema and validation
    plan.ts                      Input resolution, plugin loading, and executable plan
    manifest.ts                   Durable run manifest and definition fingerprint
  execution/
    dag.ts                       Dependency graph, cycle detection, topological sort
    executor.ts                  Spawns agents via oh-my-pi's runSubprocess
    pipeline.ts                  Iteration loop, policy boundaries, and projection
    state.ts                     Atomic filesystem state, run lock, history, and recovery
    auto.ts                      Claimed-Bead run lifecycle
    concurrency.ts               Bounded asynchronous work
    signals.ts                   Cancellation and timeout scopes
  policy/
    plugins.ts                   Code-defined policy registry and structured evaluations
    policy-types.ts              Shared policy result contracts
  adapters/
    beads.ts                     Workflow input, lifecycle projection, and drift reconciliation
    herdr.ts                     Herdr tab and agent-pane execution adapter
  presentation/
    dashboard.ts                 Live TUI widget and dashboard lifecycle
    render.ts                    Progress and execution-graph rendering
src/beads/
  client.ts                      Bounded argv/JSON Beads client
  tool.ts                        Discoverable OMP Beads tool
  render.ts                      Beads tool call/result cards
```
