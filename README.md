# TSZIG

[![Status](https://img.shields.io/badge/status-in%20development-orange?style=flat-square)](https://github.com/orielhaim/TunTun)
[![Discord](https://img.shields.io/badge/discord-join%20server-5865F2?style=flat-square&logo=discord&logoColor=white)](https://discord.gg/y5bNc3MYKz)

TSZIG is an experimental compiler project that aims to transform TypeScript code into readable Zig code. The goal is to explore what a TypeScript-to-Zig workflow could look like while keeping the generated output simple and understandable.

## Why?

TypeScript offers a productive developer experience, while Zig focuses on simplicity, performance, and control. (Or in simpler terms - zig is faster 🙂)

## Usage

You can use the CLI to check your code compatibility or build the final Zig files.

### Installation

```bash
git clone https://github.com/orielhaim/tszig.git
cd tszig

bun install # or npm install (for the losers)
```

### Commands

**Build:** Compile a directory of TypeScript files to Zig.

```bash
bun dev build ./test -o ./output
```

**Check:** Validate TypeScript files for Zig compatibility without generating output.

```bash
bun dev check ./test
```

## Example

**Input (`fibonacci.ts`):**

```typescript
function fibonacci(n: number): number {
  if (n <= 1) return n;
  
  let a = 0;
  let b = 1;
  
  for (let i = 2; i <= n; i++) {
    const temp = a + b;
    a = b;
    b = temp;
  }
  
  return b;
}
```

**Output (`fibonacci.zig`):**

```zig
pub fn fibonacci(n: f64) f64 {
    if (n <= 1.0) return n;

    var a: f64 = 0.0;
    var b: f64 = 1.0;

    var i: f64 = 2.0;
    while (i <= n) : (i += 1.0) {
        const temp = a + b;
        a = b;
        b = temp;
    }

    return b;
}
```

### Try it yourself

The repo includes a [Test Suite](./test) directory that covers most of the supported TypeScript features.

```bash
bun dev build ./test -o ./output
```

## Status

TSZIG is currently under active development and is considered **experimental**.

- ✅ Built and tested with TypeScript 6
- ✅ Compatible with Zig 0.16.0
- ⚠️ Not all TypeScript features are supported (e.g., complex Generics, JS built-ins)
- ⚠️ APIs and output format may change frequently

## Goals

- [x] Primitive types, functions, and control flow
- [x] Classes with inheritance, abstract classes, and virtual dispatch
- [x] Generics (functions and classes)
- [x] Cross-module imports and multi-file compilation
- [ ] Comprehensive diagnostics for unsupported TypeScript patterns
- [ ] Standard library coverage (Math, string methods, Array utilities)
- [ ] Discriminated unions and advanced type narrowing

## Contributing

Issues, ideas, feedback, and pull requests are welcome. (Obviously)

## License

[Apache License 2.0](LICENSE)
