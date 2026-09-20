import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const files = [];
(function walk(d) {
  for (const e of readdirSync(d)) {
    const p = join(d, e);
    if (statSync(p).isDirectory()) walk(p);
    else if (p.endsWith(".ts")) files.push(p.split("\\").join("/"));
  }
})("src");

const src = new Map(files.map((f) => [f, readFileSync(f, "utf8")]));

const roots = ["src/main.ts"];
const reachable = new Set();
const queue = [...roots];
while (queue.length) {
  const f = queue.pop();
  if (reachable.has(f)) continue;
  if (!src.has(f)) continue;
  reachable.add(f);
  const text = src.get(f);
  const specs = [...text.matchAll(/from\s+"(\.[^"]+)"/g)].map((m) => m[1]);
  for (const s of specs) {
    const base = join(f, "..", s);
    let hit = false;
    for (const cand of [base + ".ts", join(base, "index.ts")]) {
      const norm = cand.split("\\").join("/");
      if (src.has(norm)) {
        queue.push(norm);
        hit = true;
        break;
      }
    }
  }
}

console.log("REACHABLE FROM main.ts:", reachable.size, "of", files.length);
const unreachable = files.filter((f) => !reachable.has(f));
console.log("\nUNREACHABLE MODULES (" + unreachable.length + "):");
for (const f of unreachable.sort()) console.log("  " + f);
