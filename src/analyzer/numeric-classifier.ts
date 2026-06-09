import * as ts from "typescript";

export type InferredNumericKind = "i64" | "usize" | "f64";

export type IntegerSignal =
  | { kind: "literal"; value: number }
  | { kind: "indexUsage" }
  | { kind: "lengthProperty" }
  | { kind: "bitwiseOp" }
  | { kind: "integerMathResult"; fn: string }
  | { kind: "loopCounter" }
  | { kind: "assignedFromInteger"; source: string }
  | { kind: "usedAsInteger"; context: string };

export type FloatSignal =
  | { kind: "floatLiteral"; value: number }
  | { kind: "divisionResult" }
  | { kind: "floatMathResult"; fn: string }
  | { kind: "assignedFromFloat"; source: string };

export type NumericEvidence = {
  integerEvidence: IntegerSignal[];
  floatEvidence: FloatSignal[];
};

const INTEGER_MATH = new Set(["floor", "ceil", "round", "trunc", "parseInt"]);

const FLOAT_MATH = new Set([
  "sqrt",
  "sin",
  "cos",
  "random",
  "pow",
  "log",
  "exp",
]);

const BITWISE_OPS = new Set([
  ts.SyntaxKind.BarToken,
  ts.SyntaxKind.AmpersandToken,
  ts.SyntaxKind.CaretToken,
  ts.SyntaxKind.TildeToken,
  ts.SyntaxKind.LessThanLessThanToken,
  ts.SyntaxKind.GreaterThanGreaterThanToken,
  ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken,
]);

const MAX_PROPAGATION_ITERATIONS = 10;

function emptyEvidence(): NumericEvidence {
  return { integerEvidence: [], floatEvidence: [] };
}

export function isIntegerNumericText(text: string, value: number): boolean {
  if (!Number.isFinite(value)) return false;
  const lower = text.toLowerCase();
  if (lower.includes("e")) {
    const expPart = lower.split("e")[1];
    if (!expPart) return Number.isInteger(value);
    const exp = Number.parseInt(expPart, 10);
    if (exp < 0) return false;
    return Number.isInteger(value);
  }
  if (text.includes(".")) return false;
  return Number.isInteger(value);
}

export function resolveNumericKind(
  evidence: NumericEvidence,
): InferredNumericKind {
  if (evidence.floatEvidence.length > 0) return "f64";

  if (
    evidence.integerEvidence.some(
      (e) => e.kind === "indexUsage" || e.kind === "lengthProperty",
    )
  ) {
    return "usize";
  }

  if (
    evidence.integerEvidence.some(
      (e) =>
        e.kind === "literal" ||
        e.kind === "bitwiseOp" ||
        e.kind === "integerMathResult" ||
        e.kind === "loopCounter",
    )
  ) {
    return "i64";
  }

  if (evidence.integerEvidence.length > 0) return "i64";

  return "f64";
}

function symbolKey(symbol: ts.Symbol): string | null {
  const decl = symbol.valueDeclaration ?? symbol.declarations?.[0];
  if (!decl) return null;
  const sourceFile = decl.getSourceFile();
  return `${sourceFile.fileName}:${symbol.getName()}:${decl.getStart(sourceFile)}`;
}

function returnKey(fnDecl: ts.FunctionLikeDeclaration): string {
  const sourceFile = fnDecl.getSourceFile();
  return `return:${sourceFile.fileName}:${fnDecl.getStart(sourceFile)}`;
}

function functionKey(fnDecl: ts.FunctionLikeDeclaration): string {
  const sourceFile = fnDecl.getSourceFile();
  return `fn:${sourceFile.fileName}:${fnDecl.getStart(sourceFile)}`;
}

const COMPARISON_OPS = new Set([
  ts.SyntaxKind.LessThanToken,
  ts.SyntaxKind.LessThanEqualsToken,
  ts.SyntaxKind.GreaterThanToken,
  ts.SyntaxKind.GreaterThanEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
]);

function mergeEvidence(
  target: NumericEvidence,
  source: NumericEvidence,
): boolean {
  let changed = false;
  const prevInt = target.integerEvidence.length;
  const prevFloat = target.floatEvidence.length;
  target.integerEvidence.push(...source.integerEvidence);
  target.floatEvidence.push(...source.floatEvidence);
  if (
    target.integerEvidence.length !== prevInt ||
    target.floatEvidence.length !== prevFloat
  ) {
    changed = true;
  }
  return changed;
}

function addIntegerSignal(
  evidence: NumericEvidence,
  signal: IntegerSignal,
): boolean {
  const prev = evidence.integerEvidence.length;
  evidence.integerEvidence.push(signal);
  return evidence.integerEvidence.length !== prev;
}

function addFloatSignal(
  evidence: NumericEvidence,
  signal: FloatSignal,
): boolean {
  const prev = evidence.floatEvidence.length;
  evidence.floatEvidence.push(signal);
  return evidence.floatEvidence.length !== prev;
}

function hasExportModifier(node: ts.Node): boolean {
  if (!ts.canHaveModifiers(node)) return false;
  const modifiers = ts.getModifiers(node);
  return !!modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
}

function isNumberTypeNode(node: ts.TypeNode): boolean {
  return node.kind === ts.SyntaxKind.NumberKeyword;
}

export class NumericClassifier {
  private program: ts.Program;
  private checker: ts.TypeChecker;
  private evidence = new Map<string, NumericEvidence>();
  private resolved = new Map<string, InferredNumericKind>();
  private exportedDecls = new Set<ts.FunctionLikeDeclaration>();
  private forcedF64Bindings = new Set<string>();
  private callSiteCounts = new Map<string, number>();
  private exprCache = new Map<ts.Node, InferredNumericKind>();

  constructor(program: ts.Program, checker: ts.TypeChecker) {
    this.program = program;
    this.checker = checker;
  }

  analyze(): void {
    this.collectBindingConstraints();
    this.collectCallSites();
    this.collectEvidence();
    this.propagate();
    this.refineReturnEvidence();
    this.markExportedWithoutCallSites();
    this.resolveAll();
  }

  getBindingNumericKind(symbol: ts.Symbol): InferredNumericKind {
    const key = symbolKey(symbol);
    if (!key) return "f64";
    if (this.forcedF64Bindings.has(key)) return "f64";
    return this.resolved.get(key) ?? "f64";
  }

  isBindingForcedF64(symbol: ts.Symbol): boolean {
    const key = symbolKey(symbol);
    return !!key && this.forcedF64Bindings.has(key);
  }

  getNumericKind(symbol: ts.Symbol): InferredNumericKind {
    return this.getBindingNumericKind(symbol);
  }

  getReturnKind(fnDecl: ts.FunctionLikeDeclaration): InferredNumericKind {
    const key = returnKey(fnDecl);
    if (this.forcedF64Bindings.has(key)) return "f64";
    return this.resolved.get(key) ?? "f64";
  }

  getExpressionKind(node: ts.Expression): InferredNumericKind {
    if (ts.isIdentifier(node)) {
      const sym = this.checker.getSymbolAtLocation(node);
      if (sym) return this.getBindingNumericKind(sym);
    }

    const cached = this.exprCache.get(node);
    if (cached) return cached;

    const evidence = this.inferExpressionEvidence(node);
    const kind = resolveNumericKind(evidence);
    this.exprCache.set(node, kind);
    return kind;
  }

  getLiteralKind(
    node: ts.NumericLiteral,
    contextSymbol?: ts.Symbol,
  ): InferredNumericKind {
    const value = Number.parseFloat(node.text);
    if (!isIntegerNumericText(node.text, value)) return "f64";

    if (contextSymbol) {
      const ctxKind = this.getNumericKind(contextSymbol);
      if (ctxKind !== "f64") return ctxKind;
    }

    return "i64";
  }

  private collectBindingConstraints(): void {
    for (const sourceFile of this.program.getSourceFiles()) {
      if (sourceFile.isDeclarationFile) continue;
      ts.forEachChild(sourceFile, (node) => this.markBindingConstraints(node));
    }
  }

  private markForcedF64Binding(sym: ts.Symbol | undefined): void {
    const key = sym ? symbolKey(sym) : null;
    if (key) this.forcedF64Bindings.add(key);
  }

  private markBindingConstraints(node: ts.Node): void {
    if (
      ts.isFunctionDeclaration(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isConstructorDeclaration(node)
    ) {
      if (hasExportModifier(node)) {
        this.exportedDecls.add(node);
      }
    }

    if (ts.isClassDeclaration(node) && hasExportModifier(node)) {
      for (const member of node.members) {
        if (ts.isMethodDeclaration(member) && hasExportModifier(member)) {
          this.exportedDecls.add(member);
        }
      }
    }

    ts.forEachChild(node, (child) => this.markBindingConstraints(child));
  }

  private collectCallSites(): void {
    for (const sourceFile of this.program.getSourceFiles()) {
      if (sourceFile.isDeclarationFile) continue;
      this.visitCallSites(sourceFile);
    }
  }

  private visitCallSites(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      const sig = this.checker.getResolvedSignature(node);
      const fnDecl = sig?.declaration;
      if (fnDecl && ts.isFunctionLike(fnDecl)) {
        const key = functionKey(fnDecl);
        this.callSiteCounts.set(key, (this.callSiteCounts.get(key) ?? 0) + 1);
      }
    }
    ts.forEachChild(node, (child) => this.visitCallSites(child));
  }

  private markExportedWithoutCallSites(): void {
    for (const fnDecl of this.exportedDecls) {
      const key = functionKey(fnDecl);
      if ((this.callSiteCounts.get(key) ?? 0) > 0) continue;

      for (const param of fnDecl.parameters) {
        const sym = this.checker.getSymbolAtLocation(param.name);
        this.markForcedF64Binding(sym ?? undefined);
      }

      if (fnDecl.type && isNumberTypeNode(fnDecl.type)) {
        this.forcedF64Bindings.add(returnKey(fnDecl));
      }
    }
  }

  private getEvidence(key: string): NumericEvidence {
    let ev = this.evidence.get(key);
    if (!ev) {
      ev = emptyEvidence();
      this.evidence.set(key, ev);
    }
    return ev;
  }

  private collectEvidence(): void {
    for (const sourceFile of this.program.getSourceFiles()) {
      if (sourceFile.isDeclarationFile) continue;
      this.visitNode(sourceFile);
    }
  }

  private visitNode(node: ts.Node): void {
    if (ts.isNumericLiteral(node)) {
      this.classifyLiteral(node);
    }

    if (ts.isBinaryExpression(node)) {
      this.classifyBinary(node);
      if (COMPARISON_OPS.has(node.operatorToken.kind)) {
        this.classifyComparison(node);
      }
    }

    if (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) {
      if (node.operator === ts.SyntaxKind.PlusPlusToken) {
        this.markSymbolFromExpression(node.operand, {
          integerEvidence: [{ kind: "loopCounter" }],
          floatEvidence: [],
        });
      }
      if (node.operator === ts.SyntaxKind.MinusMinusToken) {
        this.markSymbolFromExpression(node.operand, {
          integerEvidence: [{ kind: "loopCounter" }],
          floatEvidence: [],
        });
      }
    }

    if (ts.isCallExpression(node)) {
      this.classifyCall(node);
    }

    if (ts.isPropertyAccessExpression(node) && node.name.text === "length") {
      this.markExpressionEvidence(node, {
        integerEvidence: [{ kind: "lengthProperty" }],
        floatEvidence: [],
      });
    }

    if (ts.isElementAccessExpression(node)) {
      this.classifyIndex(node.argumentExpression);
    }

    if (ts.isForStatement(node)) {
      this.classifyForLoop(node);
    }

    if (ts.isVariableDeclaration(node) && node.initializer) {
      this.classifyAssignment(node.name, node.initializer);
    }

    if (
      ts.isBinaryExpression(node) &&
      this.isAssignment(node.operatorToken.kind)
    ) {
      this.classifyAssignment(node.left, node.right);
    }

    if (ts.isReturnStatement(node) && node.expression) {
      this.classifyReturn(node);
    }

    if (ts.isConditionalExpression(node)) {
      this.classifyTernary(node);
    }

    if (ts.isArrayLiteralExpression(node)) {
      this.classifyArrayLiteral(node);
    }

    if (
      ts.isBindingElement(node) &&
      node.parent &&
      ts.isVariableDeclaration(node.parent.parent) &&
      node.parent.parent.initializer
    ) {
      const init = node.parent.parent.initializer;
      if (ts.isArrayLiteralExpression(init)) {
        const index = node.parent.elements.indexOf(node);
        if (index >= 0 && index < init.elements.length) {
          this.classifyAssignment(node.name, init.elements[index]);
        }
      }
    }

    ts.forEachChild(node, (child) => this.visitNode(child));
  }

  private classifyLiteral(node: ts.NumericLiteral): void {
    const value = Number.parseFloat(node.text);
    if (isIntegerNumericText(node.text, value)) {
      this.markExpressionEvidence(node, {
        integerEvidence: [{ kind: "literal", value }],
        floatEvidence: [],
      });
    } else {
      this.markExpressionEvidence(node, {
        integerEvidence: [],
        floatEvidence: [{ kind: "floatLiteral", value }],
      });
    }
  }

  private classifyBinary(node: ts.BinaryExpression): void {
    if (BITWISE_OPS.has(node.operatorToken.kind)) {
      this.markExpressionEvidence(node, {
        integerEvidence: [{ kind: "bitwiseOp" }],
        floatEvidence: [],
      });
      this.markSymbolFromExpression(node.left, {
        integerEvidence: [{ kind: "bitwiseOp" }],
        floatEvidence: [],
      });
      this.markSymbolFromExpression(node.right, {
        integerEvidence: [{ kind: "bitwiseOp" }],
        floatEvidence: [],
      });
      return;
    }

    if (node.operatorToken.kind === ts.SyntaxKind.SlashToken) {
      this.markExpressionEvidence(node, {
        integerEvidence: [],
        floatEvidence: [{ kind: "divisionResult" }],
      });
    }
  }

  private classifyComparison(node: ts.BinaryExpression): void {
    const intEv: NumericEvidence = {
      integerEvidence: [{ kind: "usedAsInteger", context: "comparison" }],
      floatEvidence: [],
    };
    this.markSymbolFromExpression(node.left, intEv);
    this.markSymbolFromExpression(node.right, intEv);
  }

  private classifyCall(node: ts.CallExpression): void {
    const callee = node.expression;

    if (ts.isPropertyAccessExpression(callee)) {
      const obj = callee.expression;
      const method = callee.name.text;
      if (ts.isIdentifier(obj) && obj.text === "Math") {
        if (INTEGER_MATH.has(method)) {
          this.markExpressionEvidence(node, {
            integerEvidence: [{ kind: "integerMathResult", fn: method }],
            floatEvidence: [],
          });
        } else if (FLOAT_MATH.has(method)) {
          this.markExpressionEvidence(node, {
            integerEvidence: [],
            floatEvidence: [{ kind: "floatMathResult", fn: method }],
          });
        }
      }
    }

    if (ts.isIdentifier(callee) && callee.text === "parseInt") {
      this.markExpressionEvidence(node, {
        integerEvidence: [{ kind: "integerMathResult", fn: "parseInt" }],
        floatEvidence: [],
      });
    }

    const sig = this.checker.getResolvedSignature(node);
    if (!sig?.declaration) return;
  }

  private classifyIndex(indexExpr: ts.Expression): void {
    this.markExpressionEvidence(indexExpr, {
      integerEvidence: [{ kind: "indexUsage" }],
      floatEvidence: [],
    });
    this.markSymbolFromExpression(indexExpr, {
      integerEvidence: [{ kind: "indexUsage" }],
      floatEvidence: [],
    });
  }

  private classifyForLoop(node: ts.ForStatement): void {
    const init = node.initializer;
    if (!init || !ts.isVariableDeclarationList(init)) return;
    if (init.declarations.length !== 1) return;

    const decl = init.declarations[0];
    const sym = this.checker.getSymbolAtLocation(decl.name);
    if (!sym) return;

    const key = symbolKey(sym);
    if (!key) return;

    const ev = this.getEvidence(key);
    addIntegerSignal(ev, { kind: "loopCounter" });

    if (decl.initializer && ts.isNumericLiteral(decl.initializer)) {
      const value = Number.parseFloat(decl.initializer.text);
      if (value === 0) {
        addIntegerSignal(ev, { kind: "indexUsage" });
      }
    }

    const cond = node.condition;
    if (cond && ts.isBinaryExpression(cond)) {
      const boundSym = this.checker.getSymbolAtLocation(cond.right);
      if (boundSym) {
        const boundKey = symbolKey(boundSym);
        if (boundKey && !this.forcedF64Bindings.has(boundKey)) {
          const boundEv = this.getEvidence(boundKey);
          addIntegerSignal(boundEv, {
            kind: "usedAsInteger",
            context: "loopBound",
          });
        }
      }
    }
  }

  private classifyAssignment(
    target: ts.BindingName,
    value: ts.Expression,
  ): void {
    const valueEvidence = this.inferExpressionEvidence(value);
    const valueKind = resolveNumericKind(valueEvidence);

    const applyToTarget = (name: ts.BindingName) => {
      const sym = this.checker.getSymbolAtLocation(name);
      if (!sym) return;
      const key = symbolKey(sym);
      if (!key || this.forcedF64Bindings.has(key)) return;

      const ev = this.getEvidence(key);
      if (valueKind === "f64") {
        addFloatSignal(ev, {
          kind: "assignedFromFloat",
          source: value.getText(),
        });
      } else {
        addIntegerSignal(ev, {
          kind: "assignedFromInteger",
          source: value.getText(),
        });
        if (valueKind === "usize") {
          addIntegerSignal(ev, { kind: "indexUsage" });
        }
      }
      mergeEvidence(ev, valueEvidence);
    };

    if (ts.isIdentifier(target)) {
      applyToTarget(target);
    } else if (ts.isArrayBindingPattern(target)) {
      if (ts.isArrayLiteralExpression(value)) {
        for (let i = 0; i < target.elements.length; i++) {
          const elem = target.elements[i];
          if (ts.isBindingElement(elem) && i < value.elements.length) {
            applyToTarget(elem.name);
          }
        }
      }
    }
  }

  private classifyReturn(node: ts.ReturnStatement): void {
    if (!node.expression) return;
    const fn = this.findEnclosingFunction(node);
    if (!fn) return;

    const key = returnKey(fn);
    const valueEvidence = this.inferExpressionEvidence(node.expression);
    mergeEvidence(this.getEvidence(key), valueEvidence);
  }

  /** Re-merge return expressions after call-site propagation has filled param evidence. */
  private refineReturnEvidence(): void {
    for (const sourceFile of this.program.getSourceFiles()) {
      if (sourceFile.isDeclarationFile) continue;
      this.visitReturnStatements(sourceFile);
    }
  }

  private visitReturnStatements(node: ts.Node): void {
    if (ts.isReturnStatement(node) && node.expression) {
      this.classifyReturn(node);
    }
    ts.forEachChild(node, (child) => this.visitReturnStatements(child));
  }

  private classifyTernary(node: ts.ConditionalExpression): void {
    const trueEv = this.inferExpressionEvidence(node.whenTrue);
    const falseEv = this.inferExpressionEvidence(node.whenFalse);
    const merged = emptyEvidence();
    mergeEvidence(merged, trueEv);
    mergeEvidence(merged, falseEv);
    this.markExpressionEvidence(node, merged);
  }

  private classifyArrayLiteral(node: ts.ArrayLiteralExpression): void {
    for (const elem of node.elements) {
      if (ts.isSpreadElement(elem)) continue;
      const elemEv = this.inferExpressionEvidence(elem);
      if (elemEv.floatEvidence.length > 0) {
        this.markExpressionEvidence(node, elemEv);
        return;
      }
    }
    if (node.elements.length > 0) {
      this.markExpressionEvidence(node, {
        integerEvidence: [{ kind: "literal", value: 0 }],
        floatEvidence: [],
      });
    }
  }

  private inferExpressionEvidence(node: ts.Expression): NumericEvidence {
    const cached = this.exprCache.get(node);
    if (cached) {
      if (cached === "f64") {
        return {
          integerEvidence: [],
          floatEvidence: [{ kind: "divisionResult" }],
        };
      }
      if (cached === "usize") {
        return {
          integerEvidence: [{ kind: "indexUsage" }],
          floatEvidence: [],
        };
      }
      return {
        integerEvidence: [{ kind: "literal", value: 0 }],
        floatEvidence: [],
      };
    }

    if (ts.isNumericLiteral(node)) {
      const value = Number.parseFloat(node.text);
      if (isIntegerNumericText(node.text, value)) {
        return {
          integerEvidence: [{ kind: "literal", value }],
          floatEvidence: [],
        };
      }
      return {
        integerEvidence: [],
        floatEvidence: [{ kind: "floatLiteral", value }],
      };
    }

    if (ts.isIdentifier(node)) {
      const sym = this.checker.getSymbolAtLocation(node);
      if (sym) {
        const key = symbolKey(sym);
        if (key && this.resolved.has(key)) {
          const kind = this.resolved.get(key)!;
          if (kind === "f64") {
            return {
              integerEvidence: [],
              floatEvidence: [{ kind: "assignedFromFloat", source: "binding" }],
            };
          }
          if (kind === "usize") {
            return {
              integerEvidence: [{ kind: "indexUsage" }],
              floatEvidence: [],
            };
          }
          return {
            integerEvidence: [{ kind: "literal", value: 0 }],
            floatEvidence: [],
          };
        }
        if (key && this.evidence.has(key)) {
          const ev = this.evidence.get(key)!;
          return {
            integerEvidence: [...ev.integerEvidence],
            floatEvidence: [...ev.floatEvidence],
          };
        }
      }
      return emptyEvidence();
    }

    if (ts.isBinaryExpression(node)) {
      if (BITWISE_OPS.has(node.operatorToken.kind)) {
        return { integerEvidence: [{ kind: "bitwiseOp" }], floatEvidence: [] };
      }
      if (node.operatorToken.kind === ts.SyntaxKind.SlashToken) {
        return {
          integerEvidence: [],
          floatEvidence: [{ kind: "divisionResult" }],
        };
      }
      const leftEv = this.inferExpressionEvidence(node.left);
      const rightEv = this.inferExpressionEvidence(node.right);
      const leftKind = resolveNumericKind(leftEv);
      const rightKind = resolveNumericKind(rightEv);
      if (leftKind !== "f64" && rightKind !== "f64") {
        const merged = emptyEvidence();
        mergeEvidence(merged, leftEv);
        mergeEvidence(merged, rightEv);
        addIntegerSignal(merged, {
          kind: "usedAsInteger",
          context: "arithmetic",
        });
        return merged;
      }
      const merged = emptyEvidence();
      mergeEvidence(merged, leftEv);
      mergeEvidence(merged, rightEv);
      return merged;
    }

    if (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) {
      return this.inferExpressionEvidence(node.operand);
    }

    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isPropertyAccessExpression(callee)) {
        const obj = callee.expression;
        const method = callee.name.text;
        if (ts.isIdentifier(obj) && obj.text === "Math") {
          if (INTEGER_MATH.has(method)) {
            return {
              integerEvidence: [{ kind: "integerMathResult", fn: method }],
              floatEvidence: [],
            };
          }
          if (FLOAT_MATH.has(method)) {
            return {
              integerEvidence: [],
              floatEvidence: [{ kind: "floatMathResult", fn: method }],
            };
          }
        }
      }
      if (ts.isIdentifier(callee) && callee.text === "parseInt") {
        return {
          integerEvidence: [{ kind: "integerMathResult", fn: "parseInt" }],
          floatEvidence: [],
        };
      }

      const fnDecl = this.checker.getResolvedSignature(node)?.declaration;
      if (fnDecl && ts.isFunctionLike(fnDecl)) {
        const retKey = returnKey(fnDecl);
        if (this.resolved.has(retKey)) {
          const kind = this.resolved.get(retKey)!;
          if (kind === "f64") {
            return {
              integerEvidence: [],
              floatEvidence: [{ kind: "assignedFromFloat", source: "call" }],
            };
          }
          if (kind === "usize") {
            return {
              integerEvidence: [{ kind: "indexUsage" }],
              floatEvidence: [],
            };
          }
          return {
            integerEvidence: [{ kind: "literal", value: 0 }],
            floatEvidence: [],
          };
        }
        if (this.evidence.has(retKey)) {
          const ev = this.evidence.get(retKey)!;
          return {
            integerEvidence: [...ev.integerEvidence],
            floatEvidence: [...ev.floatEvidence],
          };
        }
      }
    }

    if (ts.isPropertyAccessExpression(node) && node.name.text === "length") {
      return {
        integerEvidence: [{ kind: "lengthProperty" }],
        floatEvidence: [],
      };
    }

    if (ts.isConditionalExpression(node)) {
      const merged = emptyEvidence();
      mergeEvidence(merged, this.inferExpressionEvidence(node.whenTrue));
      mergeEvidence(merged, this.inferExpressionEvidence(node.whenFalse));
      return merged;
    }

    if (ts.isParenthesizedExpression(node)) {
      return this.inferExpressionEvidence(node.expression);
    }

    if (ts.isArrayLiteralExpression(node)) {
      for (const elem of node.elements) {
        if (ts.isSpreadElement(elem)) continue;
        const elemEv = this.inferExpressionEvidence(elem);
        if (elemEv.floatEvidence.length > 0) return elemEv;
      }
      if (node.elements.length > 0) {
        return {
          integerEvidence: [{ kind: "literal", value: 0 }],
          floatEvidence: [],
        };
      }
    }

    return emptyEvidence();
  }

  private markExpressionEvidence(
    node: ts.Expression,
    ev: NumericEvidence,
  ): void {
    const kind = resolveNumericKind(ev);
    this.exprCache.set(node, kind);
  }

  private markSymbolFromExpression(
    node: ts.Expression,
    ev: NumericEvidence,
  ): void {
    if (ts.isIdentifier(node)) {
      const sym = this.checker.getSymbolAtLocation(node);
      if (!sym) return;
      const key = symbolKey(sym);
      if (!key || this.forcedF64Bindings.has(key)) return;
      mergeEvidence(this.getEvidence(key), ev);
    }
  }

  private propagate(): void {
    for (let i = 0; i < MAX_PROPAGATION_ITERATIONS; i++) {
      let changed = false;

      for (const sourceFile of this.program.getSourceFiles()) {
        if (sourceFile.isDeclarationFile) continue;
        changed = this.propagateInFile(sourceFile) || changed;
      }

      if (!changed) break;
    }
  }

  private propagateInFile(sourceFile: ts.SourceFile): boolean {
    let changed = false;

    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        changed = this.propagateCall(node) || changed;
      }
      ts.forEachChild(node, visit);
    };

    visit(sourceFile);
    return changed;
  }

  private propagateCall(node: ts.CallExpression): boolean {
    let changed = false;
    const sig = this.checker.getResolvedSignature(node);
    if (!sig?.declaration || !ts.isFunctionLike(sig.declaration)) {
      return false;
    }

    const fnDecl = sig.declaration;
    const retKey = returnKey(fnDecl);
    const retEv = this.getEvidence(retKey);

    for (let i = 0; i < node.arguments.length; i++) {
      const arg = node.arguments[i];
      const param = sig.parameters[i];
      if (!param) continue;

      const paramSym = param.valueDeclaration
        ? this.checker.getSymbolAtLocation(
            (param.valueDeclaration as ts.ParameterDeclaration).name,
          )
        : undefined;
      const paramKey = paramSym ? symbolKey(paramSym) : null;
      if (!paramKey || this.forcedF64Bindings.has(paramKey)) continue;

      const argEv = this.inferExpressionEvidence(arg);
      const paramEv = this.getEvidence(paramKey);
      if (mergeEvidence(paramEv, argEv)) changed = true;
    }

    const callSiteEv = emptyEvidence();
    mergeEvidence(callSiteEv, retEv);
    const callKind = resolveNumericKind(callSiteEv);

    if (
      ts.isVariableDeclaration(node.parent) &&
      node.parent.initializer === node
    ) {
      const sym = this.checker.getSymbolAtLocation(node.parent.name);
      const key = sym ? symbolKey(sym) : null;
      if (key && !this.forcedF64Bindings.has(key)) {
        const ev = this.getEvidence(key);
        if (callKind === "f64") {
          if (
            addFloatSignal(ev, { kind: "assignedFromFloat", source: "call" })
          ) {
            changed = true;
          }
        } else {
          if (
            addIntegerSignal(ev, {
              kind: "assignedFromInteger",
              source: "call",
            })
          ) {
            changed = true;
          }
        }
        if (mergeEvidence(ev, retEv)) changed = true;
      }
    }

    if (ts.isReturnStatement(node.parent) && node.parent.expression === node) {
      if (mergeEvidence(retEv, this.inferExpressionEvidence(node))) {
        changed = true;
      }
    }

    return changed;
  }

  private resolveAll(): void {
    for (const [key, ev] of this.evidence) {
      this.resolved.set(key, resolveNumericKind(ev));
    }

    for (const key of this.forcedF64Bindings) {
      this.resolved.set(key, "f64");
    }

    this.exprCache.clear();
    for (const sourceFile of this.program.getSourceFiles()) {
      if (sourceFile.isDeclarationFile) continue;
      this.cacheExpressions(sourceFile);
    }
  }

  private cacheExpressions(node: ts.Node): void {
    if (ts.isExpression(node)) {
      this.exprCache.set(node, this.getExpressionKind(node));
    }
    ts.forEachChild(node, (child) => this.cacheExpressions(child));
  }

  private findEnclosingFunction(
    node: ts.Node,
  ): ts.FunctionLikeDeclaration | null {
    let current: ts.Node | undefined = node.parent;
    while (current) {
      if (
        ts.isFunctionDeclaration(current) ||
        ts.isMethodDeclaration(current) ||
        ts.isArrowFunction(current) ||
        ts.isFunctionExpression(current) ||
        ts.isConstructorDeclaration(current)
      ) {
        return current;
      }
      current = current.parent;
    }
    return null;
  }

  private isAssignment(kind: ts.SyntaxKind): boolean {
    return (
      kind === ts.SyntaxKind.EqualsToken ||
      kind === ts.SyntaxKind.PlusEqualsToken ||
      kind === ts.SyntaxKind.MinusEqualsToken ||
      kind === ts.SyntaxKind.AsteriskEqualsToken ||
      kind === ts.SyntaxKind.SlashEqualsToken ||
      kind === ts.SyntaxKind.PercentEqualsToken
    );
  }
}
