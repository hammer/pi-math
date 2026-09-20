import { z } from "zod";
import { Broker } from "./inference.ts";
import { ControlsSchema, ScaffoldSchema, weightedAccuracy, type Policy, type FeatureInput, type Atom, type Controls, type VisibleRow } from "./discovery.ts";
import { ExprSchema, n, v, op, canonical, formatExpr, size, evaluate, type Expr } from "./expressions.ts";
import { certify } from "./certificate.ts";
const FeatureOutput = z.object({
    atoms: z.array(z.object({ expression: ExprSchema, description: z.string().min(1).max(8000) }).strict()).min(1).max(8),
    definitions: z.array(z.object({ name: z.string().min(1).max(200), expression: ExprSchema, meaning: z.string().min(1).max(8000) }).strict()).max(8),
}).strict();
/** Independent model contexts: no parent chat, tools, hidden rows or Lean source. */
export class ModelPolicy implements Policy {
    constructor(readonly broker: Broker) { }
    control(input: Parameters<Policy["control"]>[0]) {
        return this.broker.ask("discovery/controller", "Choose bounded search controls using the previous proof feedback, including zero/unknown outcomes. Vary feature count and operator priors to seek different conjectures. Do not use statement length as a substitute for mathematical value.", input, ControlsSchema);
    }
    features(input: FeatureInput) {
        return this.broker.ask("discovery/feature", "Spot local patterns in the supplied weighted data patch. Propose at most featureCount atomic equalities using only declared integer features and +, -, *. Do not assume hidden data satisfy them. You may propose named mathematical definitions separately. Fit is empirical evidence, not proof. Use prior failure feedback to revise your feature choices.", input, FeatureOutput);
    }
    scaffold(input: Parameters<Policy["scaffold"]>[0]) {
        return this.broker.ask("discovery/scaffold", "Combine supplied atomic IDs into one global conjecture with conjunction, implication or negation. You cannot invent atomic formulas. Use the max-union of patch weights provided. Avoid known, vacuous or tautological statements; seek hypotheses that explain why a relation holds. Your statement will be evaluated and independently proved in a restricted mathematical environment.", input, z.object({ expression: ScaffoldSchema, reason: z.string().min(1).max(8000) }).strict());
    }
    skeptic(input: Parameters<Policy["skeptic"]>[0]) {
        return this.broker.ask("discovery/skeptic", "Challenge the current conjecture by changing attention to mathematical data. You can see the full dataset, including rows withheld from conjecturers. Reveal informative counterexamples or overlooked regimes through bounded weight changes, not a rewritten conjecture. Use at most maxChanges distinct patch/row updates in [0,1], retain positive mass in every patch. When a meaningful conjecture survives, preserve evidence of that outcome.", input, z.object({ updates: z.array(z.object({ patch: z.string(), row: z.string(), weight: z.number().min(0).max(1) }).strict()).max(2000), reason: z.string().min(1).max(8000) }).strict());
    }
}
/** Numerically stable log of the paper-inspired nested-exponential objective. */
export function regressionLoss(expr: Expr, accuracy: number, priors: Controls["priors"], alpha = 3): number {
    if (!Number.isFinite(accuracy) || accuracy < 0 || accuracy > 1)
        throw new Error("Invalid empirical accuracy");
    let prior = 0;
    function visit(e: Expr) { if (e.kind === "int" || e.kind === "var")
        return; prior += priors[e.kind] ?? 0; if (e.kind === "not")
        visit(e.arg);
    else {
        visit(e.left);
        visit(e.right);
    } }
    visit(expr);
    return Math.exp(alpha * (1 - accuracy)) - prior + size(expr) * 0.002;
}
/** Bounded enumerative symbolic regression; a baseline, not PySR or a trained policy. */
export function spotSymbolically(input: FeatureInput): {
    expression: Expr;
    description: string;
}[] {
    const leaves = [...input.features.map(v), n(0), n(1), n(2)], terms: Expr[] = [...leaves];
    const limit = 2500;
    // Size-limited arithmetic vocabulary, ordered by current operator priors.
    const ops = (['add', 'sub', 'mul'] as const).toSorted((a, b) => (input.controls.priors[b] ?? 0) - (input.controls.priors[a] ?? 0));
    outer: for (const kind of ops)
        for (const a of input.features.map(v))
            for (const b of input.features.map(v)) {
                terms.push(op(kind, a, b));
                if (terms.length >= limit)
                    break outer;
            }
    const pairs = terms.slice(leaves.length);
    outer: for (const pair of pairs)
        for (const leaf of input.features.map(v))
            for (const kind of ['add', 'sub'] as const) {
                terms.push(op(kind, pair, leaf));
                if (terms.length >= limit)
                    break outer;
            }
    const candidates = new Map<string, {
        expression: Expr;
        score: number;
    }>();
    // Evaluate each arithmetic term once, then compare its vector to simple targets.
    const targets = leaves.map(expression => ({ expression, values: input.rows.map(r => evaluate(expression, r.values)) }));
    const mass = input.rows.reduce((s, r) => s + r.weight, 0);
    if (!mass)
        throw new Error("No visible data for regression");
    for (const term of terms) {
        const values = input.rows.map(r => evaluate(term, r.values));
        for (const target of targets) {
            const accuracy = input.rows.reduce((s, r, i) => s + (values[i] === target.values[i] ? r.weight : 0), 0) / mass;
            if (accuracy < 0.7)
                continue;
            const expression = op("eq", term, target.expression);
            if (certify(expression, []))
                continue; // Arithmetic identities do not constitute discovered features.
            const key = canonical(expression), score = regressionLoss(expression, accuracy, input.controls.priors);
            if (!candidates.has(key) || score < candidates.get(key)!.score)
                candidates.set(key, { expression, score });
        }
    }
    const ranked = [...candidates.values()].sort((a, b) => a.score - b.score || canonical(a.expression).localeCompare(canonical(b.expression)));
    if (!ranked.length)
        throw new Error("No supported symbolic feature found; change the data, vocabulary or model policy");
    return ranked.slice(0, input.controls.featureCount).map(x => ({ expression: x.expression, description: `Enumerated relation ${formatExpr(x.expression)}` }));
}
export class HeuristicPolicy implements Policy {
    async control(input: Parameters<Policy["control"]>[0]) {
        const failed = input.feedback !== null && (input.feedback.rho === 0 || !input.feedback.nondegenerate);
        return { featureCount: failed ? Math.min(8, input.previous.featureCount + 1) : input.previous.featureCount,
            priors: { ...input.previous.priors, sub: failed ? Math.min(0.2, (input.previous.priors.sub ?? 0) + 0.02) : 0 }, reason: failed ? "Broaden features after unsuccessful proof feedback" : "Initial bounded symbolic search" };
    }
    async features(input: FeatureInput) { return { atoms: spotSymbolically(input), definitions: [] }; }
    async scaffold(input: Parameters<Policy["scaffold"]>[0]): ReturnType<Policy["scaffold"]> {
        const ranked = input.atoms.map(a => ({ atom: a, accuracy: weightedAccuracy(a.expression, input.rows) })).sort((a, b) => b.accuracy - a.accuracy || size(b.atom.expression) - size(a.atom.expression));
        const best = ranked[0];
        if (!best)
            throw new Error("No atoms to scaffold");
        const seen = new Set(input.history.map(item => canonical(item.conjecture)));
        // Try a supported, nonvacuous relation between distinct features before falling back to one atom.
        if (input.feedback && (input.feedback.rho === 0 || !input.feedback.nondegenerate))
            for (const a of ranked)
                for (const b of ranked) {
                    if (a.atom.id === b.atom.id || canonical(a.atom.expression) === canonical(b.atom.expression))
                        continue;
                    const expression = op("implies", a.atom.expression, b.atom.expression);
                    if (seen.has(canonical(expression)))
                        continue;
                    if (certify(expression, []))
                        continue;
                    if (!input.rows.some(r => evaluate(a.atom.expression, r.values) === true))
                        continue;
                    if (weightedAccuracy(expression, input.rows) >= best.accuracy)
                        return { expression: { kind: "implies", left: { kind: "atom", id: a.atom.id }, right: { kind: "atom", id: b.atom.id } }, reason: "Relate local features under an explicit observed hypothesis" };
                }
        const unseen = ranked.find(item => !seen.has(canonical(item.atom.expression))) ?? best;
        return { expression: { kind: "atom", id: unseen.atom.id }, reason: "Best unseen weighted relation in the current bounded vocabulary" };
    }
    async skeptic(input: Parameters<Policy["skeptic"]>[0]) {
        const updates: {
            patch: string;
            row: string;
            weight: number;
        }[] = [];
        for (const row of input.evidence.counterexamples) {
            const i = input.dataset.rows.findIndex(r => r.id === row);
            for (const patch of input.dataset.patches)
                if (patch.weights[i] !== 1 && updates.length < input.maxChanges)
                    updates.push({ patch: patch.id, row, weight: 1 });
        }
        // If no refutation is available, widen exposure rather than announcing correctness.
        if (!updates.length)
            for (const patch of input.dataset.patches)
                for (const [i, weight] of patch.weights.entries())
                    if (weight === 0 && updates.length < input.maxChanges)
                        updates.push({ patch: patch.id, row: input.dataset.rows[i]!.id, weight: 1 });
        return { updates, reason: input.evidence.counterexamples.length ? "Increase weight on exactly evaluated counterexamples" : "Reveal additional data; no observed refutation is not proof" };
    }
}
