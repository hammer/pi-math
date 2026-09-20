# Onboarding validation record

Date: **2026-09-19**. Scope: software and documentation implementing [issue #9](https://github.com/hammer/pi-math/issues/9), following its posted research plan and adversarial review.

## Executed locally

Environment: Linux x64, Node **24.19.0**, Pi coding-agent/pi-ai **0.85.1** from the lockfile. The normal suite requires no API key, GPU, model weights, or Lean installation.

| Check | Result |
| --- | --- |
| `npm run check` | TypeScript clean; **62 tests passed**, zero failed/skipped |
| Every preset loaded by Pi | All **11** provider/settings pairs accepted by the actual registry |
| Every preset's request | Actual Pi HTTP client sent to a loopback mock server; expected reasoning mapping, alias, and output cap checked |
| Transport adversarial cases | Streamed reasoning separated from final JSON; native numeric effort; explicit/default/off controls; mandatory thinking; fixed Kimi sampling; schema request; both cap fields; 401/404/429; malformed/truncated/empty replies; tools; disconnect; cancellation; timeout |
| Reservation and isolation attacks | Inherited payload fields and post-hook serialized model/cap/tool/completion-count changes refused; local remote destinations/redirects rejected |
| Setup/doctor | Preview, idempotent merge, private backup, conflicts, malformed files, symlinks, cancellation, custom agent directory, legacy settings/checkpoints, role overrides, scope, parent distinction, two-call probe |
| Evaluation | Credential-free default dry run, bounded scripted execution, exact divisor checking, retained errors, rubric isolation, no automatic human/proof-quality verdict |
| `npm run demo` | Exact fixture exposes torus/two-spheres counterexamples and produces a linear certificate conditional on supplied premises |
| `npm run verify:certificate -- test-output/demo/certificate.json` | Independent checker accepts the generated certificate against the exact statement/premises |
| `npm run ablate` | Corrected five-seed engineering fixture: 0/5 in every mode after excluding algebraic restatements of supplied premises; not a paper replication |
| `npm run evaluate -- --preset local-ds4 --max-output 1024` | Dry run reports six requests / 6,144 reserved output tokens; no inference sent |
| `npm pack --dry-run --json` | Package assembles with source, examples, and guides |
| `git diff --check` | No whitespace errors |

GitHub Actions runs the same credential-free checks on Node **22.19.0** and **24**. Consult the [workflow runs](https://github.com/hammer/pi-math/actions/workflows/ci.yml) for the exact published commit's CI result; this record's local results do not assert a CI result before it runs.

## Findings corrected during implementation

1. Workers previously omitted their own reasoning controls. The new adapter resolves and records role settings; tests inspect actual HTTP requests rather than only mocked method arguments.
2. Generic payload overrides could evade budget and isolation assumptions. Requests are checked again after provider hooks, immediately before fetch.
3. Input character bounds alone could exceed a local context. A labeled conservative UTF-8 byte estimate plus output reserve is checked against declared model/server bounds. It can overestimate; the server's actual configuration still matters.
4. Local parent selection could conceal hosted worker overrides, or vice versa. Doctor checks workers separately and reports the parent; local worker transport rejects other origins and redirects.
5. Setup could overwrite unrelated provider entries or repeat backups. It now previews, refuses conflicting values, preserves unknown unrelated fields, locks writes, backs up once per actual change, and reloads without a network catalog refresh. It is not a transaction with unrelated editors; avoid concurrent manual writes.
6. A schema-valid false acceptance could become a misleading evaluation “pass”. The runner records `returned` separately from mathematical correctness, leaves human judgments null, and checks only the explicit integer witness automatically.
7. Unsupported non-OpenAI controls were detected only at dispatch, and automatic reasoning was reported more strongly than applied. Doctor now rejects explicit unsupported controls in preflight and reports provider defaults accurately for those APIs. Undeclared generic off mappings also fail visibly.
8. Download size and an API model ID could be mistaken for RAM fit or exact weights. Documentation now separates deployed packing, working memory, engine compatibility, aliases, and recorded provenance.

## Not executed; no claim of validation

- No paid hosted inference, real local weight inference, GPU memory measurement, throughput benchmark, or proof-quality comparison was run in this environment. No provider credential or suitable loaded model/hardware was available for these exercises.
- Bonsai, Unsloth, Ollama, LM Studio, ds4, and vLLM recipes are **source-reviewed and mock-transport-tested; live-validation-pending**. No recipe is labeled tested on hardware merely because its JSON loads.
- Source pins document reviewed code, not an executed engine build: llama.cpp `5b59b83f4e2101ea173d4f853a0522d9971f48c6`; PrismML fork `9a9394a895b96003ca842a6041cb28ac49a108f7`; ds4 `8db1d1d155cb0400a86a86b9c62d0defb3a6148b`.
- The six-task runner is a worker sanity suite. Full live proof gates, parent tool invocation, interactive navigation, and independent mathematical adjudication remain acceptance exercises described in [EVALUATION.md](EVALUATION.md) and [VERIFY.md](VERIFY.md).
- Native constrained-output success depends on the actual endpoint/schema/parser combination. The default remains prompt JSON with strict local validation; unsupported native constraints fail without fallback.
- Local-only policy controls worker destination URLs, not a local server's internals, OS networking, or other Pi extensions. API keys remain in Pi's existing credential system. Hosted workers receive their prompts; audit exports contain mathematical prompts and answers.
- Output reservations do not provide a dollar cap, deterministic generation, or a mathematical correctness guarantee. A completed natural-language proof remains separate from an executed formal certificate.

Keep issue #9 open for real hosted/local smoke evidence and broader human-reviewed model recommendations. Do not change a preset's validation status without recording the exact model/runtime/hardware and results.
