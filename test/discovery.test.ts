import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { AlgebraProver, certify, verifyCertificate } from "../src/certificate.ts";
import { parseExpr, evaluate, op, v, n, type Expr } from "../src/expressions.ts";
import { parseDataset, newDiscovery, DiscoveryEngine, assess, unionWeights, visibleRows, updatePatches, expandScaffold, checkedFeedback, type Policy } from "../src/discovery.ts";
import { naiveEuler, eulerIdentity } from "../examples/formulas.ts";
import { seededRandom, Broker } from "../src/inference.ts";
import { HeuristicPolicy, ModelPolicy, regressionLoss } from "../src/policies.ts";
import { ConfigSchema } from "../src/schema.ts";
import { leanSource, cleanLeanAxioms, executeBounded } from "../src/lean.ts";
import { hash } from "../src/store.ts";
import { conceptFlags } from "../src/concepts.ts";
const data = () => readFile(new URL("../examples/euler-data.json", import.meta.url), "utf8").then(s => parseDataset(JSON.parse(s)));
test("exact evaluation finds Euler counterexamples and certifies the rank-nullity consequence", async () => {
    const d = await data();
    assert.deepEqual(assess(naiveEuler, d).counterexamples, ["torus", "two-spheres"]);
    const c = certify(eulerIdentity, d.premises);
    assert.ok(c);
    assert.ok(verifyCertificate(eulerIdentity, d.premises, c));
    assert.equal(assess(eulerIdentity, d).nondegenerate, true);
    assert.equal(assess(eulerIdentity, d).allDataTrue, true);
    const unproved = await new AlgebraProver().prove(naiveEuler, d.premises);
    assert.equal(unproved.outcome, "unknown");
    assert.equal(unproved.rho, 0);
    assert.equal(verifyCertificate(naiveEuler, d.premises, c), false);
    assert.equal(verifyCertificate(eulerIdentity, [], c), false);
});
test("certificate producer and independent checker agree on 100 seeded linear consequences", () => {
    const random = seededRandom(2026), integer = () => Math.floor(random() * 21) - 10;
    for (let i = 0; i < 100; i++) {
        const a = integer(), b = integer(), k = integer();
        const premises = [op("eq", v("x"), n(a)), op("eq", v("y"), n(b))];
        const statement = op("eq", op("add", op("mul", n(k), v("x")), v("y")), n(k * a + b));
        const certificate = certify(statement, premises);
        assert.ok(certificate);
        assert.ok(verifyCertificate(statement, premises, certificate));
        if (certificate.tree.kind === "linear") {
            certificate.tree.weights[0] = "999/1";
            if (k !== 999)
                assert.equal(verifyCertificate(statement, premises, certificate), false);
        }
        assert.equal(certify(op("eq", op("add", op("mul", n(k), v("x")), v("y")), n(k * a + b + 1)), premises), null);
    }
});
test("integer AST rejects unsafe inputs, unknown variables, ill types and excessive depth", () => {
    assert.throws(() => parseExpr({ kind: "int", value: Number.MAX_SAFE_INTEGER + 1 }, []));
    assert.throws(() => parseExpr(v("unseen"), ["x"]));
    assert.throws(() => parseExpr(op("and", n(1), n(2)), []));
    assert.throws(() => parseExpr({ kind: "eval", code: "process.exit()" }, []));
    let deep: Expr = n(0);
    for (let i = 0; i < 22; i++)
        deep = op("add", deep, n(1));
    assert.throws(() => parseExpr(deep, []));
    const large = op("mul", n(Number.MAX_SAFE_INTEGER), n(Number.MAX_SAFE_INTEGER));
    assert.equal(evaluate(large, {}), BigInt(Number.MAX_SAFE_INTEGER) ** 2n);
});
test("paper-aligned weak concept metrics detect chi and b1 without equating rearranged Euler forms", () => {
    assert.deepEqual(conceptFlags(naiveEuler), { chi: true, b1: false });
    assert.deepEqual(conceptFlags(op("eq", op("sub", v("n1"), v("r2")), n(0))), { chi: false, b1: true });
    assert.deepEqual(conceptFlags(op("implies", op("eq", op("sub", v("n1"), v("r2")), n(0)), naiveEuler)), { chi: true, b1: true });
    assert.deepEqual(conceptFlags(op("eq", op("add", v("V"), v("F")), op("add", v("E"), n(2)))), { chi: false, b1: false });
});
test("nondegeneracy excludes known premises, vacuity, tautologies and inconsistent environment", async () => {
    const d = await data();
    assert.ok(assess(d.premises[0]!, d).reasons.includes("known-premise"));
    const rearrangedPremise = op("eq", op("sub", op("sub", v("E"), v("n1")), v("r1")), n(0));
    assert.ok(assess(rearrangedPremise, d).reasons.includes("known-premise-consequence"));
    assert.equal(assess(rearrangedPremise, d).nondegenerate, false);
    assert.equal(assess(eulerIdentity, d).reasons.includes("known-premise-consequence"), false);
    const irrelevantAntecedent = op("implies", naiveEuler, eulerIdentity);
    assert.ok(assess(irrelevantAntecedent, d).reasons.includes("irrelevant-antecedent"));
    assert.equal(assess(op("implies", naiveEuler, naiveEuler), d).nondegenerate, false);
    assert.ok(assess(op("implies", op("eq", v("V"), n(-1)), naiveEuler), d).reasons.includes("vacuous-antecedent"));
    d.premises.push(op("eq", v("V"), n(-1)));
    assert.ok(assess(eulerIdentity, d).reasons.includes("no-premise-witness"));
});
test("patch union uses maxima and skeptical updates cannot hide all data or exceed bounds", async () => {
    const d = await data();
    assert.deepEqual(unionWeights(d), [1, 1, 1, 0, 0, 0]);
    assert.equal(visibleRows(d, unionWeights(d)).length, 3);
    assert.throws(() => updatePatches(d, [{ patch: "initial-a", row: "torus", weight: 2 }], 1));
    assert.throws(() => updatePatches(d, [{ patch: "initial-a", row: "torus", weight: 1 }], 0));
    assert.throws(() => updatePatches(d, d.rows.map(r => ({ patch: "initial-a", row: r.id, weight: 0 })), 6));
    assert.throws(() => expandScaffold({ kind: "atom", id: "invented" }, []));
});
test("discovery passes unsuccessful proof feedback back to conjecturing and reveals counterexamples", async () => {
    const state = newDiscovery(await data());
    const feedback: (number | null)[] = [];
    let round = 0;
    const baseline = new HeuristicPolicy();
    const policy: Policy = {
        async control(input) { feedback.push(input.feedback?.rho ?? null); round = input.round; return input.previous; },
        async features(input) {
            if (round === 0)
                assert.ok(input.rows.every(r => r.id !== "torus"));
            else
                assert.ok(input.rows.some(r => r.id === "torus"));
            return { atoms: [{ expression: round === 0 ? naiveEuler : eulerIdentity, description: "Scripted test proposal" }], definitions: [] };
        },
        async scaffold(input) { return { expression: { kind: "atom", id: input.atoms[0]!.id }, reason: "Scripted integration fixture" }; },
        skeptic: input => baseline.skeptic(input),
    };
    const engine = new DiscoveryEngine(state, policy, new AlgebraProver());
    await engine.step();
    assert.equal(state.status, "active");
    await engine.step();
    assert.deepEqual(feedback, [null, 0]);
    assert.equal(state.status, "candidate-found");
    assert.equal(state.rounds.length, 2);
    assert.equal(state.rounds[1]!.proof.outcome, "certified");
});
test("proof-feedback ablation hides proof outcomes from policies but retains audit evidence", async () => {
    const s = newDiscovery(await data(), 2);
    s.ablations.proofFeedback = false;
    const baseline = new HeuristicPolicy();
    let seen = 0;
    const p: Policy = { ...baseline, control: async (i) => { assert.equal(i.feedback, null); seen++; return i.previous; }, features: async () => ({ atoms: [{ expression: naiveEuler, description: "fixture" }], definitions: [] }), scaffold: async (i) => ({ expression: { kind: "atom", id: i.atoms[0]!.id }, reason: "fixture" }), skeptic: i => baseline.skeptic(i) };
    const e = new DiscoveryEngine(s, p, new AlgebraProver());
    await e.step();
    await e.step();
    assert.equal(seen, 2);
    assert.equal(s.status, "exhausted");
    assert.equal(s.rounds[0]!.proof.rho, 0);
});
test("stale prover feedback is rejected", async () => {
    const s = newDiscovery(await data());
    const baseline = new HeuristicPolicy();
    const p: Policy = { control: async (i) => i.previous, features: async () => ({ atoms: [{ expression: naiveEuler, description: "fixture" }], definitions: [] }), scaffold: async (i) => ({ expression: { kind: "atom", id: i.atoms[0]!.id }, reason: "fixture" }), skeptic: i => baseline.skeptic(i) };
    const bad = { async prove() { return new AlgebraProver().prove(eulerIdentity, s.dataset.premises); } };
    await assert.rejects(new DiscoveryEngine(s, p, bad).step(), /different statement/);
    assert.equal(s.rounds.length, 0);
});
test("Lean translation fixes the exact goal and rejects untrusted axioms", () => {
    const source = leanSource(op("eq", v("x"), v("x")), []);
    assert.match(source, /theorem piMathClaim/);
    assert.match(source, /∀ \(x0 : Int\), \(x0 = x0\)/);
    assert.doesNotMatch(source, /sorry|admit/);
    assert.equal(cleanLeanAxioms("'piMathClaim' depends on axioms: [propext, Classical.choice, Quot.sound]"), true);
    assert.equal(cleanLeanAxioms("'piMathClaim' depends on axioms: [sorryAx]"), false);
    assert.equal(cleanLeanAxioms("'piMathClaim' depends on axioms: [myCustomAxiom]"), false);
    assert.equal(cleanLeanAxioms("Compilation succeeded"), false);
});
test("external proof process handles success, missing executable, output limits, cancellation and timeout", async () => {
    const ok = await executeBounded(process.execPath, ["-e", "process.stdout.write('ok')"], process.cwd(), 1000);
    assert.equal(ok.stdout, "ok");
    assert.equal(ok.exitCode, 0);
    const missing = await executeBounded("pi-math-nonexistent-executable", [], process.cwd(), 1000);
    assert.ok(missing.problem);
    const huge = await executeBounded(process.execPath, ["-e", "process.stdout.write('a'.repeat(100000))"], process.cwd(), 1000, undefined, 100);
    assert.match(huge.problem!, /output limit/);
    assert.equal(huge.stdout.length, 100);
    const timeout = await executeBounded(process.execPath, ["-e", "setInterval(()=>{},1000)"], process.cwd(), 30);
    assert.match(timeout.problem!, /timed out/);
    const ac = new AbortController();
    const pending = executeBounded(process.execPath, ["-e", "setInterval(()=>{},1000)"], process.cwd(), 1000, ac.signal);
    setTimeout(() => ac.abort(), 10);
    assert.match((await pending).problem!, /cancelled/);
});
test("the symbolic-regression objective responds to data fit and operator priors", () => {
    assert.ok(regressionLoss(naiveEuler, 1, {}) < regressionLoss(naiveEuler, 0.5, {}));
    assert.ok(regressionLoss(naiveEuler, 1, { sub: 1 }) < regressionLoss(naiveEuler, 1, {}));
});
test("heuristic policy broadens and scaffolds after a certified but degenerate premise restatement", async () => {
    const policy = new HeuristicPolicy();
    const feedback = { rho: 1 as const, outcome: "certified" as const, explanation: "Known premise", nondegenerate: false, reasons: ["known-premise-consequence"] };
    const controls = await policy.control({ previous: { featureCount: 3, priors: {}, reason: "Initial" }, feedback, round: 1, history: [] });
    assert.equal(controls.featureCount, 4);
    const atoms = [
        { id: "b1", expression: op("eq", op("sub", v("n1"), v("r2")), n(0)), description: "b1 vanishes", patch: "p", accuracy: 1 },
        { id: "chi", expression: naiveEuler, description: "Euler characteristic two", patch: "p", accuracy: 1 },
    ];
    const result = await policy.scaffold({ features: ["V", "E", "F", "n1", "r2"], atoms, rows: [{ id: "sphere", values: { V: 4, E: 6, F: 4, n1: 3, r2: 3 }, weight: 1 }], controls, feedback, history: [] });
    assert.equal(result.expression.kind, "implies");
});
test("restored Lean evidence must bind source, successful exit and allowed axioms", () => {
    const expr = op("eq", v("x"), v("x"));
    const proof = { outcome: "lean-checked" as const, rho: 1 as const, statementHash: hash(expr), premisesHash: hash([]), explanation: "Synthetic evidence-validation fixture, not a Lean run",
        execution: { sourceHash: hash(leanSource(expr, [])), stdout: "'piMathClaim' does not depend on any axioms", stderr: "", exitCode: 0, durationMs: 1 } };
    checkedFeedback(expr, [], proof);
    assert.throws(() => checkedFeedback(expr, [], { ...proof, execution: { ...proof.execution, sourceHash: hash("theorem wrong : True := trivial") } }), /Lean execution/);
    assert.throws(() => checkedFeedback(expr, [], { ...proof, execution: { ...proof.execution, exitCode: 1 } }), /Lean execution/);
    assert.throws(() => checkedFeedback(expr, [], { ...proof, execution: { ...proof.execution, stdout: "'piMathClaim' depends on axioms: [sorryAx]" } }), /Lean execution/);
});
test("feature spotters cannot bypass the separate logical scaffolder", async () => {
    const s = newDiscovery(await data()), base = new HeuristicPolicy();
    const policy: Policy = { control: i => base.control(i), features: async () => ({ atoms: [{ expression: op("implies", naiveEuler, naiveEuler), description: "Hidden logical composition" }], definitions: [] }), scaffold: i => base.scaffold(i), skeptic: i => base.skeptic(i) };
    await assert.rejects(new DiscoveryEngine(s, policy, new AlgebraProver()).step(), /arithmetic equality/);
    assert.equal(s.rounds.length, 0);
});
test("model-policy schemas execute the full discovery protocol without exposing held-out rows", async () => {
    const state = newDiscovery(await data(), 1), baseline = new HeuristicPolicy(), roles: string[] = [];
    const broker = new Broker({ async complete(r) {
            roles.push(r.role);
            const input = JSON.parse(r.prompt);
            let value: unknown;
            if (r.role === "discovery/controller")
                value = input.previous;
            else if (r.role === "discovery/feature") {
                assert.equal(input.rows.length, 3);
                assert.ok(input.rows.every((row: {
                    id: string;
                }) => row.id !== "torus"));
                value = { atoms: [{ expression: naiveEuler, description: "Fixture candidate" }], definitions: [] };
            }
            else if (r.role === "discovery/scaffold") {
                assert.equal(input.rows.length, 3);
                assert.ok(input.rows.every((row: {
                    weight: number;
                }) => row.weight === 1));
                value = { expression: { kind: "atom", id: input.atoms[0].id }, reason: "Fixture scaffold" };
            }
            else if (r.role === "discovery/skeptic") {
                assert.equal(input.dataset.rows.length, 6);
                value = await baseline.skeptic(input);
            }
            else
                throw new Error("Unexpected model policy role");
            return { text: JSON.stringify(value) };
        } }, ConfigSchema.parse({}));
    await new DiscoveryEngine(state, new ModelPolicy(broker), new AlgebraProver()).step();
    assert.equal(broker.usage.calls, 5);
    assert.equal(state.rounds.length, 1);
    assert.equal(state.rounds[0]!.proof.rho, 0);
    assert.deepEqual(roles.sort(), ["discovery/controller", "discovery/feature", "discovery/feature", "discovery/scaffold", "discovery/skeptic"].sort());
});
