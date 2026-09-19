import { randomUUID } from "node:crypto";
import { z } from "zod";
import { StateSchema, ConfigSchema, StrategySchema, GateSchema, PlanSchema, SectionSchema, VerificationSchema, RevisionSchema, KnowledgeSchema, serious, type ResearchState, type Config, type Knowledge, type ProofPlan, } from "./schema.ts";
import { validatePlan, emptyProgress, frontier, reviseGraph } from "./graph.ts";
import { StageRunner } from "./tree.ts";
import { throwIfAborted } from "./inference.ts";
import { hash } from "./store.ts";
import { PROMPTS } from "./prompts.ts";
export function newResearch(problem: string, assumptions: string[] = [], config: Partial<Config> = {}): ResearchState {
    return StateSchema.parse({ version: 1, id: randomUUID(), revision: 0, createdAt: new Date().toISOString(), problem, assumptions,
        phase: "explore", round: 0, config: ConfigSchema.parse(config), strategy: null, gate: null, plan: null, sections: {}, verification: null,
        knowledge: [], archives: [], decisions: [], failure: null });
}
function sameAssumptions(actual: string[], expected: string[]): boolean {
    return JSON.stringify([...actual].sort()) === JSON.stringify([...expected].sort());
}
export function obligationIds(state: ResearchState): string[] {
    return [...new Set([...(state.strategy?.value.obligations ?? []), ...(state.gate?.value.obligations ?? [])].map(o => o.id))];
}
export function draft(state: ResearchState): string {
    if (!state.plan)
        return "";
    return `# ${state.plan.title}\n\n${state.plan.abstract}\n\n` + state.plan.sections.map((s, i) => `## ${i + 1}. ${s.title} [${s.id}]\n\n${state.sections[s.id]?.candidate?.value.body ?? `[Unfinished: ${s.task}]`}\n`).join("\n");
}
export function archive(state: ResearchState): void {
    if (state.strategy || state.plan)
        state.archives.push({ round: state.round, problem: state.problem, draft: draft(state), strategy: structuredClone(state.strategy), verification: structuredClone(state.verification) });
}
export function humanDecision(state: ResearchState, kind: ResearchState["decisions"][number]["kind"], reason: string): void {
    if (!reason.trim())
        throw new Error("A human decision needs a reason");
    state.decisions.push({ kind, reason, at: new Date().toISOString(), artifactHash: hash({ problem: state.problem, assumptions: state.assumptions, strategy: state.strategy, gate: state.gate, plan: state.plan, verification: state.verification }) });
}
/** This function is only exposed by human slash commands, never model tools. */
export function approve(state: ResearchState, reason: string): void {
    if (state.phase === "awaiting-route") {
        humanDecision(state, "route", reason);
        state.phase = "decompose";
    }
    else if (state.phase === "awaiting-plan") {
        humanDecision(state, "plan", reason);
        state.phase = "solve";
    }
    else if (state.phase === "awaiting-acceptance") {
        humanDecision(state, "accept", reason);
        state.phase = "accepted";
    }
    else
        throw new Error("There is no current artifact awaiting human approval");
    state.revision++;
}
export function reexplore(state: ResearchState, reason: string): void {
    archive(state);
    humanDecision(state, "reexplore", reason);
    state.phase = "explore";
    state.plan = null;
    state.sections = {};
    state.verification = null;
    state.gate = null;
    state.failure = null;
    state.revision++;
}
export function amend(state: ResearchState, problem: string, reason: string): void {
    if (!problem.trim())
        throw new Error("Empty target");
    reexplore(state, reason);
    humanDecision(state, "amend", reason);
    state.problem = problem;
    state.strategy = null;
    state.round = 0;
}
export function addKnowledge(state: ResearchState, knowledge: Knowledge): void {
    KnowledgeSchema.parse(knowledge);
    if (state.knowledge.some(k => k.id === knowledge.id))
        throw new Error("Knowledge IDs are immutable; add a new entry with provenance");
    state.knowledge.push(knowledge);
    state.revision++;
}
export class ProofEngine {
    constructor(readonly state: ResearchState, readonly runner: StageRunner, readonly checkpoint: (state: ResearchState) => Promise<void> = async () => { }) { }
    private context() {
        const s = this.state;
        return { problem: s.problem, assumptions: s.assumptions, knowledge: s.knowledge, strategy: s.strategy, gate: s.gate, plan: s.plan,
            previousAttempt: s.archives.at(-1) ?? null, globalReview: s.verification, round: s.round };
    }
    private async curate(start: number): Promise<void> {
        const artifacts = this.runner.artifacts.slice(start);
        const schema = z.object({ entries: z.array(KnowledgeSchema.omit({ id: true, status: true })).max(12) }).strict();
        const result = await this.runner.broker.ask("curator", PROMPTS.curate, { problem: this.state.problem, artifacts }, schema);
        const ids = new Set(artifacts.map(a => a.id));
        for (const entry of result.entries) {
            if (entry.sources.some(s => !ids.has(s)))
                throw new Error("Curator cited an unknown artifact");
            this.state.knowledge.push({ ...entry, id: `k-${randomUUID()}`, status: "unverified" });
        }
    }
    async step(): Promise<ResearchState> {
        const s = this.state;
        throwIfAborted(this.runner.broker.signal);
        if (["awaiting-route", "awaiting-plan", "awaiting-acceptance", "accepted", "blocked"].includes(s.phase))
            return s;
        s.failure = null;
        const start = this.runner.artifacts.length;
        try {
            switch (s.phase) {
                case "explore": {
                    if (s.round >= s.config.maxRounds) {
                        s.phase = "blocked";
                        s.failure = "Exploration round limit reached";
                        break;
                    }
                    const previous = s.archives.at(-1);
                    const review = s.verification ?? (previous?.problem === s.problem ? previous.verification : null);
                    s.strategy = await this.runner.run("explore", PROMPTS.explore, this.context(), StrategySchema, { inheritedObjections: [...(s.strategy?.objections ?? []), ...(review?.objections ?? [])], validate: value => {
                            if (value.target !== s.problem)
                                throw new Error(`Strategy changed the target: expected exactly ${JSON.stringify(s.problem)}, got ${JSON.stringify(value.target)}`);
                            if (!sameAssumptions(value.hypotheses, s.assumptions))
                                throw new Error(`Strategy changed the hypotheses: expected ${JSON.stringify(s.assumptions)}, got ${JSON.stringify(value.hypotheses)}`);
                            if (new Set(value.obligations.map(o => o.id)).size !== value.obligations.length)
                                throw new Error("Duplicate obligations");
                        } });
                    // Only completed explorations consume a round: a failed or invalid exploration must not eat the round budget.
                    s.round++;
                    s.gate = null;
                    s.plan = null;
                    s.sections = {};
                    s.verification = null;
                    s.phase = "gate";
                    await this.curate(start);
                    break;
                }
                case "gate": {
                    if (!s.strategy)
                        throw new Error("No strategy to assess");
                    s.gate = await this.runner.run("gate", PROMPTS.gate, this.context(), GateSchema);
                    const g = s.gate.value;
                    const obligations = [...s.strategy.value.obligations, ...g.obligations];
                    const ready = ["ready", "with-obligations"].includes(g.decision) && g.stableArchitecture && !serious(s.strategy.objections) && !serious(s.gate.objections) && obligations.every(o => o.severity === "minor");
                    if (ready)
                        s.phase = "awaiting-route";
                    else {
                        archive(s);
                        s.phase = "explore";
                    }
                    break;
                }
                case "decompose": {
                    const plan = await this.runner.run("decompose", PROMPTS.decompose, this.context(), PlanSchema, { validate: p => validatePlan(p, obligationIds(s)) });
                    if (serious(plan.objections))
                        throw new Error("Proof plan has unresolved material objections");
                    s.plan = plan.value;
                    s.sections = Object.fromEntries(s.plan.sections.map(t => [t.id, emptyProgress()]));
                    s.phase = "awaiting-plan";
                    break;
                }
                case "solve": {
                    if (!s.plan)
                        throw new Error("No proof plan");
                    const eligible = frontier(s.plan, s.sections);
                    if (!eligible.length)
                        throw new Error("No eligible proof section");
                    const exhausted = eligible.filter(id => s.sections[id]!.attempts >= s.config.maxSectionAttempts);
                    if (exhausted.length) {
                        s.phase = "blocked";
                        s.failure = `Local retry limit: ${exhausted.join(", ")}`;
                        break;
                    }
                    const result = await Promise.allSettled(eligible.map(async (id) => {
                        const task = s.plan!.sections.find(t => t.id === id)!;
                        const progress = s.sections[id]!;
                        progress.attempts++;
                        if (progress.candidate)
                            progress.previous.push(progress.candidate);
                        const candidate = await this.runner.run("section", PROMPTS.section, { ...this.context(), assigned: task,
                            dependencies: task.dependsOn.map(d => ({ task: s.plan!.sections.find(t => t.id === d), solution: s.sections[d]!.candidate })),
                            priorSection: progress.candidate ?? progress.previous.at(-1) ?? null }, SectionSchema, { inheritedObjections: [...(progress.candidate?.objections ?? progress.previous.at(-1)?.objections ?? []), ...(s.verification?.objections.filter(o => o.sections.includes(id)) ?? [])], validate: value => {
                                if (value.usedDependencies.some(d => !task.dependsOn.includes(d)))
                                    throw new Error("Section used an undeclared dependency");
                                if (!sameAssumptions(value.assumptions, s.assumptions))
                                    throw new Error("Section changed the hypotheses");
                            } });
                        throwIfAborted(this.runner.broker.signal);
                        progress.candidate = candidate;
                        progress.status = candidate.value.status === "complete" && !candidate.value.gaps.length && !serious(candidate.objections) ? "accepted" : "failed";
                        progress.failure = progress.status === "failed" ? "Incomplete section or unresolved local objection" : null;
                    }));
                    for (const [i, r] of result.entries())
                        if (r.status === "rejected") {
                            const p = s.sections[eligible[i]!]!;
                            p.status = "failed";
                            p.failure = String(r.reason);
                        }
                    if (Object.values(s.sections).every(p => p.status === "accepted"))
                        s.phase = "verify";
                    if (result.some(r => r.status === "rejected"))
                        throw new Error("One or more section workers failed; completed independent sections were preserved");
                    break;
                }
                case "verify": {
                    if (!s.plan || !Object.values(s.sections).every(p => p.status === "accepted"))
                        throw new Error("Cannot verify an incomplete proof");
                    const ids = new Set(s.plan.sections.map(t => t.id));
                    s.verification = await this.runner.run("verify", PROMPTS.verify, { ...this.context(), document: draft(s), localAudits: s.sections }, VerificationSchema, {
                        validate: value => { for (const defect of value.defects) {
                            if (defect.sections.some(id => !ids.has(id)))
                                throw new Error("Verifier localized a defect to an unknown section");
                            if (defect.scope === "section" && !defect.sections.length)
                                throw new Error("Unlocalized section defect");
                        } },
                        intrinsicIssues: value => value.defects,
                        preserveAllObjections: true,
                        inheritedObjections: s.verification?.objections ?? [],
                    });
                    const v = s.verification.value;
                    const central = [...v.defects, ...s.verification.objections].some(d => ["target", "strategy"].includes(d.scope) && d.severity !== "minor");
                    const clean = v.verdict === "accept" && !v.defects.some(d => d.severity !== "minor") && !serious(s.verification.objections);
                    if (clean)
                        s.phase = "awaiting-acceptance";
                    else {
                        archive(s);
                        s.phase = central || v.verdict === "reexplore" ? "explore" : "revise";
                    }
                    await this.curate(start);
                    break;
                }
                case "revise": {
                    if (!s.plan || !s.verification)
                        throw new Error("Missing revision context");
                    const revision = await this.runner.run("revise", PROMPTS.revise, { ...this.context(), document: draft(s) }, RevisionSchema);
                    if (serious(revision.objections))
                        throw new Error("Revision plan has unresolved material objections");
                    const r = revision.value;
                    if (r.action === "reexplore") {
                        s.phase = "explore";
                        break;
                    }
                    const known = new Set(s.plan.sections.map(t => t.id));
                    if (r.affected.some(id => !known.has(id)))
                        throw new Error("Revision references an unknown section");
                    const localized = [...s.verification.value.defects, ...s.verification.objections].flatMap(d => d.sections);
                    const affected = [...new Set([...r.affected, ...localized])];
                    if (!affected.length)
                        affected.push(...known); // Whole-document concern: conservatively invalidate all.
                    const next: ProofPlan = r.action === "outline" ? (r.plan ?? (() => { throw new Error("Missing revised outline"); })()) : s.plan;
                    validatePlan(next, obligationIds(s));
                    s.sections = reviseGraph(s.plan, next, s.sections, affected);
                    s.plan = next;
                    s.phase = r.action === "outline" ? "awaiting-plan" : "solve";
                    break;
                }
            }
        }
        catch (error) {
            s.failure = error instanceof Error ? error.message : String(error);
            throw error;
        }
        finally {
            s.revision++;
            StateSchema.parse(s);
            await this.checkpoint(s);
        }
        return s;
    }
    async run(): Promise<ResearchState> {
        while (!["awaiting-route", "awaiting-plan", "awaiting-acceptance", "accepted", "blocked"].includes(this.state.phase))
            await this.step();
        return this.state;
    }
}
