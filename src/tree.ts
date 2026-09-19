import { z } from "zod";
import { randomUUID } from "node:crypto";
import { Broker, seededRandom, sample, settleAll } from "./inference.ts";
import { ReviewSchema, ResolutionSchema, type Bundle, type Objection, type Review, type Config, type IssueSchema } from "./schema.ts";
const PERSPECTIVES = ["constructive proof", "extremal and boundary cases", "alternative representation", "reduction to known results", "algebraic or invariant approach", "counterexample and minimal hypotheses"];
const ATTACK = "Independently attack the supplied artifact. Check target mismatch, hidden hypotheses, circular reasoning, undeclared dependencies, citations, boundary cases and unexecuted computational claims. Do not repair it. Every serious objection needs a concrete claim and reason. Review all inherited objections. Resolve one only with a specific mathematical argument or an explicit explanation that the revised artifact no longer uses the attacked claim. Never resolve by vote or agreement. Return section IDs for cross-section defects. An empty objection list is not certification.";
export interface TreeOptions<T> {
    validate?: (value: T) => void;
    intrinsicIssues?: (value: T) => z.infer<typeof IssueSchema>[];
    preserveAllObjections?: boolean;
    inheritedObjections?: Objection[];
}
export class StageRunner {
    private serial = 0;
    private runId = randomUUID();
    private random: () => number;
    readonly artifacts: Bundle<unknown>[] = [];
    constructor(readonly broker: Broker, readonly config: Config = broker.config, readonly onArtifact: (artifact: Bundle<unknown>) => Promise<void> = async () => { }) { this.random = seededRandom(config.seed); }
    async run<T>(stage: string, instruction: string, input: unknown, schema: z.ZodType<T>, options: TreeOptions<T> = {}): Promise<Bundle<T>> {
        const stageId = `s-${this.runId}-${++this.serial}`;
        const targetObjections = new Map<string, Objection>();
        const merge = (groups: readonly (readonly Objection[])[]) => [...new Map(groups.flat().map(o => [o.id, o])).values()];
        const review = async (id: string, value: T, inherited: Objection[], proposedResolutions: {
            id: string;
            reason: string;
        }[], parents: string[]): Promise<Bundle<T>> => {
            options.validate?.(value);
            const intrinsic = (options.intrinsicIssues?.(value) ?? []).map((issue, i) => ({ ...issue, id: `${id}-finding-${i}`, source: id }));
            const all = merge([inherited, intrinsic]);
            const reviews = await settleAll(Array.from({ length: this.config.reviewers }, async (_, i) => {
                const reviewId = `${id}-review-${i}`;
                const judgment = await this.broker.ask(`${stage}/critic`, ATTACK, { task: input, artifact: value, inheritedObjections: all, proposedResolutions, perspective: PERSPECTIVES[i % PERSPECTIVES.length] }, ReviewSchema);
                const allowed = new Set(all.map(o => o.id));
                if (judgment.resolved.some(r => !allowed.has(r.id)))
                    throw new Error("Reviewer attempted to resolve an unknown objection");
                return { id: reviewId, review: judgment };
            }));
            // A discharge needs explicit agreement by every independent reviewer.
            const resolved = new Set(reviews[0]!.review.resolved.map(r => r.id).filter(id => reviews.every(r => r.review.resolved.some(x => x.id === id))));
            const objections = all.filter(o => !resolved.has(o.id));
            for (const r of reviews) {
                for (const [i, issue] of r.review.issues.entries())
                    objections.push({ ...issue, id: `${r.id}-issue-${i}`, source: r.id });
                if (r.review.verdict !== "accept" && !r.review.issues.some(o => o.severity !== "minor"))
                    objections.push({ id: `${r.id}-verdict`, source: r.id, claim: "Reviewer did not accept this artifact", reason: r.review.summary, severity: "major", scope: "artifact", sections: [] });
            }
            for (const o of objections)
                if (o.scope === "target" || options.preserveAllObjections)
                    targetObjections.set(o.id, o);
            const result: Bundle<T> = { id, value, objections, reviews, parents };
            this.artifacts.push(result);
            await this.onArtifact(result);
            return result;
        };
        // Drafts rejected by the response schema or the caller's local validator get bounded retries carrying the exact rejection reason; transport, budget and cancellation failures propagate untouched, and the final check still throws so invalid drafts can never pass silently.
        const askValidated = async <V>(role: string, prompt: string, payload: Record<string, unknown>, responseSchema: z.ZodType<V>, extract: (response: V) => T): Promise<V> => {
            let feedback: string | null = null, rejectedDraft: unknown;
            for (let attempt = 0; attempt < this.config.maxSectionAttempts; attempt++) {
                const last = attempt === this.config.maxSectionAttempts - 1;
                let response: V;
                try {
                    response = await this.broker.ask(role, feedback === null ? prompt : `${prompt}\nA local validator rejected the previous draft: ${feedback}\nReturn a corrected draft that satisfies this requirement exactly.`, feedback === null ? payload : { ...payload, rejectedDraft }, responseSchema);
                }
                catch (error) {
                    if (!(error instanceof z.ZodError) || last)
                        throw error;
                    feedback = JSON.stringify(error.issues);
                    rejectedDraft = undefined;
                    continue;
                }
                try {
                    options.validate?.(extract(response));
                    return response;
                }
                catch (error) {
                    if (last)
                        throw error;
                    feedback = error instanceof Error ? error.message : String(error);
                    rejectedDraft = extract(response);
                }
            }
            throw new Error("Unreachable: maxSectionAttempts is at least one");
        };
        let population = await settleAll(Array.from({ length: this.config.widths[0]! }, async (_, i) => {
            const id = `${stageId}-leaf-${i}`;
            const value = await askValidated(`${stage}/generate`, instruction, { task: input, perspective: PERSPECTIVES[i % PERSPECTIVES.length], candidate: i }, schema, v => v);
            return review(id, value, options.inheritedObjections ?? [], [], []);
        }));
        for (let level = 1; level < this.config.widths.length; level++) {
            const groups = Array.from({ length: this.config.widths[level]! }, () => sample(population, this.config.sampleSize, this.random));
            const isRoot = level === this.config.widths.length - 1;
            population = await settleAll(groups.map(async (group, i) => {
                const id = `${stageId}-level-${level}-${i}`;
                const inherited = merge([...group.map(c => c.objections), ...(isRoot ? [[...targetObjections.values()]] : [])]);
                const result = await askValidated(`${stage}/synthesize`, `${instruction}\nConstruct one new artifact from the sampled candidates AND critiques. Combine compatible mathematics, preserve useful minority routes, and retain uncertainty. This is synthesis, not majority voting. Supply a disposition for any inherited objection you believe is repaired, refuted or irrelevant; a separate reviewer decides whether it is discharged.`, { task: input, candidates: group, inheritedObjections: inherited }, z.object({ value: schema, resolutions: z.array(ResolutionSchema).max(100) }).strict(), r => r.value);
                if (result.resolutions.some(r => !inherited.some(o => o.id === r.id)))
                    throw new Error("Aggregator referenced an unknown objection");
                return review(id, result.value, inherited, result.resolutions, group.map(g => g.id));
            }));
        }
        return population[0]!;
    }
}
