import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { Broker, BudgetError, sample, seededRandom, type Worker } from "../src/inference.ts";
import { ConfigSchema } from "../src/schema.ts";
import { StageRunner } from "../src/tree.ts";
const output = z.object({ value: z.number() }).strict();
test("concurrent requests share strict call reservations and a concurrency limit", async () => {
    let active = 0, peak = 0;
    const worker: Worker = { async complete() { active++; peak = Math.max(peak, active); await new Promise(r => setTimeout(r, 5)); active--; return { text: '{"value":1}' }; } };
    const broker = new Broker(worker, ConfigSchema.parse({ maxCalls: 7, concurrency: 2 }));
    const results = await Promise.allSettled(Array.from({ length: 20 }, () => broker.ask("test", "test", {}, output)));
    assert.equal(results.filter(x => x.status === "fulfilled").length, 7);
    assert.equal(broker.usage.calls, 7);
    assert.equal(peak, 2);
    assert.ok(results.filter(x => x.status === "rejected").every(x => x.reason instanceof BudgetError));
});
test("token reservation blocks before dispatch, including after malformed output", async () => {
    let calls = 0;
    const broker = new Broker({ async complete() { calls++; return { text: "not JSON" }; } }, ConfigSchema.parse({ maxOutputTokens: 128, maxReservedOutputTokens: 128 }));
    await assert.rejects(broker.ask("test", "test", {}, output));
    await assert.rejects(broker.ask("test", "test", {}, output), BudgetError);
    assert.equal(calls, 1);
    assert.equal(broker.usage.calls, 1);
});
test("timeout aborts the invocation even when a worker ignores its signal", async () => {
    const broker = new Broker({ async complete() { return new Promise(() => { }); } }, ConfigSchema.parse({ timeoutMs: 15 }));
    await assert.rejects(broker.ask("test", "test", {}, output), /timed out/);
    await assert.rejects(broker.ask("test", "test", {}, output), /cancelled/);
});
test("cancellation rejects queued and active work without starting new calls", async () => {
    const controller = new AbortController();
    let calls = 0;
    const broker = new Broker({ async complete() { calls++; return new Promise(() => { }); } }, ConfigSchema.parse({ concurrency: 1 }), async () => { }, controller.signal);
    const tasks = Array.from({ length: 5 }, () => broker.ask("test", "test", {}, output));
    setTimeout(() => controller.abort(), 10);
    const result = await Promise.allSettled(tasks);
    assert.ok(result.every(r => r.status === "rejected"));
    assert.equal(calls, 1);
});
test("independent uniform subsets are reproducible, internally distinct and can overlap", () => {
    const a = seededRandom(0), b = seededRandom(0);
    const population = Array.from({ length: 20 }, (_, i) => i);
    const counts = new Map<number, number>();
    let overlap = false, prior: number[] = [];
    for (let i = 0; i < 2000; i++) {
        const group = sample(population, 5, a);
        assert.deepEqual(group, sample(population, 5, b));
        assert.equal(new Set(group).size, 5);
        if (group.some(x => prior.includes(x)))
            overlap = true;
        prior = group;
        for (const x of group)
            counts.set(x, (counts.get(x) ?? 0) + 1);
    }
    assert.ok(overlap);
    assert.ok([...counts.values()].every(n => n > 400 && n < 600));
});
test("synthesis cannot silently erase a minority fatal objection", async () => {
    const worker: Worker = { async complete(r) {
            const input = JSON.parse(r.prompt);
            if (r.role.endsWith("/generate"))
                return { text: JSON.stringify({ value: input.candidate }) };
            if (r.role.endsWith("/synthesize"))
                return { text: JSON.stringify({ value: { value: 99 }, resolutions: [] }) };
            return { text: JSON.stringify({ verdict: "accept", summary: "Review", resolved: [], issues: input.artifact.value === 0 ? [{ claim: "Target false", reason: "x=0 violates the stated conclusion", severity: "fatal", scope: "target", sections: [] }] : [] }) };
        } };
    const config = ConfigSchema.parse({ widths: [4, 2, 1], sampleSize: 2 });
    const runner = new StageRunner(new Broker(worker, config));
    const root = await runner.run("example", "Generate", {}, output);
    assert.ok(root.objections.some(o => o.severity === "fatal"));
    assert.equal(runner.artifacts.length, 7);
    assert.equal(runner.broker.usage.calls, 14);
});
test("discharging an objection requires a separate explicit reviewer disposition", async () => {
    const worker: Worker = { async complete(r) {
            const i = JSON.parse(r.prompt);
            if (r.role.endsWith("/generate"))
                return { text: '{"value":0}' };
            if (r.role.endsWith("/synthesize"))
                return { text: JSON.stringify({ value: { value: 1 }, resolutions: i.inheritedObjections.map((o: {
                            id: string;
                        }) => ({ id: o.id, reason: "Replaced the erroneous claim" })) }) };
            return { text: JSON.stringify({ verdict: "accept", summary: "Checked", resolved: i.artifact.value === 1 ? i.inheritedObjections.map((o: {
                        id: string;
                    }) => ({ id: o.id, reason: "The replacement no longer asserts the false statement" })) : [], issues: i.artifact.value === 0 ? [{ claim: "Bad claim", reason: "Concrete defect", severity: "major", scope: "artifact", sections: [] }] : [] }) };
        } };
    const runner = new StageRunner(new Broker(worker, ConfigSchema.parse({ widths: [1, 1] })));
    const root = await runner.run("test", "Test", {}, output);
    assert.equal(root.objections.length, 0);
    assert.equal(root.reviews[0]!.review.resolved.length, 1);
});
test("a failed parallel tree drains sibling work before returning or allowing late artifacts", async () => {
    let release!: () => void, started!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; }), ready = new Promise<void>(resolve => { started = resolve; });
    const config = ConfigSchema.parse({ widths: [2, 1], sampleSize: 2, concurrency: 2 });
    const worker: Worker = { async complete(r) {
            if (r.role.endsWith("/critic"))
                return { text: JSON.stringify({ verdict: "accept", summary: "Fixture review", issues: [], resolved: [] }) };
            const input = JSON.parse(r.prompt);
            if (input.candidate === 0)
                return { text: "Malformed JSON" };
            started();
            await blocked;
            return { text: JSON.stringify({ answer: "surviving sibling" }) };
        } };
    let settled = false;
    const persisted: string[] = [];
    const runner = new StageRunner(new Broker(worker, config), config, async (a) => { persisted.push(a.id); });
    const run = runner.run("parallel", "fixture", {}, z.object({ answer: z.string() })).finally(() => { settled = true; });
    // Attach a rejection observer immediately, while asserting the operation remains live.
    const failed = assert.rejects(run);
    await ready;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false);
    release();
    await failed;
    assert.equal(persisted.length, 1);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(persisted.length, 1);
});
test("a locally rejected draft is retried with its exact rejection reason before the stage fails", async () => {
    const worker: Worker = { async complete(r) {
            if (r.role.endsWith("/generate")) {
                const input = JSON.parse(r.prompt);
                if (input.rejectedDraft === undefined)
                    return { text: '{"value":1}' };
                // The corrective retry must carry both the rejected draft and the validator's exact reason.
                assert.deepEqual(input.rejectedDraft, { value: 1 });
                assert.ok(r.system.includes("wrong value: 1"));
                return { text: '{"value":7}' };
            }
            return { text: JSON.stringify({ verdict: "accept", summary: "Fixture review", issues: [], resolved: [] }) };
        } };
    const config = ConfigSchema.parse({ widths: [1], maxSectionAttempts: 2 });
    const runner = new StageRunner(new Broker(worker, config), config);
    const root = await runner.run("example", "Generate", {}, output, { validate: v => { if (v.value !== 7) throw new Error(`wrong value: ${v.value}`); } });
    assert.equal(root.value.value, 7);
    assert.equal(runner.broker.usage.calls, 3); // initial draft, one corrected retry, one critic
});
test("a persistently rejected draft fails after bounded retries carrying the validator's reason", async () => {
    const worker: Worker = { async complete(r) {
            if (r.role.endsWith("/generate"))
                return { text: '{"value":1}' };
            return { text: JSON.stringify({ verdict: "accept", summary: "Fixture review", issues: [], resolved: [] }) };
        } };
    const config = ConfigSchema.parse({ widths: [2, 1], sampleSize: 2, maxSectionAttempts: 3 });
    const runner = new StageRunner(new Broker(worker, config), config);
    await assert.rejects(runner.run("example", "Generate", {}, output, { validate: v => { if (v.value !== 7) throw new Error(`wrong value: ${v.value}`); } }), /wrong value: 1/);
    assert.equal(runner.broker.usage.calls, 6); // both leaves exhaust all attempts; no critics are dispatched
});
test("a schema-rejected draft is retried with the schema issues before the stage fails", async () => {
    const worker: Worker = { async complete(r) {
            if (r.role.endsWith("/generate")) {
                if (!r.system.includes("rejected the previous draft"))
                    return { text: '{"value":"one"}' };
                assert.ok(r.system.includes("invalid_type"));
                return { text: '{"value":2}' };
            }
            return { text: JSON.stringify({ verdict: "accept", summary: "Fixture review", issues: [], resolved: [] }) };
        } };
    const config = ConfigSchema.parse({ widths: [1], maxSectionAttempts: 2 });
    const runner = new StageRunner(new Broker(worker, config), config);
    const root = await runner.run("example", "Generate", {}, output);
    assert.equal(root.value.value, 2);
    assert.equal(runner.broker.usage.calls, 3); // shape-rejected draft, corrected draft, one critic
});
test("a persistently schema-rejected draft fails after bounded retries with the schema error", async () => {
    const worker: Worker = { async complete(r) {
            if (r.role.endsWith("/generate"))
                return { text: '{"value":"one"}' };
            return { text: JSON.stringify({ verdict: "accept", summary: "Fixture review", issues: [], resolved: [] }) };
        } };
    const config = ConfigSchema.parse({ widths: [1], maxSectionAttempts: 3 });
    const runner = new StageRunner(new Broker(worker, config), config);
    await assert.rejects(runner.run("example", "Generate", {}, output), z.ZodError);
    assert.equal(runner.broker.usage.calls, 3);
});
test("transport failures are never retried", async () => {
    let calls = 0;
    const worker: Worker = { async complete() { calls++; throw new Error("Provider error"); } };
    const config = ConfigSchema.parse({ widths: [1], maxSectionAttempts: 3 });
    const runner = new StageRunner(new Broker(worker, config), config);
    await assert.rejects(runner.run("example", "Generate", {}, output), /Provider error/);
    assert.equal(calls, 1);
});
