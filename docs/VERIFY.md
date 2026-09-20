# Reproducing and reviewing the evidence

## Fresh checkout

Use Node 22.19+; CI runs Node 22.19 and 24. From the repository root:

```sh
npm ci --ignore-scripts
npm run check
npm run demo
npm run verify:certificate -- test-output/demo/certificate.json
npm run ablate
npm run replicate:colosseum
npm run replicate:discovery
npm pack --dry-run
```

The lockfile fixes the development/runtime dependency graph. `--ignore-scripts` avoids unnecessary install hooks. No model credentials or Lean installation are required for these checks. The test runner is Node's built-in test runner with `tsx` as a TypeScript import hook. CI uploads example output for inspection.

The initial release includes [demo evidence](evidence/demo.json), its [independently verifiable certificate](evidence/certificate.json), and the [complete ablation trajectories](evidence/ablations.json). A repeated local ablation matched byte-for-byte. Run `npm run verify:certificate -- docs/evidence/certificate.json` to check the committed certificate directly.

## What the tests actually exercise

| Area | Tests and failure cases |
| --- | --- |
| State and graphs | Cycles, missing dependencies, duplicate IDs, disconnected proof conclusions, transitive invalidation, preserved independent work, strict JSON, corruption, symlinks and path traversal |
| Inference | Parallel reservation races, output limits, malformed output, a provider that ignores cancellation, queued cancellation, independent seeded subset sampling, fatal minority objections, explicit reviewer dispositions |
| Proof workflow | Route/plan/final human gates, unstable readiness, local retry, global repair, branch checkpoint replay and target amendment |
| Discovery | Exact empirical counterexamples; 100 seeded linear certificate cases and tampering; AST types/bounds; vacuity, known premises and tautologies; skeptical updates; failed proof feedback and ablations; stale certificates |
| External execution | Actual subprocess success/failure, missing executable, output cap, cancellation and timeout; deterministic Lean source and axiom-report validation |
| Model onboarding | Every preset loaded by Pi and sent through its real HTTP client to a mock server; reasoning/numeric controls, serialized cap/tool/model guards, streaming and error responses, disconnects/timeouts, setup merges/backups, custom agent directory, diagnostic probes, old settings, and generated examples |
| Evaluation | Dry-run CLI, strict bounds, exact counterexample witnesses, retained failures, rubric isolation, and blank human judgments |
| Pi integration | Real published extension loader and registration; command/tool schemas; branch restoration; initialization race; registry adapter contract; portable exports; actual symbolic-policy round |

Read the tests alongside `docs/ADVERSARIAL-PLAN-REVIEW.md`. Scripted workers deliberately return controlled failures to check harness transitions. They are not substitutes for testing live mathematical reasoning. Optional `npm run test:coverage` produces line/branch coverage; coverage percentages alone do not establish correctness.

## Independent mathematical review

1. Inspect `examples/euler-data.json` and determine whether its feature meanings and supplied premises are appropriate.
2. Run the demo; inspect the exact counterexample IDs. Both the candidates and the two rank-nullity premises are explicitly supplied.
3. Inspect `test-output/demo/certificate.json`. The certificate's two coefficients combine the premise polynomials into the goal polynomial. Check that identity by hand, then run the separate verifier.
4. Change a coefficient or premise in a copy and rerun verification; it must reject. Hash binding means even a semantically equivalent reordering requires a new certificate.
5. Inspect the generated Lean goal. The source file alone is not compiler evidence. To check it using an existing mathlib project, run `lake env lean /absolute/path/to/Claim.lean` from that project and retain the output, Lean/mathlib versions and axiom report.

The exact algebra checker is a small trusted computing base. It is separate from its certificate producer but shares the AST linearization and rational arithmetic functions. A correlated bug in those helpers remains possible; property tests and hand inspection reduce, rather than eliminate, that risk. Lean provides a separate checking route for translated goals when executed.

## Reproducible ablation

`npm run ablate` runs four interventions on the same six-row fixture, five fixed seeds and a three-round cap. The seeds perturb initial weights. Full JSON trajectories record actual conjectures, controls, weights, proof outcomes, and counterexamples; Markdown summarizes them.

| Mode | Intervention |
| --- | --- |
| Full | Controller, proof feedback, and dynamic skeptical weights enabled |
| No skeptic | Every weight fixed at one; proof feedback retained |
| No proof feedback | Prover still runs for measurement; outcomes withheld from future policy inputs |
| Regression only | All data visible, controls fixed, no proof feedback |

With the corrected nondegeneracy checks, the supplied fixture produces zero successful episodes in every mode. The earlier full-loop 5/5 was an algebraic rearrangement of one supplied rank-nullity premise, not a discovery. The fixture and heuristic are deliberately small. This is an engineering regression experiment, with no statistical significance or comparison to the papers' trained systems claimed. See `test-output/ablations/report.json` and [REPLICATION.md](REPLICATION.md) to assess what changed and why.

## Model onboarding verification

Run `npm run evaluate -- --preset local-ollama` for a credential-free preview; it makes no model calls. [EVALUATION.md](EVALUATION.md) gives the explicit live invocation, provenance requirements, matched-cap comparisons, and human adjudication procedure. [ONBOARDING-VALIDATION.md](ONBOARDING-VALIDATION.md) distinguishes executed software checks from pending provider/hardware exercises. The six-case runner checks workers; a full proof session and parent tool invocation remain separate live acceptance exercises.

## Optional live acceptance exercises

These are not part of the credential-free test suite and must be reported separately when performed.

- **Live Pi model:** install the extension, select an authenticated model, choose a familiar theorem, set a small inference budget, and follow the route/plan gates. Verify provider usage records, cancellation, source citations, and the actual mathematical draft. A budget stop or invalid JSON should remain a visible interruption.
- **Actual Lean/mathlib:** configure an existing trusted project as described in `USAGE.md`, load the fixture, and call `math_check` on the supplied identity. Inspect source hash, zero exit code and `#print axioms` output. Test an unsupported/false goal; it must remain unknown, not become accepted.
- **Interactive branch navigation:** make a checkpoint, fork the Pi session, alter the target in one branch and return to the other. Export both and compare problem, assumptions and artifact references. Cancel during a worker call and navigate; completed objects may remain, but no late checkpoint should advance the other branch.

## Release review

The implementation plan and issue specifications preceded coding. The release review records defects found, fixes, commands executed, and remaining limits in `ADVERSARIAL-CODE-REVIEW.md`. GitHub issue closure links each chunk to implementation and verification evidence. A completed issue means the stated software acceptance criteria passed; it does not certify every future generated mathematical argument.
