// example/math.ts
export function add(a: number, b: number): number {
  return a + b;
}

export function main(): void {
  const result = add(10, 20);
  console.log(result);

  const name: string = "world";
  console.log(`hello ${name}`);

  const items: number[] = [1, 2, 3];
  for (const item of items) {
    console.log(item);
  }

  if (result > 15) {
    console.log("big number");
  } else {
    console.log("small number");
  }
}

main();