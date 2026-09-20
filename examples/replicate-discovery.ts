import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { AlgebraProver } from "../src/certificate.ts";
import { conceptFlags } from "../src/concepts.ts";
import { DiscoveryEngine, newDiscovery, parseDataset, type Dataset } from "../src/discovery.ts";
import { n, op, v, type Expr } from "../src/expressions.ts";
import { seededRandom } from "../src/inference.ts";
import { HeuristicPolicy } from "../src/policies.ts";

const modes = [
    { name: "M0-full", dynamicData: true, proofFeedback: true, controller: true },
    { name: "M1-no-provability-feedback", dynamicData: true, proofFeedback: false, controller: true },
    { name: "M2-no-skeptic", dynamicData: false, proofFeedback: true, controller: true },
    { name: "regression-only", dynamicData: false, proofFeedback: false, controller: false },
] as const;

function d0(seed: number, rowsPerSurface = 12): Dataset {
    const random = seededRandom(seed), rows: Dataset["rows"] = [];
    const chosen = new Set<number>();
    while (chosen.size < rowsPerSurface * 2) chosen.add(4 + Math.floor(random() * 200));
    const vertices = [...chosen];
    for (let i = 0; i < rowsPerSurface; i++) {
        const V = vertices[i]!, F = 2 * V - 4, E = 3 * V - 6;
        rows.push({ id: `sphere-${i}`, values: { V, E, F, r1: V - 1, n1: E - V + 1, r2: F - 1, n2: 1 } });
    }
    for (let i = 0; i < rowsPerSurface; i++) {
        const V = Math.max(7, vertices[rowsPerSurface + i]!), F = 2 * V, E = 3 * V;
        rows.push({ id: `torus-${i}`, values: { V, E, F, r1: V - 1, n1: E - V + 1, r2: F - 1, n2: 1 } });
    }
    const patch = (id: string) => ({ id, weights: rows.map((row, i) => row.id.startsWith("sphere") && (i + Math.floor(random() * 3)) % 3 !== 0 ? 0.5 + random() / 2 : 0) });
    const patches = [patch("local-a"), patch("local-b")];
    for (const weights of patches.map(p => p.weights))
        if (!weights.some(w => w > 0)) weights[0] = 1;
    return parseDataset({
        description: "Synthetic D0-style connected orientable triangulated spheres and tori. Counts obey the closed-surface identities; this is not the paper's sampled incidence-matrix dataset.",
        features: ["V", "E", "F", "r1", "n1", "r2", "n2"], rows,
        premises: [
            op("eq", op("add", v("r1"), v("n1")), v("E")),
            op("eq", op("add", v("r2"), v("n2")), v("F")),
            op("eq", op("sub", v("V"), v("r1")), n(1)),
            op("eq", v("n2"), n(1)),
        ], patches,
    });
}

const { values } = parseArgs({ options: { episodes: { type: "string", default: "30" }, rounds: { type: "string", default: "10" }, out: { type: "string", default: "test-output/replication-discovery" } } });
const episodeCount = Number(values.episodes), roundLimit = Number(values.rounds);
if (!Number.isInteger(episodeCount) || episodeCount < 1 || episodeCount > 1000) throw new Error("--episodes must be an integer from 1 to 1000");
if (!Number.isInteger(roundLimit) || roundLimit < 1 || roundLimit > 50) throw new Error("--rounds must be an integer from 1 to 50");
const seeds = Array.from({ length: episodeCount }, (_, i) => 1009 + i * 7919);
interface Result {
    seed: number; mode: string; status: string; rounds: number;
    noticedChi: boolean; noticedB1: boolean; completedLearningProblem: boolean; certifiedNondegenerate: number;
    statements: { statement: Expr; concepts: { chi: boolean; b1: boolean }; proof: string; nondegenerate: boolean; reasons: string[] }[];
}
const results: Result[] = [];
for (const seed of seeds)
    for (const mode of modes) {
        const state = newDiscovery(d0(seed), roundLimit);
        state.ablations = { dynamicData: mode.dynamicData, proofFeedback: mode.proofFeedback, controller: mode.controller };
        const engine = new DiscoveryEngine(state, new HeuristicPolicy(), new AlgebraProver());
        while (state.status === "active") await engine.step();
        const flags = state.rounds.map(round => conceptFlags(round.conjecture));
        const completed = state.rounds.some((round, i) => flags[i]!.chi && flags[i]!.b1 && round.proof.rho === 1 && round.evidence.nondegenerate);
        results.push({ seed, mode: mode.name, status: state.status, rounds: state.rounds.length,
            noticedChi: flags.some(f => f.chi), noticedB1: flags.some(f => f.b1), completedLearningProblem: completed,
            certifiedNondegenerate: state.rounds.filter(r => r.proof.rho === 1 && r.evidence.nondegenerate).length,
            statements: state.rounds.map((r, i) => ({ statement: r.conjecture, concepts: flags[i]!, proof: r.proof.outcome, nondegenerate: r.evidence.nondegenerate, reasons: r.evidence.reasons })) });
    }

const summary = modes.map(mode => {
    const episodes = results.filter(r => r.mode === mode.name), denominator = episodes.length;
    return { mode: mode.name, episodes: denominator,
        noticedChi: episodes.filter(r => r.noticedChi).length,
        noticedB1: episodes.filter(r => r.noticedB1).length,
        completedLearningProblem: episodes.filter(r => r.completedLearningProblem).length,
        certifiedNondegenerate: episodes.filter(r => r.certifiedNondegenerate > 0).length };
});
const caveat = `Paired deterministic evaluation of pi-math's bounded heuristic policy on generated D0-style integer summaries. It does not train MADDPG, use PySR, execute the paper's incidence matrices, or reproduce its reported percentages/confidence intervals. ${episodeCount} generated datasets are sensitivity trials, not independent learned policies.`;
const report = { version: 1, sourcePaper: "arXiv:2603.04528v2", seeds, rowsPerSurface: 12, roundLimit, conceptMetric: "An arithmetic subexpression proportional to V-E+F (chi) or n1-r2 (b1); completion additionally requires both, exact certification, and nondegeneracy.", caveat, summary, results };
const out = resolve(values.out);
await mkdir(out, { recursive: true });
await writeFile(join(out, "report.json"), JSON.stringify(report, null, 2) + "\n");
const md = `# Concept-discovery replication attempt\n\n${caveat}\n\n| Mode | Episodes | Noticed χ | Noticed b1 | Certified relation using both | Any certified nondegenerate statement |\n| --- | ---: | ---: | ---: | ---: | ---: |\n${summary.map(r => `| ${r.mode} | ${r.episodes} | ${r.noticedChi} | ${r.noticedB1} | ${r.completedLearningProblem} | ${r.certifiedNondegenerate} |`).join("\n")}\n\nThe JSON report contains every statement, proof outcome, and nondegeneracy reason. A zero is a failed replication under this adaptation, not evidence against the paper.\n`;
await writeFile(join(out, "report.md"), md);
console.log(md);
