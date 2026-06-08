import * as ts from "typescript";
import type { TransformContext } from "../index";
import { blockAllocates, bodyMutatesThis } from "../../analyzer/allocation";
import { resolveType, resolveTypeFromNode } from "../../analyzer/type-resolver";
import { transformExpression } from "./expressions";
import { replaceGenericTypes } from "./functions";
import { transformStatement } from "./statements";
import type {
  IRStruct,
  IRField,
  IRFunction,
  IRParam,
  IRNode,
  IRType,
} from "../../types";

export function transformClass(
  node: ts.ClassDeclaration,
  ctx: TransformContext,
): IRStruct | null {
  const name = node.name?.text ?? "AnonymousClass";
  const info = ctx.classRegistry.get(name);

  const prevClass = ctx.currentClass;
  ctx.currentClass = name;

  const typeParamNames = new Set<string>();
  if (node.typeParameters) {
    for (const tp of node.typeParameters) typeParamNames.add(tp.name.text);
  }

  const baseTypeArgs = extractBaseTypeArgs(node, ctx);
  const baseTypeSubstMap = info?.baseClass
    ? buildBaseTypeSubstitution(ctx, info.baseClass, baseTypeArgs)
    : new Map<string, IRType>();

  const inheritedFields: IRField[] = [];
  if (info?.baseClass) {
    const chain = ctx.classRegistry.ancestry(info.baseClass).reverse();
    for (const ancestor of chain) {
      const ancestorTypeParams = typeParamsOfClass(ancestor.node);
      for (const member of ancestor.node.members) {
        if (ts.isPropertyDeclaration(member)) {
          const f = buildFieldFromProperty(member, ctx, ancestorTypeParams);
          if (f) inheritedFields.push(f);
        }
      }
      for (const member of ancestor.node.members) {
        if (ts.isConstructorDeclaration(member)) {
          for (const param of member.parameters) {
            const mods = ts.getModifiers(param);
            if (
              mods?.some(
                (m) =>
                  m.kind === ts.SyntaxKind.PublicKeyword ||
                  m.kind === ts.SyntaxKind.PrivateKeyword ||
                  m.kind === ts.SyntaxKind.ProtectedKeyword ||
                  m.kind === ts.SyntaxKind.ReadonlyKeyword,
              )
            ) {
              const pname = param.name.getText(ctx.sourceFile);
              if (!inheritedFields.find((x) => x.name === pname)) {
                let ptype = param.type
                  ? resolveTypeFromNode(param.type, ctx.checker, ctx.sourceFile)
                  : resolveType(
                      ctx.checker.getTypeAtLocation(param),
                      ctx.checker,
                    );
                ptype = replaceGenericTypes(ptype, ancestorTypeParams);
                inheritedFields.push({
                  name: pname,
                  type: ptype,
                  isPublic: true,
                  isOptional: false,
                });
              }
            }
          }
        }
      }
    }
  }

  const ownFields: IRField[] = [];
  for (const member of node.members) {
    if (ts.isPropertyDeclaration(member)) {
      const f = buildFieldFromProperty(member, ctx, typeParamNames);
      if (f) {
        const shadowIdx = inheritedFields.findIndex((x) => x.name === f.name);
        if (shadowIdx >= 0) inheritedFields.splice(shadowIdx, 1);
        ownFields.push(f);
      }
    }
  }

  const methods: IRFunction[] = [];
  let hasExplicitConstructor = false;

  const rootName = info ? ctx.classRegistry.rootOf(name) : name;
  const virtualSet = new Set(
    info ? ctx.classRegistry.virtualMethodsForRoot(rootName) : [],
  );

  for (const member of node.members) {
    if (ts.isConstructorDeclaration(member)) {
      hasExplicitConstructor = true;
      methods.push(
        buildConstructor(node, member, ownFields, ctx, name, typeParamNames),
      );
    }

    if (ts.isMethodDeclaration(member)) {
      const m = buildMethod(member, ctx, typeParamNames, name);
      if (m) {
        m.isVirtual = virtualSet.has(m.name);
        if (m.isVirtual) {
          const eff = ctx.classRegistry.methodEffects(name, m.name);
          (m as any).hierAllocates = eff.allocates;
          (m as any).hierThrows = eff.throws;
          m.needsAllocator = eff.allocates;
        }
        methods.push(m);
      }
    }
  }

  if (!hasExplicitConstructor) {
    methods.unshift(
      buildImplicitInit(name, info?.baseClass ?? null, ctx, typeParamNames),
    );
  }

  if (info?.baseClass) {
    const ownMethodNames = new Set(methods.map((m) => m.name));
    for (const ancestor of ctx.classRegistry.ancestry(info.baseClass)) {
      for (const member of ancestor.node.members) {
        if (!ts.isMethodDeclaration(member)) continue;
        const mname = member.name.getText(ctx.sourceFile);
        if (ownMethodNames.has(mname)) continue;
        if (ancestor.abstractMethods.has(mname)) continue;
        const ancestorTypeParams = typeParamsOfClass(ancestor.node);
        const m = buildMethod(member, ctx, ancestorTypeParams, ancestor.name);
        if (m) {
          m.isVirtual = virtualSet.has(m.name);
          (m as any).isInherited = true;
          const eff = ctx.classRegistry.methodEffects(name, m.name);
          (m as any).hierAllocates = eff.allocates;
          (m as any).hierThrows = eff.throws;
          m.needsAllocator = eff.allocates;
          ownMethodNames.add(mname);
          methods.push(m);
        }
      }
    }
  }

  for (const m of methods) {
    if (
      !m.isVirtual &&
      m.needsAllocator &&
      m.returnType.kind !== "errorUnion"
    ) {
      m.returnType = { kind: "errorUnion", okType: m.returnType };
    }
  }

  if (baseTypeSubstMap.size > 0) {
    applySubstitutionToFields(inheritedFields, baseTypeSubstMap);
    applySubstitutionToFields(ownFields, baseTypeSubstMap);
    applySubstitutionToMethods(methods, baseTypeSubstMap);
  }

  const baseTypeSubst =
    baseTypeSubstMap.size > 0
      ? Object.fromEntries(
          [...baseTypeSubstMap.entries()].map(([k, v]) => [
            k,
            irTypeToZigTypeArg(v),
          ]),
        )
      : undefined;

  const baseInstantiatedType =
    info?.baseClass && baseTypeArgs.length > 0
      ? `${info.baseClass}(${baseTypeArgs.map(irTypeToZigTypeArg).join(", ")})`
      : undefined;

  ctx.currentClass = prevClass;

  return {
    kind: "struct",
    name,
    fields: ownFields,
    inheritedFields,
    methods,
    isPublic: ctx.exports.has(name),
    hasInit: true,
    typeParameters:
      typeParamNames.size > 0 ? Array.from(typeParamNames) : undefined,
    baseClass: info?.baseClass ?? undefined,
    baseInstantiatedType,
    baseTypeSubst,
    isAbstract: info?.isAbstract,
    virtualMethods: Array.from(virtualSet),
    ownMethodNames: Array.from(
      new Set(
        methods.filter((m) => !(m as any).isInherited).map((m) => m.name),
      ),
    ),
  };
}

function typeParamsOfClass(node: ts.ClassDeclaration): Set<string> {
  const names = new Set<string>();
  if (node.typeParameters) {
    for (const tp of node.typeParameters) names.add(tp.name.text);
  }
  return names;
}

function extractBaseTypeArgs(
  node: ts.ClassDeclaration,
  ctx: TransformContext,
): IRType[] {
  if (!node.heritageClauses) return [];
  for (const clause of node.heritageClauses) {
    if (clause.token !== ts.SyntaxKind.ExtendsKeyword) continue;
    const heritage = clause.types[0];
    if (!heritage?.typeArguments) return [];
    return heritage.typeArguments.map((ta) =>
      resolveTypeFromNode(ta, ctx.checker, ctx.sourceFile),
    );
  }
  return [];
}

function buildBaseTypeSubstitution(
  ctx: TransformContext,
  baseClass: string,
  baseTypeArgs: IRType[],
): Map<string, IRType> {
  const subst = new Map<string, IRType>();
  const baseInfo = ctx.classRegistry.get(baseClass);
  if (!baseInfo?.node.typeParameters || baseTypeArgs.length === 0) {
    return subst;
  }
  for (let i = 0; i < baseInfo.node.typeParameters.length; i++) {
    const tpName = baseInfo.node.typeParameters[i].name.text;
    if (baseTypeArgs[i]) subst.set(tpName, baseTypeArgs[i]);
  }
  return subst;
}

function applyTypeSubstitution(
  type: IRType,
  subst: Map<string, IRType>,
): IRType {
  if (
    (type.kind === "generic" || type.kind === "struct") &&
    subst.has(type.name)
  ) {
    return subst.get(type.name)!;
  }
  switch (type.kind) {
    case "array":
      return {
        kind: "array",
        elementType: applyTypeSubstitution(type.elementType, subst),
      };
    case "optional":
      return {
        kind: "optional",
        inner: applyTypeSubstitution(type.inner, subst),
      };
    case "errorUnion":
      return {
        kind: "errorUnion",
        okType: applyTypeSubstitution(type.okType, subst),
        errorSet: type.errorSet,
      };
    case "pointer":
      return {
        kind: "pointer",
        inner: applyTypeSubstitution(type.inner, subst),
        isConst: type.isConst,
      };
    case "slice":
      return {
        kind: "slice",
        elementType: applyTypeSubstitution(type.elementType, subst),
        isConst: type.isConst,
      };
    case "function":
      return {
        kind: "function",
        params: type.params.map((p) => applyTypeSubstitution(p, subst)),
        returnType: applyTypeSubstitution(type.returnType, subst),
      };
    case "tuple":
      return {
        kind: "tuple",
        elements: type.elements.map((e) => applyTypeSubstitution(e, subst)),
      };
    default:
      return type;
  }
}

function applySubstitutionToFields(
  fields: IRField[],
  subst: Map<string, IRType>,
): void {
  for (const f of fields) {
    f.type = applyTypeSubstitution(f.type, subst);
  }
}

function applySubstitutionToMethods(
  methods: IRFunction[],
  subst: Map<string, IRType>,
): void {
  for (const m of methods) {
    m.params = m.params.map((p) => ({
      ...p,
      type: applyTypeSubstitution(p.type, subst),
    }));
    m.returnType = applyTypeSubstitution(m.returnType, subst);
  }
}

function irTypeToZigTypeArg(type: IRType): string {
  switch (type.kind) {
    case "primitive":
      return type.name;
    case "string":
      return "[]const u8";
    case "struct":
    case "enum":
      return type.name;
    default:
      return "anytype";
  }
}

function buildFieldFromProperty(
  member: ts.PropertyDeclaration,
  ctx: TransformContext,
  typeParamNames: Set<string>,
): IRField | null {
  const fieldName = member.name.getText(ctx.sourceFile);
  let fieldType: IRType = member.type
    ? resolveTypeFromNode(member.type, ctx.checker, ctx.sourceFile)
    : resolveType(ctx.checker.getTypeAtLocation(member), ctx.checker);

  const isOptional = !!member.questionToken;
  let defaultValue: IRNode | undefined;
  if (member.initializer) {
    if (
      ts.isArrayLiteralExpression(member.initializer) &&
      member.initializer.elements.length === 0
    ) {
      defaultValue = { kind: "emptyArrayInit" } as any;
    } else {
      defaultValue = transformExpression(member.initializer, ctx);
    }
  }

  if (typeParamNames.size > 0) {
    fieldType = replaceGenericTypes(fieldType, typeParamNames);
  }

  return {
    name: fieldName,
    type: isOptional ? { kind: "optional", inner: fieldType } : fieldType,
    defaultValue,
    isPublic: true,
    isOptional,
  };
}

function findNearestConstructor(
  ctx: TransformContext,
  fromClass: string,
): ts.ConstructorDeclaration | null {
  let cur: string | null = fromClass;
  while (cur) {
    const ancestor = ctx.classRegistry.get(cur);
    if (!ancestor) break;
    for (const member of ancestor.node.members) {
      if (ts.isConstructorDeclaration(member)) return member;
    }
    cur = ancestor.baseClass;
  }
  return null;
}

function buildConstructorParams(
  member: ts.ConstructorDeclaration,
  ctx: TransformContext,
  typeParamNames: Set<string>,
): IRParam[] {
  const params: IRParam[] = [];
  for (const param of member.parameters) {
    const paramName = param.name.getText(ctx.sourceFile);
    let paramType: IRType = param.type
      ? resolveTypeFromNode(param.type, ctx.checker, ctx.sourceFile)
      : resolveType(ctx.checker.getTypeAtLocation(param), ctx.checker);
    if (typeParamNames.size > 0) {
      paramType = replaceGenericTypes(paramType, typeParamNames);
    }
    params.push({
      name: paramName,
      type: paramType,
      isOptional: !!param.questionToken,
    });
  }
  return params;
}

function resolveSuperConstructorChain(
  ctx: TransformContext,
  directBase: string,
  superCallArgs: IRNode[],
  existing: Map<string, IRNode>,
): {
  superCallArgs?: IRNode[];
  superInitTarget?: string;
  initAssignments: Map<string, IRNode>;
} {
  const assignments = new Map(existing);
  let cur: string | null = directBase;
  const args = superCallArgs;

  while (cur) {
    const info = ctx.classRegistry.get(cur);
    if (!info) break;

    const ctor = findNearestConstructor(ctx, cur);
    if (ctor) {
      for (const [k, v] of Object.entries(
        collectConstructorInitAssignments(ctor, ctx),
      )) {
        if (!assignments.has(k)) assignments.set(k, v);
      }
    }

    if (!info.isAbstract) {
      return {
        superCallArgs: args,
        superInitTarget: cur,
        initAssignments: assignments,
      };
    }

    cur = info.baseClass;
  }

  return { initAssignments: assignments };
}

function collectConstructorInitAssignments(
  member: ts.ConstructorDeclaration,
  ctx: TransformContext,
): Record<string, IRNode> {
  const initAssignments: Record<string, IRNode> = {};
  if (!member.body) return initAssignments;
  for (const stmt of member.body.statements) {
    if (
      ts.isExpressionStatement(stmt) &&
      ts.isCallExpression(stmt.expression) &&
      stmt.expression.expression.kind === ts.SyntaxKind.SuperKeyword
    ) {
      continue;
    }
    const thisAssignment = extractThisAssignment(stmt, ctx);
    if (thisAssignment) {
      initAssignments[thisAssignment.field] = thisAssignment.value;
    }
  }
  return initAssignments;
}

function buildImplicitInit(
  className: string,
  baseClass: string | null,
  ctx: TransformContext,
  typeParamNames: Set<string>,
): IRFunction & {
  initAssignments?: Record<string, IRNode>;
  superCallArgs?: IRNode[];
} {
  const init: IRFunction & {
    initAssignments?: Record<string, IRNode>;
    superCallArgs?: IRNode[];
  } = {
    kind: "function",
    name: "init",
    params: [],
    returnType: { kind: "struct", name: className },
    body: [],
    isPublic: true,
    isMethod: true,
    isStatic: true,
    needsAllocator: false,
    isMain: false,
    ownerClass: className,
  };

  if (!baseClass) return init;

  const baseCtor = findNearestConstructor(ctx, baseClass);
  if (!baseCtor) return init;

  init.params = buildConstructorParams(baseCtor, ctx, typeParamNames);

  const forwardArgs = init.params.map((p) => ({
    kind: "identifier" as const,
    name: p.name,
    type: p.type,
  }));
  const resolved = resolveSuperConstructorChain(
    ctx,
    baseClass,
    forwardArgs,
    new Map(),
  );
  if (resolved.superInitTarget) {
    init.superCallArgs = resolved.superCallArgs;
    (init as any).superInitTarget = resolved.superInitTarget;
  }
  if (resolved.initAssignments.size > 0) {
    init.initAssignments = Object.fromEntries(resolved.initAssignments);
  }

  return init;
}

function buildConstructor(
  classNode: ts.ClassDeclaration,
  member: ts.ConstructorDeclaration,
  ownFields: IRField[],
  ctx: TransformContext,
  className: string,
  typeParamNames: Set<string>,
): IRFunction {
  const params = buildConstructorParams(member, ctx, typeParamNames);

  for (const param of member.parameters) {
    const paramName = param.name.getText(ctx.sourceFile);
    let paramType = param.type
      ? resolveTypeFromNode(param.type, ctx.checker, ctx.sourceFile)
      : resolveType(ctx.checker.getTypeAtLocation(param), ctx.checker);
    if (typeParamNames.size > 0) {
      paramType = replaceGenericTypes(paramType, typeParamNames);
    }

    const modifiers = ts.getModifiers(param);
    if (
      modifiers?.some(
        (m) =>
          m.kind === ts.SyntaxKind.PublicKeyword ||
          m.kind === ts.SyntaxKind.PrivateKeyword ||
          m.kind === ts.SyntaxKind.ProtectedKeyword ||
          m.kind === ts.SyntaxKind.ReadonlyKeyword,
      )
    ) {
      const existing = ownFields.find((f) => f.name === paramName);
      if (!existing) {
        ownFields.push({
          name: paramName,
          type: paramType,
          isPublic: true,
          isOptional: false,
        });
      }
    }
  }

  const initAssignments = new Map<string, IRNode>();
  const otherStatements: IRNode[] = [];
  let superCallArgs: IRNode[] | undefined;

  if (member.body) {
    for (const stmt of member.body.statements) {
      if (
        ts.isExpressionStatement(stmt) &&
        ts.isCallExpression(stmt.expression) &&
        stmt.expression.expression.kind === ts.SyntaxKind.SuperKeyword
      ) {
        superCallArgs = stmt.expression.arguments.map((a) =>
          transformExpression(a, ctx),
        );
        continue;
      }
      const thisAssignment = extractThisAssignment(stmt, ctx);
      if (thisAssignment) {
        initAssignments.set(thisAssignment.field, thisAssignment.value);
      } else {
        const r = transformStatement(stmt, ctx);
        if (r) otherStatements.push(r);
      }
    }
  }

  let resolvedSuperInitTarget: string | undefined;
  let resolvedSuperCallArgs = superCallArgs;
  const info = ctx.classRegistry.get(className);
  if (superCallArgs && info?.baseClass) {
    const resolved = resolveSuperConstructorChain(
      ctx,
      info.baseClass,
      superCallArgs,
      initAssignments,
    );
    for (const [k, v] of resolved.initAssignments) {
      initAssignments.set(k, v);
    }
    resolvedSuperCallArgs = resolved.superCallArgs;
    resolvedSuperInitTarget = resolved.superInitTarget;
  }

  return {
    kind: "function",
    name: "init",
    params,
    returnType: { kind: "struct", name: className },
    body: otherStatements,
    isPublic: true,
    isMethod: true,
    isStatic: true,
    needsAllocator: false,
    isMain: false,
    ownerClass: className,
    initAssignments: Object.fromEntries(initAssignments),
    superCallArgs: resolvedSuperCallArgs,
    superInitTarget: resolvedSuperInitTarget,
  } as IRFunction & {
    initAssignments: Record<string, IRNode>;
    superCallArgs?: IRNode[];
    superInitTarget?: string;
  };
}

function buildMethod(
  member: ts.MethodDeclaration,
  ctx: TransformContext,
  typeParamNames: Set<string>,
  ownerClass: string,
): IRFunction | null {
  const methodName = member.name.getText(ctx.sourceFile);
  const params: IRParam[] = [];

  for (const param of member.parameters) {
    const paramName = param.name.getText(ctx.sourceFile);
    let paramType: IRType = param.type
      ? resolveTypeFromNode(param.type, ctx.checker, ctx.sourceFile)
      : resolveType(ctx.checker.getTypeAtLocation(param), ctx.checker);
    if (typeParamNames.size > 0) {
      paramType = replaceGenericTypes(paramType, typeParamNames);
    }
    params.push({
      name: paramName,
      type: paramType,
      isOptional: !!param.questionToken,
    });
  }

  let returnType: IRType;
  if (member.type) {
    returnType = resolveTypeFromNode(member.type, ctx.checker, ctx.sourceFile);
  } else {
    const sig = ctx.checker.getSignatureFromDeclaration(member);
    returnType = sig
      ? resolveType(ctx.checker.getReturnTypeOfSignature(sig), ctx.checker)
      : { kind: "primitive", name: "void" };
  }
  if (typeParamNames.size > 0) {
    returnType = replaceGenericTypes(returnType, typeParamNames);
  }

  const isAbstract = !!member.modifiers?.some(
    (m) => m.kind === ts.SyntaxKind.AbstractKeyword,
  );

  const fnNeedsAllocator = !isAbstract && blockAllocates(member.body, ctx);

  const body: IRNode[] = [];
  if (member.body) {
    for (const stmt of member.body.statements) {
      const r = transformStatement(stmt, ctx);
      if (r) body.push(r);
    }
  }

  const isStatic = !!member.modifiers?.some(
    (m) => m.kind === ts.SyntaxKind.StaticKeyword,
  );
  const isReadOnly = !isStatic && !bodyMutatesThis(member.body);

  return {
    kind: "function",
    name: methodName,
    params,
    returnType,
    body,
    isPublic: true,
    isMethod: true,
    isStatic,
    isReadOnly,
    needsAllocator: fnNeedsAllocator,
    isMain: false,
    isAbstract,
    ownerClass,
  };
}

function extractThisAssignment(
  stmt: ts.Statement,
  ctx: TransformContext,
): { field: string; value: IRNode } | null {
  if (!ts.isExpressionStatement(stmt)) return null;
  const expr = stmt.expression;
  if (!ts.isBinaryExpression(expr)) return null;
  if (expr.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return null;
  const left = expr.left;
  if (!ts.isPropertyAccessExpression(left)) return null;
  if (left.expression.kind !== ts.SyntaxKind.ThisKeyword) return null;
  return { field: left.name.text, value: transformExpression(expr.right, ctx) };
}
