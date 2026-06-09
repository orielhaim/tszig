import { integerArithmetic } from "./primitives";
import { greet, templateGreet } from "./strings";
import { classifyNumber, switchStatement } from "./control_flow";
import { sumArray, makeTuple } from "./arrays_tuples";
import { findPositive, withDefault } from "./nullable";
import { Direction, directionName } from "./enums";
import {
  createVec2,
  addVec2,
  createDefaultConfig,
  describeConfig,
} from "./interfaces";
import { createPair, sumPair } from "./type_aliases";
import { Box, useBox } from "./generics";
import { Rectangle, BankAccount } from "./classes";
import { describeShapes, animalSounds } from "./inheritance";
import { safeDivide } from "./error_handling";
import { runStateMachine } from "./state_machine";
import { Particle, ParticleSystem } from "./class_composition";
import { isPrime, gcd, factorial, collatzSteps } from "./complex_algorithms";
import { totalArea, createShapeGallery } from "./polymorphism";
import { NumberCollection, StringCollection } from "./generic_inheritance";
import { runNumericInferenceTests } from "./numeric_inference";

function main(): void {
  // Primitives
  console.log("Arithmetic:", integerArithmetic(10, 3));

  // Strings
  console.log(greet("World"));
  console.log(templateGreet("Alice", 25));

  // Control flow
  console.log("Classify 5:", classifyNumber(5));
  console.log("Day 3:", switchStatement(3));

  // Arrays
  const nums: number[] = [1, 2, 3, 4, 5];
  console.log("Sum:", sumArray(nums));

  // Tuples
  const pair = makeTuple(10, "hello");
  console.log("Tuple:", pair);

  // Nullable
  const found = findPositive(nums);
  if (found !== null) {
    console.log("Found:", found);
  }
  console.log("Default:", withDefault(null));

  // Enums
  console.log("Direction:", directionName(Direction.Right));

  // Interfaces
  const v1 = createVec2(3, 4);
  const v2 = createVec2(1, 2);
  const v3 = addVec2(v1, v2);
  console.log("Vec sum:", v3.x, v3.y);

  const config = createDefaultConfig();
  console.log(describeConfig(config));

  // Type aliases
  const p = createPair(5, 10);
  console.log("Pair sum:", sumPair(p));

  // Generics
  console.log("Box:", useBox());
  const strBox = new Box<string>("test");
  console.log("StrBox:", strBox.get());

  // Classes
  const rect = new Rectangle(10, 5);
  console.log("Area:", rect.area());
  console.log("Square?", rect.isSquare());

  const account = new BankAccount("Alice", 100);
  account.deposit(50);
  account.withdraw(30);
  console.log(account.describe());

  // Inheritance + Polymorphism
  const shapeDescs = describeShapes();
  for (const d of shapeDescs) {
    console.log(d);
  }

  const sounds = animalSounds();
  for (const s of sounds) {
    console.log(s);
  }

  // Polymorphism advanced
  const gallery = createShapeGallery();
  console.log("Total area:", totalArea(gallery));

  // Error handling
  try {
    const result = safeDivide(10, 2);
    console.log("Divide:", result);
  } catch (e) {
    console.log("Error caught");
  }

  // State machine
  const smLog = runStateMachine();
  for (const entry of smLog) {
    console.log("SM:", entry);
  }

  // Composition
  const system = new ParticleSystem();
  system.add(new Particle(0, 0, 1));
  system.add(new Particle(10, 5, 2));
  system.tick();
  const descs = system.describeAll();
  for (const d of descs) {
    console.log(d);
  }

  // Algorithms
  console.log("isPrime(7):", isPrime(7));
  console.log("isPrime(10):", isPrime(10));
  console.log("GCD(12,8):", gcd(12, 8));
  console.log("Factorial(6):", factorial(6));
  console.log("Collatz(27):", collatzSteps(27));

  // Generic inheritance
  const nc = new NumberCollection();
  nc.add(10);
  nc.add(20);
  nc.add(30);
  console.log(nc.describe());
  console.log("Sum:", nc.sum());

  const sc = new StringCollection();
  sc.add("hello");
  sc.add("world");
  console.log(sc.describe());
  console.log("Joined:", sc.joinAll(", "));

  const niResults = runNumericInferenceTests();
  for (const r of niResults) {
    console.log("NI:", r);
  }
}

main();
