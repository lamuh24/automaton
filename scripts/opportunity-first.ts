import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { ulid } from "ulid";
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
const agentDbPath = process.env.AUTOMATON_DB_PATH || path.join(os.homedir(), ".automaton", "state.db");
const OPPORTUNITY_STRATEGY = "opportunity-first-research-only";
const OPPORTUNITY_GOAL_TITLE = "Research legitimate non-trading income opportunities";

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

function activateAgent(): Record<string, unknown> {
  if (!fs.existsSync(agentDbPath)) {
    throw new Error(`Automaton state database was not found at ${agentDbPath}. Run local setup first.`);
  }

  const db = new Database(agentDbPath);
  db.pragma("foreign_keys = ON");
  try {
    return db.transaction(() => {
      const now = new Date().toISOString();
      let goal = db.prepare(
        "SELECT id FROM goals WHERE strategy = ? ORDER BY created_at DESC LIMIT 1",
      ).get(OPPORTUNITY_STRATEGY) as { id: string } | undefined;

      if (!goal) {
        goal = { id: ulid() };
        db.prepare(
          `INSERT INTO goals
           (id, title, description, status, strategy, expected_revenue_cents,
            actual_revenue_cents, created_at, deadline, completed_at)
           VALUES (?, ?, ?, 'active', ?, 2000, 0, ?, NULL, NULL)`,
        ).run(
          goal.id,
          OPPORTUNITY_GOAL_TITLE,
          [
            "Research legitimate, legal, zero-upfront-cost ways Lamuh could earn at least $20 per day outside crypto.",
            "This stage is research and analysis only: do not contact anyone, create accounts, accept terms, publish, spend money, perform paid work, or claim estimated income as earned income.",
            "Exclude crypto, securities, gambling, lending, mining, arbitrage, and anything deceptive or against platform rules.",
            "Find at least 10 evidence-backed candidates, compare realistic net earnings, time-to-first-dollar, requirements, risks, and repeatability, then rank the best three.",
            "Save a clear report in the workspace and identify each next action that requires Lamuh's approval.",
          ].join(" "),
          OPPORTUNITY_STRATEGY,
          now,
        );
      } else {
        db.prepare(
          "UPDATE goals SET status = 'active', completed_at = NULL WHERE id = ?",
        ).run(goal.id);
      }

      const existingResearchTask = db.prepare(
        `SELECT id FROM task_graph
         WHERE goal_id = ? AND status IN ('pending', 'assigned', 'running', 'blocked')
         LIMIT 1`,
      ).get(goal.id) as { id: string } | undefined;
      let researchTaskId = existingResearchTask?.id;
      if (!researchTaskId) {
        researchTaskId = ulid();
        db.prepare(
          `INSERT INTO task_graph
           (id, parent_id, goal_id, title, description, status, assigned_to,
            agent_role, priority, dependencies, result, estimated_cost_cents,
            actual_cost_cents, max_retries, retry_count, timeout_ms, created_at,
            started_at, completed_at)
           VALUES (?, NULL, ?, ?, ?, 'pending', NULL, 'generalist', 100, '[]',
                   NULL, 0, 0, 3, 0, 3600000, ?, NULL, NULL)`,
        ).run(
          researchTaskId,
          goal.id,
          "Produce the first non-trading opportunity shortlist",
          "Research at least 10 legitimate zero-upfront-cost income opportunities, rank the best three, and save an evidence-backed report. Research only. Do not contact anyone, create accounts, publish, spend, make commitments, perform paid work, or use crypto/trading.",
          now,
        );
      }

      const paused = db.prepare(
        "UPDATE goals SET status = 'paused', completed_at = NULL WHERE status = 'active' AND id != ?",
      ).run(goal.id).changes;
      const cancelledTasks = db.prepare(
        `UPDATE task_graph
         SET status = 'cancelled', assigned_to = NULL, completed_at = ?
         WHERE goal_id != ? AND status IN ('pending', 'assigned', 'running', 'blocked')`,
      ).run(now, goal.id).changes;
      const staleWorkers = db.prepare(
        "UPDATE children SET status = 'failed' WHERE address LIKE 'local://%' AND status IN ('running', 'healthy')",
      ).run().changes;

      db.prepare("DELETE FROM kv WHERE key = 'orchestrator.todo_md' OR key LIKE 'orchestrator.plan.%'").run();
      db.prepare(
        "INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES ('orchestrator.state', ?, datetime('now'))",
      ).run(JSON.stringify({ phase: "executing", goalId: goal.id, replanCount: 0, failedTaskId: null, failedError: null }));
      db.prepare(
        "INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES ('opportunity_first.activated_at', ?, datetime('now'))",
      ).run(now);
      db.prepare("DELETE FROM kv WHERE key = 'sleep_until'").run();

      return {
        status: "opportunity-agent-activated",
        goalId: goal.id,
        researchTaskId,
        goal: OPPORTUNITY_GOAL_TITLE,
        pausedPreviousGoals: paused,
        cancelledPreviousTasks: cancelledTasks,
        retiredStaleLocalWorkers: staleWorkers,
        restrictions: "Research only; no outreach, accounts, publishing, spending, commitments, crypto, or trading.",
      };
    })();
  } finally {
    db.close();
  }
}

function usage(): never {
  throw new Error([
    "Usage:",
    "  opportunity-first initialize",
    "  opportunity-first activate",
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
  if (command === "activate") {
    console.log(JSON.stringify(activateAgent(), null, 2));
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
