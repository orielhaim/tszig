import type { IRNode, IRType, Diagnostic } from "../types";
import {
  sanitizeName,
  escapeZigString,
  isStringNode,
  getNodeType,
  formatSpecForType,
  isArithmeticOp,
  coerce,
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
      const left = generateExpr((node as any).left, diagnostics);
      const right = generateExpr((node as any).right, diagnostics);
      const op = (node as any).operator;

      if (
        op === "+" &&
        (isStringNode((node as any).left) || isStringNode((node as any).right))
      ) {
        return `_rt.concat(allocator, ${left}, ${right})`;
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

        const leftCoerced = coerce(left, lt, target);
        const rightCoerced = coerce(right, rt, target);
        return `${leftCoerced} ${op} ${rightCoerced}`;
      }

      return `${left} ${op} ${right}`;
    }

    case "unary":
      return `${(node as any).operator}${generateExpr((node as any).operand, diagnostics)}`;

    case "call": {
      const calleeNode = (node as any).callee;

      if (
        calleeNode.kind === "member" &&
        calleeNode.property === "append" &&
        calleeNode.objectType?.kind === "array"
      ) {
        const obj = generateExpr(calleeNode.object, diagnostics);
        const args = (node as any).args.map((a: IRNode) =>
          generateExpr(a, diagnostics),
        );
        return `try ${obj}.append(allocator, ${args.join(", ")})`;
      }

      const callee = generateExpr(calleeNode, diagnostics);
      const userArgs = (node as any).args.map((a: IRNode) =>
        generateExpr(a, diagnostics),
      );

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

    case "member":
      return `${generateExpr((node as any).object, diagnostics)}.${sanitizeName((node as any).property)}`;

    case "index":
      return `${generateExpr((node as any).object, diagnostics)}[${generateExpr((node as any).index, diagnostics)}]`;

    case "arrayLiteral": {
      if ((node as any).isTuple) {
        const elems = (node as any).elements.map((e: IRNode) =>
          generateExpr(e, diagnostics),
        );
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

    case "nullishCoalesce":
      return `${generateExpr((node as any).left, diagnostics)} orelse ${generateExpr((node as any).right, diagnostics)}`;

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
    if (Number.isInteger(node.value)) {
      const irType = node.type as IRType | undefined;
      if (irType?.kind === "primitive") {
        if (irType.name === "f64") return `@as(f64, ${node.value})`;
        if (irType.name === "usize") return `@as(usize, ${node.value})`;
        if (irType.name === "i64") return `@as(i64, ${node.value})`;
      }
      return `${node.value}`;
    }
    return `${node.value}`;
  }
  return "undefined";
}
