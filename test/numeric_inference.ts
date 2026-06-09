export function factorial(n: number): number {
  if (n <= 1) return 1;
  let result = 1;
  for (let i = 2; i <= n; i++) {
    result *= i;
  }
  return result;
}

export function gcdInfer(a: number, b: number): number {
  while (b !== 0) {
    const temp = b;
    b = a % b;
    a = temp;
  }
  return a;
}

export function fibonacci(n: number): number {
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

export function sumByIndex(arr: number[]): number {
  let total = 0;
  for (let i = 0; i < arr.length; i++) {
    total += arr[i];
  }
  return total;
}

export function countPositive(arr: number[]): number {
  let count = 0;
  for (let i = 0; i < arr.length; i++) {
    if (arr[i] > 0) {
      count += 1;
    }
  }
  return count;
}

export function lastIndex(arr: number[]): number {
  return arr.length - 1;
}

export function average(a: number, b: number): number {
  return (a + b) / 2;
}

export function percentage(part: number, whole: number): number {
  return (part / whole) * 100;
}

export function circleArea(radius: number): number {
  return 3.14159 * radius * radius;
}

export function toFahrenheit(celsius: number): number {
  return celsius * 1.8 + 32;
}

export function mixedBranch(n: number): number {
  if (n > 100) {
    return n * 1.5;
  }
  return n * 2;
}

export function flooredDivision(a: number, b: number): number {
  return Math.floor(a / b);
}

export function ceilDiv(a: number, b: number): number {
  return Math.ceil(a / b);
}

export function bitwiseOr(a: number, b: number): number {
  return a | b;
}

export function bitwiseMask(value: number, mask: number): number {
  return value & mask;
}

export function bitwiseXor(a: number, b: number): number {
  return a ^ b;
}

export function countWhile(limit: number): number {
  let count = 0;
  let i = 0;
  while (i < limit) {
    count += 1;
    i += 1;
  }
  return count;
}

export function delta(a: number, b: number): number {
  return a - b;
}

export function absoluteDelta(a: number, b: number): number {
  const d = a - b;
  if (d < 0) return -d;
  return d;
}

export function collatzStepsInfer(n: number): number {
  let steps = 0;
  let current = n;
  while (current !== 1) {
    if (current % 2 === 0) {
      current = Math.trunc(current / 2);
    } else {
      current = 3 * current + 1;
    }
    steps += 1;
  }
  return steps;
}

function doubleIt(x: number): number {
  return x * 2;
}

function tripleIt(x: number): number {
  return x * 3;
}

export function propagationTest(): number {
  const a = doubleIt(5);
  const b = tripleIt(a);
  return b + 1;
}

export function sumIntArray(): number {
  const nums: number[] = [10, 20, 30, 40, 50];
  let total = 0;
  for (const n of nums) {
    total += n;
  }
  return total;
}

export function sumFloatArray(): number {
  const nums: number[] = [1.5, 2.5, 3.5];
  let total = 0;
  for (const n of nums) {
    total += n;
  }
  return total;
}

export function reassignContamination(): number {
  let x = 10;
  x = 3.14;
  return x;
}

export function runNumericInferenceTests(): string[] {
  const results: string[] = [];

  // Integer tests
  results.push(`factorial(10): ${factorial(10)}`);
  results.push(`gcd(48,18): ${gcdInfer(48, 18)}`);
  results.push(`fibonacci(20): ${fibonacci(20)}`);

  // Index/length tests
  const testArr: number[] = [3, -1, 4, 1, 5, -9, 2, 6];
  results.push(`sumByIndex: ${sumByIndex(testArr)}`);
  results.push(`countPositive: ${countPositive(testArr)}`);
  results.push(`lastIndex: ${lastIndex(testArr)}`);

  // Float division
  results.push(`average(10,3): ${average(10, 3)}`);
  results.push(`percentage(1,3): ${percentage(1, 3)}`);

  // Float literals
  results.push(`circleArea(5): ${circleArea(5)}`);
  results.push(`toFahrenheit(100): ${toFahrenheit(100)}`);

  // Mixed branch
  results.push(`mixedBranch(50): ${mixedBranch(50)}`);
  results.push(`mixedBranch(200): ${mixedBranch(200)}`);

  // Integer math
  results.push(`flooredDivision(7,2): ${flooredDivision(7, 2)}`);
  results.push(`ceilDiv(7,2): ${ceilDiv(7, 2)}`);

  // Bitwise
  results.push(`bitwiseOr(5,3): ${bitwiseOr(5, 3)}`);
  results.push(`bitwiseMask(255,15): ${bitwiseMask(255, 15)}`);
  results.push(`bitwiseXor(10,6): ${bitwiseXor(10, 6)}`);

  // Counter
  results.push(`countWhile(100): ${countWhile(100)}`);

  // Negative delta
  results.push(`delta(3,7): ${delta(3, 7)}`);
  results.push(`absoluteDelta(3,7): ${absoluteDelta(3, 7)}`);

  // Collatz with Math.trunc
  results.push(`collatzSteps(27): ${collatzStepsInfer(27)}`);

  // Propagation
  results.push(`propagation: ${propagationTest()}`);

  // Array element types
  results.push(`sumIntArray: ${sumIntArray()}`);
  results.push(`sumFloatArray: ${sumFloatArray()}`);

  // Reassignment contamination
  results.push(`reassignContamination: ${reassignContamination()}`);

  return results;
}
