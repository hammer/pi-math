# Concept-discovery replication attempt

Paired deterministic evaluation of pi-math's bounded heuristic policy on generated D0-style integer summaries. It does not train MADDPG, use PySR, execute the paper's incidence matrices, or reproduce its reported percentages/confidence intervals. 30 generated datasets are sensitivity trials, not independent learned policies.

| Mode | Episodes | Noticed χ | Noticed b1 | Certified relation using both | Any certified nondegenerate statement |
| --- | ---: | ---: | ---: | ---: | ---: |
| M0-full | 30 | 0 | 0 | 0 | 0 |
| M1-no-provability-feedback | 30 | 0 | 0 | 0 | 0 |
| M2-no-skeptic | 30 | 0 | 0 | 0 | 0 |
| regression-only | 30 | 0 | 0 | 0 | 0 |

The JSON report contains every statement, proof outcome, and nondegeneracy reason. A zero is a failed replication under this adaptation, not evidence against the paper.
