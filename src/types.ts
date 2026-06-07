export interface Diagnostic {
  severity: "error" | "warning";
  message: string;
  file?: string;
  line?: number;
  col?: number;
}

export interface OutputFile {
  path: string;
  content: string;
}

export interface CompileResult {
  files: OutputFile[];
  diagnostics: Diagnostic[];
}

// ============================================================
// IR Node Types — Intermediate Representation between TS and Zig
// ============================================================

export type IRNode =
  | IRModule
  | IRFunction
  | IRStruct
  | IRVariable
  | IRReturn
  | IRIfStatement
  | IRWhileLoop
  | IRForLoop
  | IRBlock
  | IRExpressionStatement
  | IRAssignment
  | IRBinaryExpr
  | IRUnaryExpr
  | IRCallExpr
  | IRMemberExpr
  | IRIndexExpr
  | IRLiteral
  | IRIdentifier
  | IRArrayLiteral
  | IRObjectLiteral
  | IRTemplateLiteral
  | IRConsolLog
  | IRTryCatch
  | IRThrow
  | IRSwitch
  | IREnum
  | IROptionalChain
  | IRNullishCoalesce
  | IRTypeAlias;

export interface IRModule {
  kind: "module";
  fileName: string;
  imports: IRImport[];
  body: IRNode[];
  errors: string[];
  hasMain: boolean;
}

export interface IRImport {
  names: string[];
  source: string;
  isDefault: boolean;
}

export interface IRFunction {
  kind: "function";
  name: string;
  params: IRParam[];
  returnType: IRType;
  body: IRNode[];
  isPublic: boolean;
  isMethod: boolean;
  isStatic: boolean;
  needsAllocator: boolean;
  isMain: boolean;
}

export interface IRParam {
  name: string;
  type: IRType;
  isOptional: boolean;
  defaultValue?: IRNode;
}

export interface IRStruct {
  kind: "struct";
  name: string;
  fields: IRField[];
  methods: IRFunction[];
  isPublic: boolean;
  hasInit: boolean;
}

export interface IRField {
  name: string;
  type: IRType;
  defaultValue?: IRNode;
  isPublic: boolean;
  isOptional: boolean;
}

export interface IRVariable {
  kind: "variable";
  name: string;
  type: IRType;
  value?: IRNode;
  isConst: boolean;
  needsDefer: boolean;
}

export interface IRReturn {
  kind: "return";
  value?: IRNode;
}

export interface IRIfStatement {
  kind: "if";
  condition: IRNode;
  thenBody: IRNode[];
  elseBody?: IRNode[];
}

export interface IRWhileLoop {
  kind: "while";
  condition: IRNode;
  body: IRNode[];
}

export interface IRForLoop {
  kind: "for";
  variant: "of" | "range" | "traditional";
  itemName: string;
  indexName?: string;
  iterable?: IRNode;
  start?: IRNode;
  end?: IRNode;
  body: IRNode[];
}

export interface IRBlock {
  kind: "block";
  body: IRNode[];
}

export interface IRExpressionStatement {
  kind: "expressionStatement";
  expression: IRNode;
}

export interface IRAssignment {
  kind: "assignment";
  target: IRNode;
  value: IRNode;
  operator: string;
}

export interface IRBinaryExpr {
  kind: "binary";
  operator: string;
  left: IRNode;
  right: IRNode;
  resultType: IRType;
}

export interface IRUnaryExpr {
  kind: "unary";
  operator: string;
  operand: IRNode;
  prefix: boolean;
}

export interface IRCallExpr {
  kind: "call";
  callee: IRNode;
  args: IRNode[];
  resultType: IRType;
}

export interface IRMemberExpr {
  kind: "member";
  object: IRNode;
  property: string;
  objectType: IRType;
}

export interface IRIndexExpr {
  kind: "index";
  object: IRNode;
  index: IRNode;
}

export interface IRLiteral {
  kind: "literal";
  value: string | number | boolean | null;
  type: IRType;
}

export interface IRIdentifier {
  kind: "identifier";
  name: string;
  type: IRType;
}

export interface IRArrayLiteral {
  kind: "arrayLiteral";
  elements: IRNode[];
  elementType: IRType;
}

export interface IRObjectLiteral {
  kind: "objectLiteral";
  properties: { name: string; value: IRNode }[];
  typeName?: string;
}

export interface IRTemplateLiteral {
  kind: "templateLiteral";
  parts: (string | IRNode)[];
}

export interface IRConsolLog {
  kind: "consoleLog";
  args: IRNode[];
}

export interface IRTryCatch {
  kind: "tryCatch";
  tryBody: IRNode[];
  catchParam?: string;
  catchBody: IRNode[];
  finallyBody?: IRNode[];
}

export interface IRThrow {
  kind: "throw";
  errorName: string;
  message?: string;
}

export interface IRSwitch {
  kind: "switch";
  discriminant: IRNode;
  cases: { test: IRNode | null; body: IRNode[] }[];
}

export interface IREnum {
  kind: "enum";
  name: string;
  members: { name: string; value?: IRNode }[];
  isPublic: boolean;
}

export interface IROptionalChain {
  kind: "optionalChain";
  object: IRNode;
  property: string;
}

export interface IRNullishCoalesce {
  kind: "nullishCoalesce";
  left: IRNode;
  right: IRNode;
}

export interface IRTypeAlias {
  kind: "typeAlias";
  name: string;
  type: IRType;
  isPublic: boolean;
}

// ============================================================
// IR Type System
// ============================================================

export type IRType =
  | {
      kind: "primitive";
      name: "f64" | "i64" | "bool" | "void" | "u8" | "usize";
    }
  | { kind: "string" }
  | { kind: "optional"; inner: IRType }
  | { kind: "array"; elementType: IRType }
  | { kind: "struct"; name: string }
  | { kind: "errorUnion"; okType: IRType; errorSet?: string }
  | { kind: "pointer"; inner: IRType; isConst: boolean }
  | { kind: "slice"; elementType: IRType; isConst: boolean }
  | { kind: "function"; params: IRType[]; returnType: IRType }
  | { kind: "enum"; name: string }
  | {
      kind: "taggedUnion";
      name: string;
      variants: { name: string; type: IRType }[];
    }
  | { kind: "anyopaque" }
  | { kind: "unknown" };
