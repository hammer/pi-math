# Offline ablation

Small deterministic engineering ablation using a bounded enumerator and exact linear prover on hand-written data. No learned MADDPG policies, PySR, live models, statistical significance, or replication of paper results is claimed. All modes still measure proof outcomes; the feedback ablation withholds them from the policy. A success is relative to supplied premises, not a new theorem.

| Mode | Episodes | Successful episodes | Mean distinct conjectures | Mean visible rows |
| --- | ---: | ---: | ---: | ---: |
| full | 5 | 0 | 3 | 6 |
| no-skeptic | 5 | 0 | 3 | 6 |
| no-proof-feedback | 5 | 0 | 3 | 6 |
| regression-only | 5 | 0 | 3 | 6 |

All trajectories, exposures and seeds are in report.json. Five seeds perturb initial weights on one fixture; they are not five independent mathematical tasks.
