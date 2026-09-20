import { linear } from "./certificate.ts";
import { type Expr } from "./expressions.ts";

export interface ConceptFlags {
    chi: boolean;
    b1: boolean;
}

type Form = ReadonlyMap<string, bigint>;
const CHI = new Map<string, bigint>([["V", 1n], ["E", -1n], ["F", 1n]]);
const B1 = new Map<string, bigint>([["n1", 1n], ["r2", -1n]]);

/** Match a nonzero rational multiple while ignoring an additive constant. */
function proportional(actual: Form, target: Form): boolean {
    const keys = new Set([...actual.keys(), ...target.keys()]);
    keys.delete("");
    const pivot = [...target].find(([key, coefficient]) => key !== "" && coefficient !== 0n);
    if (!pivot)
        return false;
    const [pivotKey, pivotTarget] = pivot;
    const pivotActual = actual.get(pivotKey) ?? 0n;
    if (pivotActual === 0n)
        return false;
    for (const key of keys)
        if ((actual.get(key) ?? 0n) * pivotTarget !== (target.get(key) ?? 0n) * pivotActual)
            return false;
    return true;
}

function arithmeticSubexpressions(expr: Expr): Expr[] {
    if (expr.kind === "int" || expr.kind === "var")
        return [expr];
    if (expr.kind === "not")
        return arithmeticSubexpressions(expr.arg);
    return [expr, ...arithmeticSubexpressions(expr.left), ...arithmeticSubexpressions(expr.right)];
}

/** Paper-aligned weak concept metric: an arithmetic subexpression contains χ or b₁. */
export function conceptFlags(expr: Expr): ConceptFlags {
    let chi = false, b1 = false;
    for (const part of arithmeticSubexpressions(expr)) {
        const form = linear(part);
        if (!form)
            continue;
        chi ||= proportional(form, CHI);
        b1 ||= proportional(form, B1);
    }
    return { chi, b1 };
}
