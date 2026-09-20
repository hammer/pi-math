# Paper replication attempts

This repository implements adaptations of two papers, so a software check and a paper replication are different claims. The commands below make that boundary executable and retain every episode in JSON.

## Stellar Colosseum

Run:

```sh
npm run replicate:colosseum
```

The experiment rotates one exactly correct candidate among four and injects exact, deterministic critics. A single-candidate condition is compared with the real `StageRunner` using widths `[4,2,1]`, sample size two and one reviewer. In the first 100 seeded episodes, the single candidate succeeded 25 times and the adversarial tree 50 times, using one versus fourteen calls per episode.

This verifies a mechanism: overlapping, critique-preserving aggregation can recover a correct minority candidate more often under the declared fault process. It does **not** reproduce TCS-Bench, language-model errors, independent research results, or the paper's 71.0% result. The conditions do not match inference compute. Use `--episodes` and `--out` to change the bounded run.

A model-level replication still requires an authenticated live model, a benchmark with withheld judgments, repeated samples, and human or formal grading. The current environment reported no Pi models or credentials, so no model-quality result is claimed.

## Mathematical concept discovery

Run:

```sh
npm run replicate:discovery
```

The experiment generates 30 paired D0-style datasets of connected orientable spheres and tori. The integer dimension/rank/nullity summaries obey the corresponding closed-surface identities. It compares the full heuristic loop with no-provability-feedback, no-skeptic and regression-only interventions. The weak concept metric follows the paper: a statement notices `χ` when an arithmetic subexpression is proportional to `V-E+F`, and notices `b1` when one is proportional to `n1-r2`. Completing the adapted learning problem additionally requires both concepts in one exactly certified, nondegenerate statement.

The initial run found neither concept in any condition. That is a failed replication under this bounded heuristic adaptation, not evidence against the paper. The repository does not train MADDPG, use PySR, execute the paper's sampled incidence matrices, or load its trained checkpoints. Generated datasets are sensitivity trials, not independent trained policies. Use `--episodes`, `--rounds` and `--out` to change the run.

The failed attempt exposed two false-positive paths in the earlier smoke ablation:

1. An algebraic rearrangement of one supplied rank-nullity premise was treated as a novel terminal result.
2. A conditional could terminate even when its consequent followed from the premises without using its antecedent.

The nondegeneracy checks now reject both. The heuristic also receives its prior conjecture history and broadens after a certified but degenerate result, preventing it from silently presenting the same known statement as progress.

## Original smoke ablation

`npm run ablate` remains a small regression test on six hand-written rows. After the nondegeneracy corrections, no mode terminates successfully: the previous full-loop 5/5 was the rank-nullity restatement described above. This correction is intentionally visible rather than preserving a misleading green metric.

The full JSON reports are written under `test-output/`. Generated output is ignored by Git; committed evidence under `docs/evidence/` is updated only after verification.
