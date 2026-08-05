# Beads-native OMP workflow runtime

This implementation attaches one durable workflow journal and one persistent OMP logical session to an existing Beads item. The journal is authoritative for workflow protocol state; Beads is the operator-visible projection.

## Verified integration surfaces

The workstation currently provides:

```text
omp/17.2.5
bd version 1.1.2 (dev)
```

OMP is integrated through its documented extension API:

- `omp --extension <file>` loads a TypeScript/JavaScript extension factory.
- `pi.registerTool(...)` registers model-callable operations. Tool parameters use `pi.zod`.
- Workflow tools set the real `loadMode: "essential"` option so they appear in OMP's active tool list; the default extension-tool mode is discoverable rather than top-level.
- `pi.on(...)` exposes lifecycle and tool events.
- `pi.appendEntry(customType, data)` persists extension data in the OMP session JSONL.
- `ctx.sessionManager.getBranch()` is the documented reconstruction hook for extension state.
- OMP's file-backed sessions support `--continue`, `--resume`, and `--session-dir`.

Beads is integrated through its actual CLI because this repository has no Beads TypeScript package:

- `bd show <id> --json` reads the existing work item.
- `bd update <id> --set-metadata key=value` projects compact workflow metadata.
- `bd update <id> --append-notes ...` writes human-visible progress.
- `bd comment <id> ...` records structured failure summaries for operators.

`.beads/` and its Dolt database remain the projection store for operator-visible work state. `.omp/workflow-journal/<bead>.jsonl` is the authoritative append-only event history; its snapshot sidecar only accelerates inspection and never replaces events.

## Public contract

```ts
const feature = defineWorkflow({
  bead: "data-streaming-mega-epic",
  version: 1,
  stages: {
    implement: ompStage({
      rules: [customRule("architecture", architectureRule)],
      must: [
        output("implementation-result", ImplementationResult),
        customRequirement("verified", verificationRequirement),
      ],
      evals: [customEval("architecture-conformance", architectureEval)],
      transitions: {
        completed: "validate",
        blocked: "blocked",
      },
    }),
    validate: ompStage({
      must: [output("validation-result", ValidationResult)],
      evals: [customEval("acceptance-criteria", acceptanceCriteriaEval)],
      transitions: {
        accepted: "complete",
        changesRequired: "implement",
      },
    }),
  },
});
```

`rules`, `must`, and `evals` are declared by the workflow author. The runtime also accepts an agent-owned `plan` and durable `obligations`; neither is represented as an unenforced prompt rule.

- `rules` run against structured workflow activity and can reject it.
- `must` checks declared outputs or custom requirements before a normal transition.
- `evals` run the workflow author's domain-specific function and are normalized to a structured result containing outcome, findings, explanation, evidence references, repository revision, and evaluator version.
- `obligations` are stateful records. Blocking open/reopened obligations affecting a requested target reject the transition.
- `plan` revisions are explicit events. Amendments cannot remove existing objectives, milestones, or acceptance-criterion coverage.
- `transitions` is the allowlist of stage changes; OMP proposes them, but only the runtime commits accepted transitions.

## Runtime sequence

1. `BdCli` reads the existing item and `FileWorkflowJournal` loads the event history.
2. The runtime validates the workflow identity, reduces events into authoritative state, and bootstraps a `workflow_initialized` event plus `obligation_created` events for declared initial obligations only when no history exists.
3. OMP loads the extension and receives essential transition/output/blocker tools. The CLI enables `OMP_WORKFLOW_EXTENDED_TOOLS=1`, which adds plan proposal/amendment, evidence, decision, evaluator, and obligation create/update operations.
4. Each mutating operation validates its input, commits an idempotent event, reduces authoritative state, snapshots it, and projects compact metadata to Beads.
5. A transition request checks requirements, rules, blocking obligations, and evaluators. Rejections are durable `transition_rejected` events; the stage does not change.
6. A failed evaluator is saved as a subordinate artifact with structured findings, commented on the Bead, and returned as structured tool details.
7. The same logical OMP session receives the findings and can submit corrected output or evidence; no agent handoff is required.
8. `reconcile` compares Beads with the journal. Manual Beads closure while the authoritative workflow is active is reported as drift and is never converted into completion.

The stage, workflow identity/version, blocker, session reference, and artifact references are projected into Beads metadata. The full authoritative state is reconstructed from `.omp/workflow-journal/`; large output/evaluation JSON remains below `.omp/workflow-artifacts/`.

Metadata keys include:

```text
workflow_name
workflow_version
workflow_stage
workflow_session
workflow_blocker
workflow_output_<encoded-output-id>
workflow_eval_<encoded-eval-id>
```

The encoded suffix preserves output/evaluation IDs while satisfying Beads metadata-key syntax.

## Running OMP

The project extension is `.omp/extensions/workflow-runtime.ts`. Start a persistent session with an explicit logical session reference:

```bash
bun run src/cli.ts start \
  --session-ref data-streaming-omp-1 \
  --session-dir .omp/sessions
```

Resume the same OMP session after the host process exits:

```bash
bun run src/cli.ts resume \
  --session-ref data-streaming-omp-1 \
  --session-dir .omp/sessions
```

The CLI passes the extension to the installed `omp` binary and uses OMP's own file-backed session handling. It does not create a fresh task loop or hand work to another agent.
Within OMP, the loaded extension also provides a local `/workflow-status` command for the Beads-backed stage and blocker.

Inspect the current Beads-backed stage without starting OMP:

```bash
bun run src/cli.ts inspect \
  --workflow src/reference-workflow.ts
```

Run an evaluator or inspect projection drift without starting OMP:

```bash
bun run src/cli.ts evaluate \
  --workflow src/reference-workflow.ts \
  --evaluator architecture-conformance

bun run src/cli.ts reconcile \
  --workflow src/reference-workflow.ts

# Repair safe projection drift; manual closure of an active workflow is reported, not overwritten.
bun run src/cli.ts reconcile \
  --workflow src/reference-workflow.ts \
  --repair
```

The reference workflow uses the placeholder Bead ID `data-streaming-mega-epic`; author a workflow module with the real Bead ID before running it against a project.

## Operator playbook

1. Create or identify the existing Beads epic. Do not create a Bead for each shell command or internal thought. Create child Beads only for a meaningful milestone, external blocker, human decision, or discovered follow-up.
2. Author a workflow module from `defineWorkflow(...)` using the real epic ID. Declare stages, legal transitions, outputs, requirements, rules, evaluators, completion requirements, the initial agent-owned plan, and any known obligations.
3. Start one logical OMP execution:

   ```bash
   bun run src/cli.ts start --session-ref epic-omp-1 --session-dir .omp/sessions
   ```

   Tell OMP to investigate the repository and use the structured workflow tools. It may propose and amend the plan, submit outputs/evidence, record decisions, report blockers, request evaluators, and propose transitions. It must not treat prose, a test command, a closed Bead, or its own claim as authoritative acceptance.
4. During discovery and implementation, submit durable evidence with `workflow_submit_evidence`, record architecture decisions with `workflow_record_decision`, and use `workflow_propose_plan` or `workflow_amend_plan` for every plan revision. Amendments require an explicit base revision and reason; the runtime rejects removal of existing objective, milestone, or acceptance-criterion coverage.
5. If a transition is rejected, read the structured failure details. A missing output requires `workflow_submit_output`; a failed rule requires the underlying implementation or decision change; a failed evaluator requires corrective work and a new evaluation. Do not bypass the rejection by asking OMP to declare the stage complete.
6. If a new blocking obligation appears, inspect its trigger, affected transitions, and required evidence. Produce the evidence, then call `workflow_update_obligation` with `status: "satisfied"` and the evidence references. A failed or reopened obligation remains blocking until the runtime accepts its resolution. If the work is external, report it with `workflow_report_blocked` and create one externally meaningful Bead linked to the epic.
7. When an evaluator fails, keep the same `--session-ref`. OMP should amend the plan if the corrective work changes scope, submit the corrected output/evidence, call `workflow_request_evaluation` again, and only then retry `workflow_request_transition`. The prior failed result remains in the journal and is not overwritten.
8. After a host restart, resume rather than start a new logical execution:

   ```bash
   bun run src/cli.ts resume --session-ref epic-omp-1 --session-dir .omp/sessions
   ```

   The runtime reloads `.omp/workflow-journal/<epic>.jsonl`, reduces authoritative state, restores obligations and evaluator results, and steers the resumed session with the current state.
9. Before accepting completion, run the evaluator and inspect the journal-backed status:

   ```bash
   bun run src/cli.ts evaluate --workflow path/to/workflow.ts --evaluator acceptance-criteria
   bun run src/cli.ts reconcile --workflow path/to/workflow.ts
   ```

   Repair only safe projection drift with `reconcile --repair`. Manual Beads closure of an active workflow is reported as drift and must not be used as a completion shortcut. Completion is valid only after the declared evaluators pass, all affected blocking obligations are satisfied, required evidence exists, and the runtime commits the final transition.

## Limitations

- The installed OMP 17.2.5 binary supports the documented `--extension` path; the CLI intentionally omits `--no-extensions` for compatibility with older installed versions. Use a dedicated OMP profile if ambient extensions must be isolated.
- The installed OMP binary is available, but no OMP SDK package is a repository dependency. The extension intentionally uses the documented factory/tool shape without importing an unverified package.
- The extension API does not expose a documented session-file path directly to extension code. The CLI therefore requires `--session-ref`; OMP owns the actual session file and resume behavior.
- Beads metadata is a compact projection, not authoritative protocol state. Large artifacts are references from the journal and remain subordinate to the Bead.
- Rules and evaluations are user-authored functions. The framework supplies context, execution, structured results, transition blocking, and reporting; it does not fabricate architecture or acceptance judgments.

## Verification

```bash
bun run test
```

The tests cover illegal and failed transitions, required outputs, structured OMP tools, event-journal restart recovery, idempotent operations, plan integrity, obligation enforcement, projection drift, process-style runtime recreation with the same session reference, real `bd` metadata/status writes in a disposable Beads workspace, artifact references, and accepted corrective transitions.
