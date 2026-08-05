# Obligation-driven workflow runtime architecture

## Authority boundary

The runtime journal is the protocol authority. A workflow state is reconstructed by reducing the ordered event stream in `.omp/workflow-journal/<bead>.jsonl`; the snapshot sidecar is an optimization only. The OMP conversation, a tool result, a test command, an evaluator paragraph, and a Beads status are inputs or projections, never authoritative state mutations.

| Concern | Authority | Allowed mutation |
| --- | --- | --- |
| Workflow definition and legal stage graph | `defineWorkflow` result | Workflow author before execution |
| Current stage, completion status, plan revision, obligations, evidence, evaluator results | `WorkflowRuntime` + `WorkflowJournal` | Validated runtime operations through committed events |
| OMP reasoning and implementation plan proposal | One persistent OMP logical session | OMP proposes; runtime validates and records |
| Operator-visible issue, status, notes, metadata | `BdCli` projection | Runtime projection/reconciliation only; manual edits are drift |
| Evaluation claim | Declared evaluator contract | Evaluator returns schema-checked structured result |
| Evidence | Immutable `EvidenceRef` event | `submitEvidence` records references; it does not assert acceptance |

`src/workflow.ts` contains the core model and transition engine. It does not import OMP, Beads, or Gas City packages. `src/journal.ts` supplies memory and JSONL persistence through the `WorkflowJournal` port. `src/beads.ts` is an argv-based Beads CLI adapter. `src/omp-extension.ts` exposes runtime-owned structured operations through the documented extension factory shape. `src/cli.ts` provides `start`, `resume`, `inspect`, `evaluate`, and `reconcile` operator entrypoints.

## Concepts kept separate

- **Instruction:** guidance in an OMP prompt. It can explain the next action but cannot enforce it.
- **Obligation:** a durable stateful requirement with provenance, blocking/advisory mode, affected transitions, required evidence, and resolution history.
- **Invariant:** a property expected to hold for every reduced state. Current invariants include ordered event sequences, workflow identity/version, and plan coverage preservation.
- **Transition guard:** a check executed against a requested transition. It can reject but cannot commit state directly.
- **Evaluator:** a declared procedure that assesses claims against explicit evidence. Its result contains outcome, findings, explanation, evidence references, repository revision, and evaluator version.
- **Evidence:** an immutable reference to an artifact, repository analysis, test result, decision, or operational observation. Evidence is not acceptance by itself.
- **Capability:** a structured operation made available to OMP. Capabilities validate inputs and call the runtime; they do not expose direct state mutation.
- **Milestone:** an externally meaningful plan or Beads projection boundary. Internal tool calls and journal events are not automatically Beads issues.

## Event model

Every event has an event ID, monotonic sequence, event type, timestamp, idempotency key, and structured payload. The initial event is `workflow_initialized`. Mutations use events such as:

- `output_submitted`, `evidence_submitted`, `evaluation_recorded`;
- `transition_rejected`, `transition_accepted`, `blocker_reported`;
- `plan_proposed`, `plan_amended`, `decision_recorded`;
- `obligation_created`, `obligation_updated`.

Appending validates the next sequence and ignores a repeated event ID or idempotency key. Reduction is deterministic and rejects gaps or a journal whose first event is not initialization. Accepted transitions are committed only after declared requirements, guards, blocking obligations, and required evaluator results pass. Rejections remain durable history and do not advance the stage.

## Plan integrity

The OMP owns plan content, but the runtime owns plan history. `proposePlan` and `amendPlan` record a revision and explicit reason. An amendment must name the base revision and cannot remove an existing objective, milestone, or acceptance criterion. Adding a new objective or subsystem remains visible as a new plan revision and can be accompanied by a decision or obligation event; it is never a silent replacement.

## Recovery and projection

A new runtime instance loads the same journal and logical `sessionRef`, reduces all events, restores open obligations and failed evaluator results, and resumes at the recorded stage. It does not create a fresh task loop or hand the work to another agent. Each successful mutation projects compact stage, status, blocker, session, and artifact references to the attached Bead. `reconcile` reports differences; safe repair is explicit. If an operator closes an active projected Bead, reconciliation reports the divergence and does not convert that closure into workflow completion.

## End-to-end contract

```text
OMP proposes structured operation
  -> runtime validates input and loads journal state
  -> guards, obligations, and evaluators run against declared evidence
  -> runtime commits an idempotent authoritative event
  -> reducer produces the next state and snapshot
  -> Beads projection is updated
  -> OMP receives structured result and current state
```

The reference tests exercise the critical path: durable initialization, obligation-blocked transition, evidence submission, evaluator failure, same-session correction, accepted transition, process-style recovery, and Beads projection drift.
