import { describe, expect, it } from "vitest";
import {
  CRYPTO_APPROVAL_PHRASE,
  evaluateEarningsGate,
  requiredCalendarDates,
  type VerifiedEarning,
} from "../opportunities/earnings-gate.js";

function earning(date: string, amountCents = 2_000): VerifiedEarning {
  return {
    id: date,
    date,
    amountCents,
    source: "completed service",
    evidence: "creator checked receipt",
    creatorVerified: true,
    recordedAt: `${date}T18:00:00.000Z`,
  };
}

describe("opportunity-first earnings gate", () => {
  const now = new Date(2026, 8, 3, 12);
  const dates = requiredCalendarDates(now, 7);

  it("requires every one of the last seven calendar days to reach $20", () => {
    const status = evaluateEarningsGate(dates.map((date) => earning(date)), now);
    expect(status.earningsGatePassed).toBe(true);
    expect(status.cryptoResearchUnlocked).toBe(false);
  });

  it("does not pass when one day is below the threshold", () => {
    const records = dates.map((date, index) => earning(date, index === 3 ? 1_999 : 2_000));
    expect(evaluateEarningsGate(records, now).earningsGatePassed).toBe(false);
  });

  it("sums multiple verified earnings on the same day", () => {
    const records = dates.flatMap((date) => [earning(date, 1_200), earning(date, 800)]);
    expect(evaluateEarningsGate(records, now).earningsGatePassed).toBe(true);
  });

  it("also requires the creator approval phrase", () => {
    const records = dates.map((date) => earning(date));
    const status = evaluateEarningsGate(records, now, CRYPTO_APPROVAL_PHRASE);
    expect(status.cryptoResearchUnlocked).toBe(true);
  });
});

