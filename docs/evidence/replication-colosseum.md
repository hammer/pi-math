# Colosseum mechanism replication attempt

Deterministic fault-injection test of pi-math's orchestration, not a language-model or TCS-Bench replication. The fixture deliberately makes exact critics reliable and rotates one correct leaf among four; the result measures whether critique-preserving overlapping aggregation can recover that leaf under this known process.

| Condition | Exact successes | Episodes | Calls per episode |
| --- | ---: | ---: | ---: |
| Single candidate | 25 | 100 | 1 |
| Adversarial overlapping tree | 50 | 100 | 14 |

The comparison intentionally does not control total inference compute and cannot estimate model-level accuracy. The JSON report records every seed and retained-objection count.
