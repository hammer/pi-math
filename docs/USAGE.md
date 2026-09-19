# User guide

New to models or agents? Begin with the [step-by-step onboarding guide](ONBOARDING.md).

## What the human controls

Pi Math organizes exploration and review; humans choose the target, approve a strategy and proof architecture, judge the evidence, and accept or reject the final argument. Only explicit `/math` commands can approve a route or plan, change an existing target, promote a premise, or record acceptance. Those operations are absent from model-callable tool schemas. Ordinary Pi tools remain subject to Pi's own permissions; this extension is not a security boundary against a parent agent with general shell access.

At each gate, use `/math status` and `/math export`. The Markdown dossier contains the draft, assumptions, section review, knowledge and prior attempts. The JSON contains full requests/responses, objections and their resolutions, aggregation ancestry, snapshots of discovery weights and premises, and executed evidence. Each decision records a reason and the current artifact's hash.

## Commands

| Command | Effect |
| --- | --- |
| `/math help` | Show concise help. |
| `/math setup [preset] [--apply]` | List or preview hosted/local presets; explicitly apply a cautious provider merge and session inference settings. |
| `/math doctor [--json]` | Check declared model/auth/scope/context/budgets offline; show the parent separately. |
| `/math doctor --probe [--json]` | Send two bounded synthetic generation/review requests, at most 8,192 reserved output tokens; hosted calls may be billed. |
| `/math start <question>` | Start a proof project; retain the previous project as an archived object. |
| `/math status` | Inspect the current branch's state. |
| `/math step` | Advance one phase or one eligible wave of sections. |
| `/math run` | Advance until a human gate, completion, limit, or failure. |
| `/math approve [reason]` | Approve the current route or plan. |
| `/math accept <reason>` | Record final human acceptance, only after clean global model review. |
| `/math reexplore <reason>` | Archive the current attempt and search again with its feedback. |
| `/math amend <new target>` | Archive and invalidate the old argument; start exploration on a new target. Existing explicit assumptions are retained; use a new project if those should change. |
| `/math retry <reason>` | Reset exhausted local attempt counters on a blocked plan; preserve accepted sections. |
| `/math dataset <JSON path>` | Replace the discovery environment, retaining its previous run. |
| `/math discover` / `/math discover run` | Execute one discovery round or a bounded episode. |
| `/math use-conjecture` | Start a proof project from the last conjecture and the current explicit dataset premises, whether or not it was proved. |
| `/math premise <reason>` | Promote the last machine-checked conjecture to background knowledge. |
| `/math config [JSON path]` | Display settings, or replace them from a validated JSON file. |
| `/math profile compact` / `paper` | Set tree widths to `[4,2,1]` / `[16,8,5,1]`, sample size to 3 / 5. Other limits are retained. |
| `/math export` | Create a fresh export directory containing `research.md`, `research.json`, `proof.tex`. |
| `/math cancel` | Abort work and retain completed checkpoints. |

Paths are relative to the current Pi project, may have a leading `@`, and must resolve inside that project. Input JSON is limited to 2 MB. Use quotation marks around paths containing spaces. The LaTeX export wraps the model's raw mathematical body; it is a draft to inspect and edit, not an automatically compiled or verified document.

## Tools for the parent agent

| Tool | Actions / input |
| --- | --- |
| `math_research` | `start`, `status`, `step`, `run`; optional exact problem and explicit assumptions when starting. Cannot replace an existing project. |
| `math_discover` | `import`, `status`, `step`, `run`; import a project-local dataset. Cannot replace an existing environment. |
| `math_check` | JSON expression AST, checked against the current dataset's premises. Produces exact empirical evaluation plus independently validated prover feedback. |
| `math_note` | An unverified lemma, failure, reference or observation with hypotheses, sources and caveats. |

Tool text is capped at 12,000 characters and points to the full checkpoint. The parent receives at most 9,000 characters of branch context before a turn. Complete records remain on disk. This prevents a long audit from filling every conversational context.

## Configuration and budgets

For models, start with [the supplied preset examples](../examples/providers) and [generation reference](MODELS.md#generation-settings). `/math setup` replaces only inference settings; it preserves discovery/Lean settings, and local presets enforce loopback worker endpoints with no redirect fallback. Select the parent separately in `/model`.

Settings files replace the previous settings; unspecified keys receive defaults. Start with [symbolic-config.json](../examples/symbolic-config.json), or this model-backed configuration:

```json
{
  "discoveryPolicy": "model",
  "discoveryRounds": 10,
  "inference": {
    "widths": [4, 2, 1],
    "sampleSize": 3,
    "reviewers": 1,
    "concurrency": 3,
    "maxCalls": 160,
    "maxOutputTokens": 4096,
    "maxReservedOutputTokens": 655360,
    "maxInputChars": 240000,
    "timeoutMs": 120000,
    "maxSectionAttempts": 3,
    "maxRounds": 5,
    "seed": 1729,
    "models": {}
  },
  "lean": null
}
```

Limits are shared across all workers in **one step/run invocation**. A later invocation starts a fresh inference budget; it does not reset proof rounds or local attempts. Only a completed exploration consumes a round; an exploration that fails validation or errors preserves the round budget. Per-role generation fields merge default → stage → suffix → full role; model overrides resolve as whole entries. The parent thinking setting is not inherited. Effective settings are attached to successful worker audit responses.

Each dispatched call reserves its resolved maximum output tokens even if it fails or returns less. There are no hidden provider retries. A draft rejected by the response schema or by local validation is re-asked with the exact rejection reason, at most `maxSectionAttempts` times per stage slot; these retries are ordinary audited calls, and a draft that still fails ends the stage with the validator's error. Provider-side failures are never retried. Call reservations occur before dispatch under a shared semaphore. A deadline aborts the whole broker, including queued calls, so a provider that ignores cancellation cannot cause new work to launch.

These are call/output limits, not a dollar cap. Input tokens, provider thinking-token conventions and cancellation billing depend on the provider. Reported usage/cost is recorded when supplied; interrupted calls may not report a charge. A run can stop midway through a stage. Completed artifacts remain auditable; an incomplete aggregation is recomputed on retry. Completed proof sections survive unrelated failures.

For widths `w` and `r` reviewers, a stage costs `sum(w) * (1+r)` calls, before special curation calls. The compact default costs 14 and the paper profile 60 with one reviewer. The first paper's exploration setting `[32,16,8,5,1]` costs 124. The profile changes sizes only; set higher call/output budgets explicitly when needed. Widths end in one root; the sample size is clipped to the previous level's width. Each group samples independently without replacement internally, so groups may overlap. The same seed controls sampling, not provider randomness or asynchronous scheduling.

Model overrides use `{ "provider": "...", "id": "..." }` values in `inference.models`. Resolution order is full role (for example `section/critic`), role suffix (`critic`), stage (`section`), `default`, then Pi's selected model. Use IDs shown by your installed Pi registry. All chosen models must lie within the session's scoped models when a scope is configured.

## Discovery and proof feedback

The `model` policy delegates search choices to isolated model calls. The `symbolic` policy uses a deterministic bounded enumerator and simple feedback rules; it can run offline. Neither policy is a trained MADDPG implementation. The default prover checks exact linear consequences of supplied premises over integer-valued features, using rational coefficient certificates. Unsupported nonlinear goals return `unknown`.

To use Lean, first prepare a **trusted local Lake project** with mathlib and a working `lake env lean`. Put a settings file inside your research project, for example:

```json
{
  "discoveryPolicy": "model",
  "lean": {"project": "/absolute/path/to/your/mathlib-project", "timeoutMs": 30000}
}
```

The prover translates the bounded integer AST itself; it never runs model-written Lean or shell commands. It invokes `lake env lean` with an argument array, applies time/output bounds, records the source hash and compiler output, and checks the theorem's axiom report. The trusted project and its compiler remain part of the evidence boundary. The tactic is intentionally small and many true statements return unknown.

## Sessions and recovery

Checkpoints are immutable SHA-256-addressed JSON objects. Pi custom entries store only references to them. Restoration walks `sessionManager.getBranch()`, so navigating to another branch does not reuse a global latest snapshot. Work is cancelled and awaited before switching/forking/navigating; late writes are rejected by a session epoch guard. Starting another question archives the previous state.

Keep `.pi/math/objects` and the associated Pi session together. A missing, modified or invalid checkpoint fails closed with a visible error. Exports embed the referenced audit/evidence objects for offline review; the extension currently has no export-import command. A fresh project/session can start clean work without deleting previous evidence.

If a provider returns invalid JSON or a section exhausts attempts, read the error and inspect the export. Adjust the model, budget or strategy as appropriate. `/math retry` is for exhausted section work; `/math reexplore` changes the mathematical route. Formal proof outcomes never turn a free-form proof draft into a certified theorem automatically.
