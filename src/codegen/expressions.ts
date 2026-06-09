import type { IRNode, IRType, Diagnostic } from "../types";
import {
  sanitizeName,
  escapeZigString,
  isStringNode,
  concatOperand,
  getNodeType,
  formatSpecForType,
  isArithmeticOp,
  coerce,
  castSelfToOpaque,
  isSignedIntegerType,
  commonNumericType,
  wrapBinaryChild,
} from "./utils";

export function generateExpr(node: IRNode, diagnostics: Diagnostic[]): string {
  switch (node.kind) {
    case "literal":
      return generateLiteral(node);

    case "identifier":
      return sanitizeName((node as any).name);

    case "instantiatedType":
      return `${sanitizeName((node as any).base)}(${(node as any).typeArg})`;

    case "binary": {
      const leftNode = (node as any).left;
      const rightNode = (node as any).right;
      const op = (node as any).operator;
      const left = wrapBinaryChild(
        leftNode,
        generateExpr(leftNode, diagnostics),
        op,
        false,
      );
      const right = wrapBinaryChild(
        rightNode,
        generateExpr(rightNode, diagnostics),
        op,
        true,
      );

      if (
        op === "+" &&
        (isStringNode((node as any).left) || isStringNode((node as any).right))
      ) {
        const leftArg = concatOperand(left, (node as any).left);
        const rightArg = concatOperand(right, (node as any).right);
        return `_rt.concat(allocator, ${leftArg}, ${rightArg})`;
      }

      if (isArithmeticOp(op)) {
        const lt = getNodeType((node as any).left);
        const rt = getNodeType((node as any).right);
        const resultType: IRType = (node as any).resultType ?? {
          kind: "primitive",
          name: "f64",
        };

        const target: IRType =
          resultType.kind === "primitive" && resultType.name === "f64"
            ? { kind: "primitive", name: "f64" }
            : resultType;

        const i64Target: IRType = { kind: "primitive", name: "i64" };
        const f64Target: IRType = { kind: "primitive", name: "f64" };
        const bothSignedInt =
          isSignedIntegerType(lt) && isSignedIntegerType(rt);

        if (op === "/") {
          if (bothSignedInt) {
            if (isSignedIntegerType(target)) {
              const leftCoerced = coerce(left, lt, i64Target);
              const rightCoerced = coerce(right, rt, i64Target);
              return `@divTrunc(${leftCoerced}, ${rightCoerced})`;
            }
            const leftCoerced = coerce(left, lt, f64Target);
            const rightCoerced = coerce(right, rt, f64Target);
            return `${leftCoerced} / ${rightCoerced}`;
          }
          const leftCoerced = coerce(left, lt, target);
          const rightCoerced = coerce(right, rt, target);
          return `${leftCoerced} / ${rightCoerced}`;
        }

        if (op === "%") {
          const modTarget =
            bothSignedInt && isSignedIntegerType(target) ? i64Target : target;
          const leftCoerced = coerce(left, lt, modTarget);
          const rightCoerced = coerce(right, rt, modTarget);
          if (bothSignedInt) {
            return `@rem(${leftCoerced}, ${rightCoerced})`;
          }
          return `@rem(${leftCoerced}, ${rightCoerced})`;
        }

        const leftCoerced = coerce(left, lt, target);
        const rightCoerced = coerce(right, rt, target);
        return `${leftCoerced} ${op} ${rightCoerced}`;
      }

      if (
        op === "==" ||
        op === "!=" ||
        op === "<" ||
        op === "<=" ||
        op === ">" ||
        op === ">="
      ) {
        const lt = getNodeType((node as any).left);
        const rt = getNodeType((node as any).right);
        if (
          (op === "==" || op === "!=") &&
          (lt.kind === "string" || rt.kind === "string")
        ) {
          const cmp = `std.mem.eql(u8, ${left}, ${right})`;
          return op === "==" ? cmp : `!${cmp}`;
        }
        const target = commonNumericType(lt, rt);
        if (target) {
          const leftCoerced = coerce(left, lt, target);
          const rightCoerced = coerce(right, rt, target);
          if (op === "==" || op === "!=") {
            return `${leftCoerced} ${op} ${rightCoerced}`;
          }
          return `${leftCoerced} ${op} ${rightCoerced}`;
        }
      }

      if (
        op === "|" ||
        op === "&" ||
        op === "^" ||
        op === "<<" ||
        op === ">>"
      ) {
        const lt = getNodeType((node as any).left);
        const rt = getNodeType((node as any).right);
        const intTarget: IRType = { kind: "primitive", name: "i64" };
        const leftCoerced = coerce(left, lt, intTarget);
        const rightCoerced = coerce(right, rt, intTarget);
        return `${leftCoerced} ${op} ${rightCoerced}`;
      }

      return `${left} ${op} ${right}`;
    }

    case "unary": {
      const operandNode = (node as any).operand as IRNode;
      const operand = generateExpr(operandNode, diagnostics);
      const op = (node as any).operator as string;
      if (op === "+") return operand;
      const raw = `${op}${operand}`;
      const resultType = (node as any).resultType as IRType | undefined;
      if (resultType) {
        return coerce(raw, getNodeType(operandNode), resultType);
      }
      return raw;
    }

    case "call": {
      const calleeNode = (node as any).callee;

      if (
        calleeNode.kind === "member" &&
        calleeNode.property === "append" &&
        calleeNode.objectType?.kind === "array"
      ) {
        const obj = generateExpr(calleeNode.object, diagnostics);
        const elemType = calleeNode.objectType.elementType;
        const args = (node as any).args.map((a: IRNode) => {
          const raw = generateExpr(a, diagnostics);
          return coerce(raw, getNodeType(a), elemType);
        });
        return `try ${obj}.append(allocator, ${args.join(", ")})`;
      }

      const callee = generateExpr(calleeNode, diagnostics);
      const paramTypes = (node as any).paramTypes as IRType[] | undefined;
      const userArgs = (node as any).args.map((a: IRNode, i: number) => {
        const raw = generateExpr(a, diagnostics);
        const paramType = paramTypes?.[i];
        return paramType ? coerce(raw, getNodeType(a), paramType) : raw;
      });

      const fullArgs: string[] = [];

      if ((node as any).calleeNeedsAllocator) {
        fullArgs.push("allocator");
      }

      fullArgs.push(...userArgs);

      const callStr = `${callee}(${fullArgs.join(", ")})`;

      if ((node as any).calleeReturnsError) {
        return `try ${callStr}`;
      }

      return callStr;
    }

    case "superCall": {
      const sc = node as any;
      const parent = sc.parentClass as string;
      const method = sc.method as string;
      const args = (sc.args as IRNode[]).map((a) =>
        generateExpr(a, diagnostics),
      );
      if (method === "constructor") {
        return `${parent}.init(${args.join(", ")})`;
      }
      const callArgs: string[] = [
        castSelfToOpaque("self", sc.isReadOnly !== false),
      ];
      if (sc.hierAllocates) callArgs.push("allocator");
      callArgs.push(...args);
      const callExpr = `${parent}.__${sanitizeName(method)}_impl(${callArgs.join(", ")})`;
      if (sc.hierAllocates || sc.hierThrows) return `try ${callExpr}`;
      return callExpr;
    }

    case "member":
      return `${generateExpr((node as any).object, diagnostics)}.${sanitizeName((node as any).property)}`;

    case "index": {
      const objectNode = (node as any).object as IRNode;
      const objectExpr = generateExpr(objectNode, diagnostics);
      const indexExpr = generateExpr((node as any).index, diagnostics);
      const objectType = getNodeType(objectNode);
      if (objectType.kind === "array") {
        return `${objectExpr}.items[${indexExpr}]`;
      }
      return `${objectExpr}[${indexExpr}]`;
    }

    case "arrayLiteral": {
      if ((node as any).isTuple) {
        const tupleTypes = (node as any).tupleElementTypes as
          | IRType[]
          | undefined;
        const elems = (node as any).elements.map((e: IRNode, i: number) => {
          const raw = generateExpr(e, diagnostics);
          const target = tupleTypes?.[i];
          if (!target) return raw;
          return coerce(raw, getNodeType(e), target);
        });
        return `.{ ${elems.join(", ")} }`;
      }
      return `// inline array literal`;
    }

    case "objectLiteral": {
      const typeName = (node as any).typeName as string | undefined;
      const props = (node as any).properties as {
        name: string;
        value: IRNode;
        targetType?: IRType;
      }[];

      const propStrs = props.map((p) => {
        const rawValue = generateExpr(p.value, diagnostics);
        const fromType = getNodeType(p.value);
        const finalValue = coerce(rawValue, fromType, p.targetType);
        return `.${sanitizeName(p.name)} = ${finalValue}`;
      });

      if (!typeName) {
        return `.{ ${propStrs.join(", ")} }`;
      }
      return `${typeName}{ ${propStrs.join(", ")} }`;
    }

    case "templateLiteral": {
      const formatParts: string[] = [];
      const argParts: string[] = [];
      for (const part of (node as any).parts) {
        if (typeof part === "string") {
          formatParts.push(escapeZigString(part));
        } else {
          const exprType = getNodeType(part as IRNode);
          formatParts.push(formatSpecForType(exprType));
          argParts.push(generateExpr(part as IRNode, diagnostics));
        }
      }
      return `std.fmt.allocPrint(allocator, "${formatParts.join("")}"${argParts.length > 0 ? `, .{${argParts.join(", ")}}` : ", .{}"}) catch unreachable`;
    }

    case "nullishCoalesce": {
      const leftNode = (node as any).left as IRNode;
      const rightNode = (node as any).right as IRNode;
      const left = generateExpr(leftNode, diagnostics);
      const right = generateExpr(rightNode, diagnostics);
      const lt = getNodeType(leftNode);
      const rt = getNodeType(rightNode);
      const target =
        ((node as any).resultType as IRType | undefined) ??
        commonNumericType(lt, rt) ??
        rt;
      const rightCoerced = coerce(right, rt, target);
      return `${left} orelse ${rightCoerced}`;
    }

    case "optionalChain":
      return `if (${generateExpr((node as any).object, diagnostics)}) |val| val.${sanitizeName((node as any).property)} else null`;

    case "consoleLog":
      return "// console.log handled at statement level";

    case "arrowFunction":
      return `@compileError("unhoisted arrow function")`;

    default:
      return `@compileError("unsupported: ${(node as any).kind}")`;
  }
}

function generateLiteral(node: any): string {
  if (node.value === null) return "null";
  if (typeof node.value === "boolean") return node.value ? "true" : "false";
  if (typeof node.value === "string") return `"${escapeZigString(node.value)}"`;
  if (typeof node.value === "number") {
    const v = node.value as number;
    const irType = node.type as IRType | undefined;
    if (Number.isInteger(v) && irType?.kind === "primitive") {
      if (irType.name === "f64") {
        return v < 0 ? `-${Math.abs(v)}.0` : `${v}.0`;
      }
      if (irType.name === "i64" || irType.name === "usize") {
        return `${v}`;
      }
    }
    return `${v}`;
  }
  return "undefined";
}
