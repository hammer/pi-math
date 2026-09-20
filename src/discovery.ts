import { z } from "zod";
import { randomUUID } from "node:crypto";
import { hash } from "./store.ts";
import { ExprSchema, parseExpr, typeOf, evaluate, canonical, tautology, size, type Expr, FeatureName } from "./expressions.ts";
import { certify, verifyCertificate, type Prover, type ProofFeedback } from "./certificate.ts";
import { leanSource, cleanLeanAxioms } from "./lean.ts";
import { settleAll } from "./inference.ts";
const Weight = z.number().finite().min(0).max(1);
const RowSchema = z.object({ id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,95}$/), values: z.record(FeatureName, z.number().int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER)) }).strict();
export const DatasetSchema = z.object({
    description: z.string().min(1).max(20000), features: z.array(FeatureName).min(1).max(24),
    rows: z.array(RowSchema).min(1).max(1000),
    premises: z.array(ExprSchema).max(32).default([]),
    patches: z.array(z.object({ id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/), weights: z.array(Weight).max(1000) }).strict()).min(1).max(8),
}).strict();
export type Dataset = z.infer<typeof DatasetSchema>;
export type Patch = Dataset["patches"][number];
export interface VisibleRow {
    id: string;
    values: Record<string, number>;
    weight: number;
}
export function parseDataset(raw: unknown): Dataset {
    if (raw && typeof raw === "object") {
        const x = raw as {
            premises?: unknown[];
            features?: string[];
        };
        if (Array.isArray(x.premises) && Array.isArray(x.features))
            for (const p of x.premises)
                parseExpr(p, x.features);
    }
    const d = DatasetSchema.parse(raw);
    if (new Set(d.features).size !== d.features.length || new Set(d.rows.map(r => r.id)).size !== d.rows.length || new Set(d.patches.map(p => p.id)).size !== d.patches.length)
        throw new Error("Duplicate dataset identifiers");
    for (const row of d.rows)
        if (d.features.some(f => !Object.hasOwn(row.values, f)) || Object.keys(row.values).some(f => !d.features.includes(f)))
            throw new Error("Every row must contain exactly the declared features");
    for (const p of d.premises)
        if (typeOf(p, d.features) !== "boolean")
            throw new Error("Premise must be a proposition");
    for (const patch of d.patches)
        validatePatch(patch, d.rows.length);
    return d;
}
function validatePatch(patch: Patch, count: number): void {
    if (patch.weights.length !== count || !patch.weights.some(w => w > 0) || patch.weights.some(w => !Number.isFinite(w) || w < 0 || w > 1))
        throw new Error("Patch needs bounded weights and positive visible mass");
}
export function visibleRows(d: Dataset, weights: readonly number[]): VisibleRow[] { return d.rows.flatMap((row, i) => weights[i]! > 0 ? [{ ...row, weight: weights[i]! }] : []); }
export function unionWeights(d: Dataset): number[] { return d.rows.map((_, i) => Math.max(...d.patches.map(p => p.weights[i]!))); }
export function weightedAccuracy(expr: Expr, rows: readonly VisibleRow[]): number {
    const mass = rows.reduce((s, r) => s + r.weight, 0);
    if (!mass)
        throw new Error("No weighted data");
    return rows.reduce((s, r) => s + (evaluate(expr, r.values) === true ? r.weight : 0), 0) / mass;
}
export interface EmpiricalEvidence {
    tested: number;
    counterexamples: string[];
    allDataTrue: boolean;
    accuracy: number;
    nondegenerate: boolean;
    reasons: string[];
}
export function assess(expr: Expr, d: Dataset): EmpiricalEvidence {
    parseExpr(expr, d.features);
    if (typeOf(expr, d.features) !== "boolean")
        throw new Error("Conjecture must be a proposition");
    const applicable = d.rows.filter(r => d.premises.every(p => evaluate(p, r.values) === true));
    const failures = applicable.filter(r => evaluate(expr, r.values) !== true).map(r => r.id);
    const reasons: string[] = [];
    if (!applicable.length)
        reasons.push("no-premise-witness");
    if (d.premises.some(p => canonical(p) === canonical(expr)))
        reasons.push("known-premise");
    // A syntactically different rearrangement of one supplied equality is still
    // background knowledge, not a discovered concept.  Keep combinations of
    // multiple premises eligible: those are exactly where useful derived
    // invariants such as Euler/Betti relations can appear.
    if (d.premises.some(p => certify(expr, [p])))
        reasons.push("known-premise-consequence");
    if (tautology(expr))
        reasons.push("propositional-tautology");
    if (certify(expr, []))
        reasons.push("algebraic-tautology");
    if (expr.kind === "implies" && certify(expr.right, d.premises))
        reasons.push("irrelevant-antecedent");
    function witness(e: Expr, rows: typeof applicable): void {
        if (e.kind === "implies") {
            const satisfying = rows.filter(r => evaluate(e.left, r.values) === true);
            if (!satisfying.length)
                reasons.push("vacuous-antecedent");
            witness(e.right, satisfying);
        }
        else if (e.kind === "and") {
            witness(e.left, rows);
            witness(e.right, rows);
        }
    }
    witness(expr, applicable);
    return { tested: applicable.length, counterexamples: failures, allDataTrue: applicable.length > 0 && !failures.length,
        accuracy: applicable.length ? (applicable.length - failures.length) / applicable.length : 0, nondegenerate: !reasons.length, reasons: [...new Set(reasons)] };
}
export const ControlsSchema = z.object({ featureCount: z.number().int().min(1).max(8), priors: z.partialRecord(z.enum(["add", "sub", "mul", "eq", "and", "implies", "not"]), z.number().min(-4).max(4)), reason: z.string().min(1).max(8000) }).strict();
export type Controls = z.infer<typeof ControlsSchema>;
export interface Atom {
    id: string;
    expression: Expr;
    description: string;
    patch: string;
    accuracy: number;
}
export interface Definition {
    name: string;
    expression: Expr;
    meaning: string;
    round: number;
}
export type Scaffold = {
    kind: "atom";
    id: string;
} | {
    kind: "not";
    arg: Scaffold;
} | {
    kind: "and" | "implies";
    left: Scaffold;
    right: Scaffold;
};
export const ScaffoldSchema: z.ZodType<Scaffold> = z.lazy(() => z.union([
    z.object({ kind: z.literal("atom"), id: z.string().min(1).max(96) }).strict(),
    z.object({ kind: z.literal("not"), arg: ScaffoldSchema }).strict(),
    z.object({ kind: z.enum(["and", "implies"]), left: ScaffoldSchema, right: ScaffoldSchema }).strict(),
]));
export function expandScaffold(tree: Scaffold, atoms: readonly Atom[], depth = 0): Expr {
    if (depth > 12)
        throw new Error("Scaffold too deep");
    if (tree.kind === "atom") {
        const atom = atoms.find(a => a.id === tree.id);
        if (!atom)
            throw new Error("Scaffolder invented an atom");
        return atom.expression;
    }
    if (tree.kind === "not")
        return { kind: "not", arg: expandScaffold(tree.arg, atoms, depth + 1) };
    return { kind: tree.kind, left: expandScaffold(tree.left, atoms, depth + 1), right: expandScaffold(tree.right, atoms, depth + 1) };
}
export interface FeatureInput {
    description: string;
    features: string[];
    patch: string;
    rows: VisibleRow[];
    controls: Controls;
    feedback: PolicyFeedback | null;
    history: PolicyHistory[];
}
export interface PolicyFeedback {
    rho: 0 | 1;
    outcome: ProofFeedback["outcome"];
    explanation: string;
    nondegenerate: boolean;
    reasons: string[];
}
export interface PolicyHistory {
    conjecture: Expr;
    feedback: PolicyFeedback;
}
export interface Policy {
    control(input: {
        previous: Controls;
        feedback: PolicyFeedback | null;
        round: number;
        history: PolicyHistory[];
    }): Promise<Controls>;
    features(input: FeatureInput): Promise<{
        atoms: {
            expression: Expr;
            description: string;
        }[];
        definitions: {
            name: string;
            expression: Expr;
            meaning: string;
        }[];
    }>;
    scaffold(input: {
        features: string[];
        atoms: Atom[];
        rows: VisibleRow[];
        controls: Controls;
        feedback: PolicyFeedback | null;
        history: PolicyHistory[];
    }): Promise<{
        expression: Scaffold;
        reason: string;
    }>;
    skeptic(input: {
        dataset: Dataset;
        conjecture: Expr;
        evidence: EmpiricalEvidence;
        maxChanges: number;
    }): Promise<{
        updates: {
            patch: string;
            row: string;
            weight: number;
        }[];
        reason: string;
    }>;
}
export interface DiscoveryRound {
    index: number;
    premises: Expr[];
    weightsBefore: Patch[];
    weightsAfter: Patch[];
    controls: Controls;
    atoms: Atom[];
    conjecture: Expr;
    rationale: string;
    evidence: EmpiricalEvidence;
    proof: ProofFeedback;
    reward: {
        conjecturer: number;
        skeptic: number;
    };
    skepticReason: string;
}
export interface DiscoveryState {
    version: 1;
    id: string;
    dataset: Dataset;
    rounds: DiscoveryRound[];
    definitions: Definition[];
    controls: Controls;
    status: "active" | "candidate-found" | "exhausted";
    maxRounds: number;
    ablations: {
        dynamicData: boolean;
        proofFeedback: boolean;
        controller: boolean;
    };
}
export function newDiscovery(dataset: Dataset, maxRounds = 10): DiscoveryState {
    z.number().int().min(1).max(50).parse(maxRounds);
    return { version: 1, id: randomUUID(), dataset: parseDataset(dataset), rounds: [], definitions: [], controls: { featureCount: 3, priors: {}, reason: "Initial controls" }, status: "active", maxRounds,
        ablations: { dynamicData: true, proofFeedback: true, controller: true } };
}
export function updatePatches(d: Dataset, updates: {
    patch: string;
    row: string;
    weight: number;
}[], maxChanges: number): Patch[] {
    if (updates.length > maxChanges)
        throw new Error("Skeptic exceeded update budget");
    const next = structuredClone(d.patches), seen = new Set<string>();
    for (const u of updates) {
        Weight.parse(u.weight);
        const key = `${u.patch}/${u.row}`;
        if (seen.has(key))
            throw new Error("Duplicate skeptical update");
        seen.add(key);
        const patch = next.find(p => p.id === u.patch), i = d.rows.findIndex(r => r.id === u.row);
        if (!patch || i < 0)
            throw new Error("Skeptic named unknown data");
        patch.weights[i] = u.weight;
    }
    next.forEach(p => validatePatch(p, d.rows.length));
    return next;
}
export function checkedFeedback(expr: Expr, premises: Expr[], proof: ProofFeedback): void {
    if (proof.statementHash !== hash(expr) || proof.premisesHash !== hash(premises))
        throw new Error("Prover feedback is bound to a different statement or premise set");
    if (proof.rho !== (proof.outcome === "certified" || proof.outcome === "lean-checked" ? 1 : 0))
        throw new Error("Inconsistent prover feedback");
    if (proof.outcome === "certified" && (!proof.certificate || !verifyCertificate(expr, premises, proof.certificate)))
        throw new Error("Invalid algebra certificate");
    if (proof.outcome === "lean-checked") {
        const e = proof.execution;
        if (!e || e.sourceHash !== hash(leanSource(expr, premises)) || e.exitCode !== 0 || !cleanLeanAxioms(e.stdout))
            throw new Error("Invalid Lean execution evidence for this goal");
    }
}
export class DiscoveryEngine {
    constructor(readonly state: DiscoveryState, readonly policy: Policy, readonly prover: Prover, readonly signal?: AbortSignal) { }
    async step(): Promise<DiscoveryState> {
        const s = this.state;
        if (s.status !== "active")
            return s;
        if (this.signal?.aborted)
            throw new Error("Research cancelled");
        if (s.rounds.length >= s.maxRounds) {
            s.status = "exhausted";
            return s;
        }
        const last = s.rounds.at(-1);
        const feedback: PolicyFeedback | null = s.ablations.proofFeedback && last ? { rho: last.proof.rho, outcome: last.proof.outcome, explanation: last.proof.explanation, nondegenerate: last.evidence.nondegenerate, reasons: last.evidence.reasons } : null;
        const history: PolicyHistory[] = s.rounds.map(round => ({ conjecture: round.conjecture, feedback: { rho: round.proof.rho, outcome: round.proof.outcome, explanation: round.proof.explanation, nondegenerate: round.evidence.nondegenerate, reasons: round.evidence.reasons } }));
        const controls = s.ablations.controller ? ControlsSchema.parse(await this.policy.control({ previous: s.controls, feedback, round: s.rounds.length, history })) : s.controls;
        const d = structuredClone(s.dataset);
        if (!s.ablations.dynamicData)
            d.patches = d.patches.map(p => ({ ...p, weights: d.rows.map(() => 1) }));
        const results = await settleAll(d.patches.map(p => this.policy.features({ description: d.description, features: d.features, patch: p.id, rows: visibleRows(d, p.weights), controls, feedback, history })));
        const atoms: Atom[] = [], definitions: Definition[] = [];
        for (const [i, result] of results.entries()) {
            if (result.atoms.length < 1 || result.atoms.length > controls.featureCount)
                throw new Error("Feature spotter exceeded its feature budget");
            for (const [j, atom] of result.atoms.entries()) {
                const expression = parseExpr(atom.expression, d.features);
                if (expression.kind !== "eq")
                    throw new Error("Atomic feature must be an arithmetic equality; logical composition belongs to the scaffolder");
                atoms.push({ id: `p${i}-a${j}`, expression, description: atom.description, patch: d.patches[i]!.id, accuracy: weightedAccuracy(expression, visibleRows(d, d.patches[i]!.weights)) });
            }
            if (result.definitions.length > 8)
                throw new Error("Too many proposed definitions");
            for (const def of result.definitions)
                definitions.push({ ...def, expression: parseExpr(def.expression, d.features), round: s.rounds.length });
        }
        const scaffold = await this.policy.scaffold({ features: d.features, atoms, rows: visibleRows(d, unionWeights(d)), controls, feedback, history });
        const conjecture = parseExpr(expandScaffold(scaffold.expression, atoms), d.features), evidence = assess(conjecture, d);
        const proof = await this.prover.prove(conjecture, d.premises, this.signal);
        checkedFeedback(conjecture, d.premises, proof);
        if (proof.rho === 1 && evidence.counterexamples.length)
            throw new Error("Prover and exact data evaluation disagree; investigate before continuing");
        const maxChanges = Math.max(1, Math.ceil(d.rows.length * d.patches.length / 4));
        const skeptical = s.ablations.dynamicData ? await this.policy.skeptic({ dataset: d, conjecture, evidence, maxChanges }) : { updates: [], reason: "Dynamic data ablated: all weights fixed at one" };
        const patches = updatePatches(d, skeptical.updates, maxChanges);
        if (this.signal?.aborted)
            throw new Error("Research cancelled");
        const terminal = proof.rho === 1 && evidence.nondegenerate;
        const complexity = evidence.nondegenerate ? Math.min(size(conjecture), 31) / 3100 : 0;
        s.rounds.push({ index: s.rounds.length, premises: structuredClone(d.premises), weightsBefore: d.patches, weightsAfter: patches, controls, atoms, conjecture, rationale: scaffold.reason, evidence, proof,
            reward: { conjecturer: (terminal ? 1 : 0) + complexity, skeptic: terminal ? -1 : skeptical.updates.length / 1000 }, skepticReason: skeptical.reason });
        s.dataset.patches = patches;
        s.controls = controls;
        s.definitions.push(...definitions);
        s.status = terminal ? "candidate-found" : s.rounds.length >= s.maxRounds ? "exhausted" : "active";
        return s;
    }
}
