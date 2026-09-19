import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { newResearch, ProofEngine, approve, amend, reexplore } from "../src/proof.ts";
import { Broker, type Worker } from "../src/inference.ts";
import { StageRunner } from "../src/tree.ts";
import { ObjectStore, CHECKPOINT_TYPE } from "../src/store.ts";
import { type ProofPlan } from "../src/schema.ts";
const plan: ProofPlan = { title: "Even sum", abstract: "Use two independent parity lemmas", conclusionId: "c", sections: [
        { id: "a", title: "First", task: "First lemma", dependsOn: [], obligations: [] },
        { id: "b", title: "Second", task: "Second lemma", dependsOn: [], obligations: [] },
        { id: "c", title: "Conclusion", task: "Conclude", dependsOn: ["a", "b"], obligations: [] },
    ] };
function fake(options: {
    badGate?: boolean;
    failFirst?: boolean;
    repair?: boolean;
} = {}): Worker {
    let failed = false, verified = 0;
    return { async complete(r) {
            const input = JSON.parse(r.prompt), t = input.task;
            if (r.role === "curator")
                return { text: '{"entries":[]}' };
            if (r.role.endsWith("/critic"))
                return { text: JSON.stringify({ verdict: "accept", summary: "Fixture review", issues: [], resolved: (input.inheritedObjections ?? []).map((o: {
                            id: string;
                        }) => ({ id: o.id, reason: "Scripted reviewer checks the repaired fixture" })) }) };
            const role = r.role.split("/")[0];
            let value: unknown;
            if (role === "explore")
                value = { target: t.problem, mechanism: "Algebra", hypotheses: t.assumptions, lemmas: ["First", "Second"], bottleneck: "Combine", gateway: { test: "Check parity", ifPass: "Prove", ifFail: "Refute" }, alternatives: [], obligations: [], evidence: [] };
            else if (role === "gate")
                value = { decision: "ready", stableArchitecture: !options.badGate, reason: "Fixture architecture", obligations: [] };
            else if (role === "decompose")
                value = plan;
            else if (role === "section") {
                if (options.failFirst && !failed && t.assigned.id === "a") {
                    failed = true;
                    value = { body: "Incomplete", claimedResult: "First lemma", status: "partial", assumptions: [], usedDependencies: [], gaps: ["Need a proof"] };
                }
                else
                    value = { body: `Proof body for ${t.assigned.id}`, claimedResult: t.assigned.task, status: "complete", assumptions: t.assumptions, usedDependencies: t.assigned.dependsOn, gaps: [] };
            }
            else if (role === "verify") {
                verified++;
                value = { verdict: options.repair && verified === 1 ? "revise" : "accept", summary: "Fixture global review", defects: options.repair && verified === 1 ? [{ claim: "Wrong first lemma", reason: "A boundary case is absent", severity: "major", scope: "section", sections: ["a"] }] : [] };
            }
            else if (role === "revise")
                value = { action: "sections", reason: "Repair first lemma", affected: ["a"], plan: null };
            else
                throw new Error(`Unexpected role ${r.role}`);
            return { text: JSON.stringify(value) };
        } };
}
function setup(options: Parameters<typeof fake>[0] = {}) {
    const state = newResearch("The sum of two even integers is even", [], { widths: [1], concurrency: 2 });
    const engine = new ProofEngine(state, new StageRunner(new Broker(fake(options), state.config)));
    return { state, engine };
}
test("full proof workflow pauses for human decisions and distinguishes acceptance", async () => {
    const { state, engine } = setup();
    await engine.run();
    assert.equal(state.phase, "awaiting-route");
    await engine.step();
    assert.equal(state.phase, "awaiting-route");
    approve(state, "The reduction is appropriate");
    await engine.run();
    assert.equal(state.phase, "awaiting-plan");
    approve(state, "The dependencies are correct");
    await engine.run();
    assert.equal(state.phase, "awaiting-acceptance");
    assert.equal(state.decisions.length, 2);
    approve(state, "I checked the argument");
    assert.equal(state.phase, "accepted");
    assert.equal(state.decisions.at(-1)!.kind, "accept");
    assert.throws(() => approve(state, "Again"));
});
test("an unstable readiness judgment cannot pass even when it says ready", async () => {
    const { state, engine } = setup({ badGate: true });
    await engine.step();
    await engine.step();
    assert.equal(state.phase, "explore");
    assert.equal(state.archives.length, 1);
});
test("a failed local proof retries only its own section and retains criticism", async () => {
    const { state, engine } = setup({ failFirst: true });
    await engine.run();
    approve(state, "Route");
    await engine.run();
    approve(state, "Plan");
    await engine.step();
    assert.equal(state.sections.a!.status, "failed");
    assert.equal(state.sections.b!.status, "accepted");
    await engine.step();
    assert.equal(state.sections.a!.attempts, 2);
    assert.equal(state.sections.b!.attempts, 1);
    assert.equal(state.sections.a!.previous.length, 1);
    await engine.run();
    assert.equal(state.phase, "awaiting-acceptance");
});
test("global revision invalidates the broken section and consumers, preserving independent work", async () => {
    const { state, engine } = setup({ repair: true });
    await engine.run();
    approve(state, "Route");
    await engine.run();
    approve(state, "Plan");
    while (state.phase !== "revise")
        await engine.step();
    assert.ok(state.archives.at(-1)!.draft.includes("Proof body"));
    await engine.step();
    assert.equal(state.sections.a!.status, "pending");
    assert.equal(state.sections.c!.status, "pending");
    assert.equal(state.sections.b!.status, "accepted");
    await engine.run();
    assert.equal(state.phase, "awaiting-acceptance");
});
test("branch restoration uses branch-local immutable checkpoints and target amendment invalidates the proof", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-math-branch-"));
    try {
        const store = new ObjectStore(dir);
        const { state, engine } = setup();
        await engine.run();
        const before = await store.checkpoint(state);
        approve(state, "Route");
        await engine.run();
        const after = await store.checkpoint(state);
        const entry = (data: unknown) => ({ type: "custom", customType: CHECKPOINT_TYPE, data });
        assert.equal((await store.restore([entry(before)]))!.phase, "awaiting-route");
        assert.equal((await store.restore([entry(before), entry(after)]))!.phase, "awaiting-plan");
        assert.equal(await store.restore([]), null);
        amend(state, "A different theorem", "Change question");
        assert.equal(state.phase, "explore");
        assert.equal(state.plan, null);
        assert.deepEqual(state.sections, {});
    }
    finally {
        await rm(dir, { recursive: true, force: true });
    }
});
test("re-exploration cannot discard an unresolved whole-proof objection", async () => {
    const state = newResearch("Fixed target", [], { widths: [1] }), base = fake();
    const worker: Worker = { async complete(r) {
            if (r.role === "explore/critic")
                return { text: JSON.stringify({ verdict: "accept", summary: "Ignores inherited criticism", issues: [], resolved: [] }) };
            return base.complete(r);
        } };
    const engine = new ProofEngine(state, new StageRunner(new Broker(worker, state.config)));
    await engine.step();
    const defect = { claim: "The target has a counterexample", reason: "A boundary case contradicts it", severity: "fatal" as const, scope: "target" as const, sections: [] };
    state.verification = { id: "global-review", value: { verdict: "reexplore", summary: "Counterexample", defects: [defect] }, objections: [{ ...defect, id: "fatal-global", source: "global-review" }], reviews: [], parents: [] };
    reexplore(state, "Try to address the counterexample");
    assert.equal(state.verification, null);
    await engine.step();
    assert.ok(state.strategy!.objections.some(o => o.id === "fatal-global"));
    await engine.step();
    assert.equal(state.phase, "explore");
});
test("an invalid exploration retries locally, and a persistent failure does not consume a round", async () => {
    let broken = true;
    const state = newResearch("The sum of two even integers is even", [], { widths: [1], concurrency: 2, maxSectionAttempts: 2 });
    const worker: Worker = { async complete(r) {
            const input = JSON.parse(r.prompt), t = input.task;
            if (r.role === "curator")
                return { text: '{"entries":[]}' };
            if (r.role.endsWith("/critic"))
                return { text: JSON.stringify({ verdict: "accept", summary: "Fixture review", issues: [], resolved: [] }) };
            if (r.role === "explore/generate") {
                const target = broken ? "A paraphrased restatement of the target" : t.problem;
                return { text: JSON.stringify({ target, mechanism: "Algebra", hypotheses: t.assumptions, lemmas: ["First", "Second"], bottleneck: "Combine", gateway: { test: "Check parity", ifPass: "Prove", ifFail: "Refute" }, alternatives: [], obligations: [], evidence: [] }) };
            }
            throw new Error(`Unexpected role ${r.role}`);
        } };
    const engine = new ProofEngine(state, new StageRunner(new Broker(worker, state.config)));
    await assert.rejects(engine.step(), /Strategy changed the target: expected exactly "The sum of two even integers is even", got "A paraphrased restatement of the target"/);
    assert.equal(state.round, 0); // the failed exploration consumed no round budget
    assert.equal(state.phase, "explore");
    broken = false;
    await engine.step();
    assert.equal(state.round, 1);
    assert.equal(state.phase, "gate");
});
