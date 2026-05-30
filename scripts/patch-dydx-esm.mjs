// Workaround for @dydxprotocol/v4-client-js v3.6.0 packaging bug.
//
// The shipped ESM build (build/esm/) omits .js extensions on internal imports
// (e.g. `import ... from './lib/registry'`), which is valid CJS resolution but
// illegal under Node ESM. The CJS build (build/cjs/) is fine. Cleanest fix: in
// the package.json `exports.import` conditional, point ESM consumers at the
// CJS build. Modern Node statically analyses CJS named exports, so consumers
// still get `import { Network } from "@dydxprotocol/v4-client-js"`.
//
// Runs from `postinstall` so the patch survives `npm install`.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const pkgPath = resolve(process.cwd(), "node_modules/@dydxprotocol/v4-client-js/package.json");

if (!existsSync(pkgPath)) {
  // SDK not installed — postinstall ran before deps materialised. No-op.
  process.exit(0);
}

try {
  const raw = readFileSync(pkgPath, "utf8");
  const pkg = JSON.parse(raw);
  const wantImport = "./build/cjs/src/index.js";
  const current = pkg?.exports?.["."]?.import;
  if (current === wantImport) {
    console.log(`[patch-dydx-esm] already patched`);
    process.exit(0);
  }
  pkg.exports = pkg.exports ?? {};
  pkg.exports["."] = pkg.exports["."] ?? {};
  pkg.exports["."].import = wantImport;
  // Also force `module` to CJS so bundlers that read it don't dive into the
  // broken ESM tree.
  pkg.module = wantImport;
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
  console.log(`[patch-dydx-esm] rewrote exports.import → ${wantImport}`);
} catch (e) {
  console.error(`[patch-dydx-esm] failed:`, e?.message ?? e);
}
