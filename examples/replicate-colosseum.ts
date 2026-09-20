import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { Broker, type Worker } from "../src/inference.ts";
import { ConfigSchema } from "../src/schema.ts";
import { StageRunner } from "../src/tree.ts";

const Candidate = z.object({ target: z.string(), predictions: z.array(z.number().int()).length(3), argument: z.string() }).strict();
const target = "For x = 0, 1, 2, predict x^2 exactly";
const expected = [0, 1, 4];
const correct = (value: z.infer<typeof Candidate>) => value.target === target && value.predictions.every((x, i) => x === expected[i]);

function fixture(seed: number): Worker {
    const correctIndex = seed % 4;
    return { async complete(request) {
        const input = JSON.parse(request.prompt);
        if (request.role.endsWith("/generate")) {
            const index = input.candidate as number;
            const predictions = index === correctIndex ? expected : [0, 1, 5 + index];
            return { text: JSON.stringify({ target, predictions, argument: index === correctIndex ? "Direct substitution gives 0, 1, and 4." : "A deliberately flawed fixture candidate." }) };
        }
        if (request.role.endsWith("/critic")) {
            const value = input.artifact as z.infer<typeof Candidate>;
            const issues = correct(value) ? [] : [{ claim: "The prediction at x=2 is wrong", reason: `Expected 4, received ${value.predictions[2]}`, severity: "fatal", scope: "artifact", sections: [] }];
            return { text: JSON.stringify({ verdict: issues.length ? "reject" : "accept", summary: issues.length ? "Exact check failed" : "All three substitutions checked", issues, resolved: [] }) };
        }
        if (request.role.endsWith("/synthesize")) {
            const candidates = input.candidates as { value: z.infer<typeof Candidate>; objections: { severity: string }[] }[];
            const selected = candidates.find(candidate => !candidate.objections.some(objection => objection.severity !== "minor")) ?? candidates[0]!;
            return { text: JSON.stringify({ value: selected.value, resolutions: [] }) };
        }
        throw new Error(`Unexpected role ${request.role}`);
    } };
}

const { values } = parseArgs({ options: { episodes: { type: "string", default: "100" }, out: { type: "string", default: "test-output/replication-colosseum" } } });
const episodeCount = Number(values.episodes);
if (!Number.isInteger(episodeCount) || episodeCount < 1 || episodeCount > 10000) throw new Error("--episodes must be an integer from 1 to 10000");
const results = [];
for (let seed = 0; seed < episodeCount; seed++) {
    const directBroker = new Broker(fixture(seed), ConfigSchema.parse({ widths: [1], maxCalls: 1, maxReservedOutputTokens: 4096 }));
    const direct = await directBroker.ask("fault/generate", "Return one candidate", { candidate: 0 }, Candidate);
    const config = ConfigSchema.parse({ widths: [4, 2, 1], sampleSize: 2, reviewers: 1, seed, maxCalls: 20, maxReservedOutputTokens: 20 * 4096 });
    const runner = new StageRunner(new Broker(fixture(seed), config), config);
    const tree = await runner.run("fault", "Return one candidate", { target }, Candidate);
    results.push({ seed, correctLeaf: seed % 4, directCorrect: correct(direct), treeCorrect: correct(tree.value), treeCalls: runner.broker.usage.calls, unresolvedObjections: tree.objections.length });
}
const summary = {
    episodes: results.length,
    directCorrect: results.filter(result => result.directCorrect).length,
    adversarialTreeCorrect: results.filter(result => result.treeCorrect).length,
    meanTreeCalls: results.reduce((sum, result) => sum + result.treeCalls, 0) / results.length,
};
const caveat = "Deterministic fault-injection test of pi-math's orchestration, not a language-model or TCS-Bench replication. The fixture deliberately makes exact critics reliable and rotates one correct leaf among four; the result measures whether critique-preserving overlapping aggregation can recover that leaf under this known process.";
const report = { version: 1, sourcePaper: "arXiv:2609.15983v2", configuration: { widths: [4, 2, 1], sampleSize: 2, reviewers: 1 }, caveat, summary, results };
const out = resolve(values.out);
await mkdir(out, { recursive: true });
await writeFile(join(out, "report.json"), JSON.stringify(report, null, 2) + "\n");
const md = `# Colosseum mechanism replication attempt\n\n${caveat}\n\n| Condition | Exact successes | Episodes | Calls per episode |\n| --- | ---: | ---: | ---: |\n| Single candidate | ${summary.directCorrect} | ${summary.episodes} | 1 |\n| Adversarial overlapping tree | ${summary.adversarialTreeCorrect} | ${summary.episodes} | ${summary.meanTreeCalls} |\n\nThe comparison intentionally does not control total inference compute and cannot estimate model-level accuracy. The JSON report records every seed and retained-objection count.\n`;
await writeFile(join(out, "report.md"), md);
console.log(md);
