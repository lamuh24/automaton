import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  evaluateEarningsGate,
  formatLocalDate,
  type VerifiedEarning,
} from "../src/opportunities/earnings-gate.js";

interface Opportunity {
  id: string;
  title: string;
  estimatedDailyUsd: number;
  url: string;
  notes: string;
  status: "research";
  createdAt: string;
}

const root = process.env.AUTOMATON_OPPORTUNITY_ROOT || path.join(os.homedir(), ".automaton", "opportunity-first");
const opportunitiesPath = path.join(root, "opportunities.jsonl");
const earningsPath = path.join(root, "earnings.jsonl");

function ensureFiles(): void {
  fs.mkdirSync(root, { recursive: true });
  for (const filePath of [opportunitiesPath, earningsPath]) {
    if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, "", { encoding: "utf8", mode: 0o600 });
  }
}

function readJsonLines<T>(filePath: string): T[] {
  ensureFiles();
  return fs.readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

function appendJsonLine(filePath: string, value: unknown): void {
  ensureFiles();
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`, "utf8");
}

function parseUsd(raw: string | undefined): number {
  const amount = Number(raw);
  if (!Number.isFinite(amount) || amount <= 0) throw new Error("Amount must be a positive USD number");
  return Math.round(amount * 100) / 100;
}

function assertDate(raw: string | undefined): string {
  if (!raw || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) throw new Error("Date must use YYYY-MM-DD");
  const parsed = new Date(`${raw}T12:00:00`);
  if (Number.isNaN(parsed.getTime()) || formatLocalDate(parsed) !== raw) throw new Error("Date is invalid");
  if (raw > formatLocalDate(new Date())) throw new Error("Future earnings cannot be recorded");
  return raw;
}

function status(): Record<string, unknown> {
  const opportunities = readJsonLines<Opportunity>(opportunitiesPath);
  const earnings = readJsonLines<VerifiedEarning>(earningsPath);
  const gate = evaluateEarningsGate(earnings);
  return {
    mode: "opportunity-first",
    target: "$20/day in verified non-trading earnings for 7 consecutive calendar days",
    opportunityCount: opportunities.length,
    verifiedEarningsCount: earnings.length,
    gate,
    nextStage: gate.cryptoResearchUnlocked
      ? "Creator-approved crypto research and paper simulation only; live trading remains unavailable."
      : "Continue legitimate opportunity research and verified non-trading earnings. Trading remains locked.",
  };
}

function usage(): never {
  throw new Error([
    "Usage:",
    "  opportunity-first initialize",
    "  opportunity-first add \"title\" estimatedDailyUsd url \"notes\"",
    "  opportunity-first list",
    "  opportunity-first record-earning YYYY-MM-DD amountUsd \"source\" \"evidence\"",
    "  opportunity-first status",
  ].join("\n"));
}

function main(): void {
  const [command, ...args] = process.argv.slice(2);
  ensureFiles();

  if (command === "initialize") {
    console.log(JSON.stringify({ status: "initialized", root, ...status() }, null, 2));
    return;
  }
  if (command === "add") {
    const [title, estimatedDailyRaw, url, ...notesParts] = args;
    const notes = notesParts.join(" ").trim();
    if (!title?.trim() || !url?.trim() || !notes) usage();
    const opportunity: Opportunity = {
      id: randomUUID(),
      title: title.trim(),
      estimatedDailyUsd: parseUsd(estimatedDailyRaw),
      url: url.trim(),
      notes,
      status: "research",
      createdAt: new Date().toISOString(),
    };
    appendJsonLine(opportunitiesPath, opportunity);
    console.log(JSON.stringify({ status: "opportunity-recorded", opportunity }, null, 2));
    return;
  }
  if (command === "list") {
    console.log(JSON.stringify({ root, opportunities: readJsonLines<Opportunity>(opportunitiesPath) }, null, 2));
    return;
  }
  if (command === "record-earning") {
    const [dateRaw, amountRaw, source, ...evidenceParts] = args;
    const evidence = evidenceParts.join(" ").trim();
    if (!source?.trim() || evidence.length < 3) usage();
    const earning: VerifiedEarning = {
      id: randomUUID(),
      date: assertDate(dateRaw),
      amountCents: Math.round(parseUsd(amountRaw) * 100),
      source: source.trim(),
      evidence,
      creatorVerified: true,
      recordedAt: new Date().toISOString(),
    };
    appendJsonLine(earningsPath, earning);
    console.log(JSON.stringify({ status: "creator-verified-earning-recorded", earning, gate: evaluateEarningsGate(readJsonLines<VerifiedEarning>(earningsPath)) }, null, 2));
    return;
  }
  if (command === "status") {
    console.log(JSON.stringify({ root, ...status() }, null, 2));
    return;
  }
  usage();
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

