/**
 * Test helper: reads TypeScript source files with the TypeScript compiler API and exposes their interfaces, type
 * aliases and `as const` string arrays, so schema.test.ts can compare them with the CDDL of the drafts.
 * Sources are passed as text (Vite `?raw` imports in the tests). Test-only: never import this from application code.
 */
import ts from "typescript";

export interface TsMember {
    name: string;
    optional: boolean;
    /** the type annotation as written, whitespace collapsed */
    typeText: string;
    typeNode: ts.TypeNode;
    /** leading comments (JSDoc) of the member */
    comment: string;
}

export interface TsModel {
    /** interface name -> members (in declaration order) */
    interfaces: Map<string, Map<string, TsMember>>;
    /** type alias name -> aliased type */
    aliases: Map<string, ts.TypeNode>;
    /** `export const X = ["a", "b"] as const` -> string elements */
    constArrays: Map<string, string[]>;
}

const collapse = (s: string) => s.replace(/\s+/g, " ").trim();

function unwrapExpression(e: ts.Expression): ts.Expression {
    let cur = e;
    while (ts.isAsExpression(cur) || ts.isSatisfiesExpression(cur) || ts.isParenthesizedExpression(cur)) {
        cur = cur.expression;
    }
    return cur;
}

/** Parses the given sources (no type checking) into one model; names must be unique across the sources. */
export function loadTsModel(sources: Readonly<Record<string, string>>): TsModel {
    const model: TsModel = { interfaces: new Map(), aliases: new Map(), constArrays: new Map() };
    for (const [file, text] of Object.entries(sources)) {
        const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
        for (const stmt of sf.statements) {
            if (ts.isInterfaceDeclaration(stmt)) {
                const members = new Map<string, TsMember>();
                for (const m of stmt.members) {
                    if (!ts.isPropertySignature(m) || !m.type) continue;
                    const name = m.name.getText(sf).replace(/^"(.*)"$/, "$1");
                    const comment = (ts.getLeadingCommentRanges(text, m.getFullStart()) ?? [])
                        .map((r) => text.slice(r.pos, r.end))
                        .join("\n");
                    members.set(name, {
                        name,
                        optional: m.questionToken !== undefined,
                        typeText: collapse(m.type.getText(sf)),
                        typeNode: m.type,
                        comment,
                    });
                }
                model.interfaces.set(stmt.name.text, members);
            } else if (ts.isTypeAliasDeclaration(stmt)) {
                model.aliases.set(stmt.name.text, stmt.type);
            } else if (ts.isVariableStatement(stmt)) {
                for (const decl of stmt.declarationList.declarations) {
                    if (!ts.isIdentifier(decl.name) || !decl.initializer) continue;
                    const init = unwrapExpression(decl.initializer);
                    if (!ts.isArrayLiteralExpression(init)) continue;
                    if (!init.elements.every(ts.isStringLiteral)) continue;
                    model.constArrays.set(
                        decl.name.text,
                        init.elements.map((e) => (e as ts.StringLiteral).text),
                    );
                }
            }
        }
    }
    return model;
}

export interface LiteralSet {
    literals: Set<string>;
    /** the type also admits arbitrary strings (`OpenString`, `string`, `string & {}`) */
    open: boolean;
    /** names of referenced types that are neither aliases of literals nor OpenString (e.g. interfaces) */
    refs: string[];
}

/** The string literals a type admits, resolving local aliases and `(typeof CONST_ARRAY)[number]`. */
export function literalSet(model: TsModel, node: ts.TypeNode, seen = new Set<string>()): LiteralSet {
    const out: LiteralSet = { literals: new Set(), open: false, refs: [] };
    const merge = (o: LiteralSet) => {
        o.literals.forEach((l) => out.literals.add(l));
        out.open ||= o.open;
        out.refs.push(...o.refs);
    };
    if (ts.isUnionTypeNode(node)) {
        node.types.forEach((t) => merge(literalSet(model, t, seen)));
    } else if (ts.isParenthesizedTypeNode(node)) {
        merge(literalSet(model, node.type, seen));
    } else if (ts.isLiteralTypeNode(node) && ts.isStringLiteral(node.literal)) {
        out.literals.add(node.literal.text);
    } else if (node.kind === ts.SyntaxKind.StringKeyword) {
        out.open = true;
    } else if (ts.isIntersectionTypeNode(node)) {
        if (node.types.some((t) => t.kind === ts.SyntaxKind.StringKeyword)) out.open = true;
    } else if (ts.isTypeReferenceNode(node)) {
        const name = node.typeName.getText();
        const alias = model.aliases.get(name);
        if (name === "OpenString") out.open = true;
        else if (alias && !seen.has(name)) merge(literalSet(model, alias, new Set([...seen, name])));
        else out.refs.push(name);
    } else if (
        ts.isIndexedAccessTypeNode(node) &&
        node.indexType.kind === ts.SyntaxKind.NumberKeyword &&
        ts.isTypeQueryNode(ts.isParenthesizedTypeNode(node.objectType) ? node.objectType.type : node.objectType)
    ) {
        const query = (
            ts.isParenthesizedTypeNode(node.objectType) ? node.objectType.type : node.objectType
        ) as ts.TypeQueryNode;
        model.constArrays.get(query.exprName.getText())?.forEach((l) => out.literals.add(l));
    }
    return out;
}

/** The type names a union alias is made of (`type QuicFrame = PaddingFrame | PingFrame | ...`). */
export function unionMemberNames(model: TsModel, alias: string): string[] {
    const node = model.aliases.get(alias);
    if (!node) return [];
    const types: readonly ts.TypeNode[] = ts.isUnionTypeNode(node) ? node.types : [node];
    return types.filter(ts.isTypeReferenceNode).map((t) => t.typeName.getText());
}
