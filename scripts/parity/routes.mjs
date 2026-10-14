import "../../src/config/env.js";

process.env.DATABASE_URL ??= "postgres://hkm@localhost:5433/hkm_local";
const { app } = await import("../../app.js");

import { readFileSync } from "node:fs";

const mounts = [
  ...readFileSync(new URL("../../app.js", import.meta.url), "utf8").matchAll(
    /app\.use\(\s*"([^"]+)",\s*([A-Za-z]+Router)\b/g
  ),
].map((m) => m[1]);
let mountIdx = 0;
const routes = [];
const walk = (stack, prefix = "") => {
  for (const layer of stack) {
    if (layer.route) {
      for (const method of Object.keys(layer.route.methods)) {
        routes.push({
          method: method.toUpperCase(),
          path: prefix + layer.route.path,
          mw: layer.route.stack.map((s) => s.name).filter((n) => n && n !== "<anonymous>"),
        });
      }
    } else if (layer.name === "router" && layer.handle?.stack) {
      const mount = prefix === "" ? mounts[mountIdx++] : "";
      walk(layer.handle.stack, prefix + (mount ?? ""));
    }
  }
};
walk(app.router.stack);
console.log(JSON.stringify(routes, null, 1));
process.exit(0);
