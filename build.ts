Bun.build({
  entrypoints: ["./src/cli/index.ts"],
  outdir: "./dist",
  target: "bun",
  minify: true,
  sourcemap: "linked",
});

console.log("Build complete.");
