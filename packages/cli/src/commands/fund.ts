/**
 * automaton-cli fund <amount>
 *
 * Add to the host runtime's logical compute budget. This command is local-only
 * and never contacts a payment or cloud service.
 */

import { loadConfig, saveConfig } from "@lamuh24/automaton/config.js";

const args = process.argv.slice(3);
const amount = args[0];

if (!amount) {
  console.log("Usage: automaton-cli fund <amount>");
  console.log("Example: automaton-cli fund 5.00");
  process.exit(1);
}

const config = loadConfig();
if (!config) {
  console.log("No automaton configuration found.");
  process.exit(1);
}

if ((config.runtimeBackend || "local") !== "local") {
  console.log("This command manages only the local host-runtime budget.");
  process.exit(1);
}

const amountCents = parseAmountToCents(amount);
if (amountCents <= 0) {
  console.log(`Invalid amount: ${amount}`);
  process.exit(1);
}

const previous = config.localComputeBudgetCents || 0;
config.localComputeBudgetCents = previous + amountCents;
saveConfig(config);

console.log(`
Local compute budget updated.
Added:     ${amountCents} units
Previous:  ${previous} units
Available: ${config.localComputeBudgetCents} units
`);

function parseAmountToCents(raw: string): number {
  const trimmed = raw.trim();
  if (!trimmed) return 0;
  if (/^\d+$/.test(trimmed) && Number(trimmed) >= 100) return Number(trimmed);
  const units = Number(trimmed);
  return Number.isFinite(units) ? Math.round(units * 100) : 0;
}
