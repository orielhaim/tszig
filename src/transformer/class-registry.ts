import * as ts from "typescript";

export interface ClassInfo {
  name: string;
  baseClass: string | null;
  isAbstract: boolean;
  declaredMethods: Set<string>;
  abstractMethods: Set<string>;
  node: ts.ClassDeclaration;
}

export class ClassRegistry {
  private classes = new Map<string, ClassInfo>();

  build(sourceFile: ts.SourceFile): void {
    ts.forEachChild(sourceFile, (node) => {
      if (ts.isClassDeclaration(node) && node.name) {
        this.classes.set(node.name.text, this.collectClassInfo(node));
      }
    });
  }

  private collectClassInfo(node: ts.ClassDeclaration): ClassInfo {
    const name = node.name!.text;
    let baseClass: string | null = null;

    if (node.heritageClauses) {
      for (const clause of node.heritageClauses) {
        if (
          clause.token === ts.SyntaxKind.ExtendsKeyword &&
          clause.types.length > 0
        ) {
          const t = clause.types[0];
          if (ts.isIdentifier(t.expression)) {
            baseClass = t.expression.text;
          }
        }
      }
    }

    const isAbstract = !!node.modifiers?.some(
      (m) => m.kind === ts.SyntaxKind.AbstractKeyword,
    );

    const declaredMethods = new Set<string>();
    const abstractMethods = new Set<string>();
    for (const member of node.members) {
      if (ts.isMethodDeclaration(member) && member.name) {
        const mname = member.name.getText();
        declaredMethods.add(mname);
        if (
          member.modifiers?.some(
            (m) => m.kind === ts.SyntaxKind.AbstractKeyword,
          )
        ) {
          abstractMethods.add(mname);
        }
      }
    }

    return {
      name,
      baseClass,
      isAbstract,
      declaredMethods,
      abstractMethods,
      node,
    };
  }

  get(name: string): ClassInfo | undefined {
    return this.classes.get(name);
  }

  has(name: string): boolean {
    return this.classes.has(name);
  }

  ancestry(name: string): ClassInfo[] {
    const result: ClassInfo[] = [];
    let cur: string | null = name;
    while (cur) {
      const info = this.classes.get(cur);
      if (!info) break;
      result.push(info);
      cur = info.baseClass;
    }
    return result;
  }

  rootOf(name: string): string {
    const chain = this.ancestry(name);
    return chain.length > 0 ? chain[chain.length - 1].name : name;
  }

  participatesInHierarchy(name: string): boolean {
    const info = this.classes.get(name);
    if (!info) return false;
    if (info.baseClass) return true;
    for (const other of this.classes.values()) {
      if (other.baseClass === name) return true;
    }
    return false;
  }

  virtualMethodsForRoot(rootName: string): string[] {
    const root = this.classes.get(rootName);
    if (!root) return [];

    const descendants: ClassInfo[] = [root];
    const queue = [rootName];
    while (queue.length > 0) {
      const cur = queue.shift()!;
      for (const c of this.classes.values()) {
        if (c.baseClass === cur) {
          descendants.push(c);
          queue.push(c.name);
        }
      }
    }

    const virtuals = new Set<string>();

    if (descendants.length > 1) {
      for (const m of root.declaredMethods) virtuals.add(m);
    }

    for (const d of descendants) {
      if (d === root) continue;
      for (const m of d.declaredMethods) {
        let parent = d.baseClass;
        while (parent) {
          const pinfo = this.classes.get(parent);
          if (!pinfo) break;
          if (pinfo.declaredMethods.has(m)) {
            virtuals.add(m);
            break;
          }
          parent = pinfo.baseClass;
        }
      }
      for (const m of d.abstractMethods) virtuals.add(m);
    }

    for (const m of root.abstractMethods) virtuals.add(m);

    return Array.from(virtuals);
  }

  findMethodOwner(className: string, method: string): string | null {
    for (const c of this.ancestry(className)) {
      if (c.declaredMethods.has(method) && !c.abstractMethods.has(method)) {
        return c.name;
      }
    }
    return null;
  }

  allClasses(): ClassInfo[] {
    return Array.from(this.classes.values());
  }

  private hierarchyMethodEffects = new Map<
    string,
    Map<string, { allocates: boolean; throws: boolean }>
  >();

  computeMethodEffects(
    isAllocating: (
      decl: ts.MethodDeclaration | ts.ConstructorDeclaration,
    ) => boolean,
    isThrowing: (
      decl: ts.MethodDeclaration | ts.ConstructorDeclaration,
    ) => boolean,
  ): void {
    const roots = new Set<string>();
    for (const c of this.classes.values()) {
      roots.add(this.rootOf(c.name));
    }

    for (const root of roots) {
      const virtuals = this.virtualMethodsForRoot(root);
      const effects = new Map<
        string,
        { allocates: boolean; throws: boolean }
      >();
      for (const v of virtuals)
        effects.set(v, { allocates: false, throws: false });

      const queue = [root];
      const seen = new Set<string>();
      while (queue.length) {
        const cur = queue.shift()!;
        if (seen.has(cur)) continue;
        seen.add(cur);
        const info = this.classes.get(cur);
        if (!info) continue;

        for (const member of info.node.members) {
          if (!ts.isMethodDeclaration(member)) continue;
          const mname = member.name.getText();
          const slot = effects.get(mname);
          if (!slot) continue;
          if (isAllocating(member)) slot.allocates = true;
          if (isThrowing(member)) slot.throws = true;
        }

        for (const other of this.classes.values()) {
          if (other.baseClass === cur) queue.push(other.name);
        }
      }

      this.hierarchyMethodEffects.set(root, effects);
    }
  }

  methodEffects(
    className: string,
    method: string,
  ): { allocates: boolean; throws: boolean } {
    const root = this.rootOf(className);
    const effects = this.hierarchyMethodEffects.get(root);
    return effects?.get(method) ?? { allocates: false, throws: false };
  }
}
