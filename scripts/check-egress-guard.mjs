/**
 * Egress-boundary gate.
 *
 * Two assertions that a review can otherwise only make by reading every request
 * helper: the process entry point still installs the guard, and the built
 * artifact carries no reporting endpoint. Run after `pnpm build`; the artifact
 * scan is skipped when `dist/` is absent so the gate stays usable on a partial
 * checkout.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const failures = [];

const entryPath = "packages/tui/src/index.ts";
const entry = readFileSync(path.join(root, entryPath), "utf8");
if (!entry.includes("./runtime/egress-guard.js") || !entry.includes("installTuiEgressGuard")) {
  failures.push(`${entryPath}: the CLI entry point no longer installs the egress guard`);
}

const guardPath = "packages/shared/src/egress-guard.ts";
const guard = readFileSync(path.join(root, guardPath), "utf8");
const reportingBlock = /export const REPORTING_HOSTS = \[([^\]]*)\]/u.exec(guard);
if (!reportingBlock) {
  failures.push(`${guardPath}: REPORTING_HOSTS is missing`);
} else {
  const hosts = [...reportingBlock[1].matchAll(/'([^']+)'/gu)].map((match) => match[1]);
  if (hosts.length === 0) failures.push(`${guardPath}: REPORTING_HOSTS is empty`);
  if (!/export const ALWAYS_DENIED_HOSTS = \[\.\.\.REPORTING_HOSTS, \.\.\.MANAGED_SERVICE_HOSTS\]/u.test(guard)) {
    failures.push(`${guardPath}: ALWAYS_DENIED_HOSTS no longer includes every reporting host`);
  }
  const dist = path.join(root, "dist");
  // Endpoint markers unique to the removed reporting transports. The guard's own
  // deny list legitimately names hostnames, so hosts are not a usable signal here;
  // request paths are.
  const removedEndpoints = [
    "meerkat-reporter",
    "/observability/desktop-errors/batch",
    "/matrix/api/v1/metrics/batch",
  ];
  if (existsSync(dist)) {
    const files = listFiles(dist).filter((file) => file.endsWith(".js"));
    const text = files.map((file) => readFileSync(file, "utf8")).join("\n");
    for (const endpoint of removedEndpoints) {
      if (text.includes(endpoint)) {
        failures.push(`removed reporting endpoint present in the built artifact: ${endpoint}`);
      }
    }
    if (!text.includes("MCODE_EGRESS_BLOCKED")) {
      failures.push("the built artifact does not contain the egress guard");
    }
  } else {
    console.log("dist/ is absent; artifact scan skipped.");
  }
}

if (failures.length > 0) {
  throw new Error(`Egress boundary gate failed:\n${failures.map((line) => `- ${line}`).join("\n")}`);
}
console.log("Egress boundary gate passed.");

function listFiles(directory) {
  return readdirSync(directory).flatMap((name) => {
    const full = path.join(directory, name);
    return statSync(full).isDirectory() ? listFiles(full) : [full];
  });
}
