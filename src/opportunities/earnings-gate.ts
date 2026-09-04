export const MINIMUM_DAILY_EARNINGS_CENTS = 2_000;
export const REQUIRED_QUALIFYING_DAYS = 7;
export const CRYPTO_APPROVAL_PHRASE = "LAMUH_APPROVES_CRYPTO_RESEARCH";

export interface VerifiedEarning {
  id: string;
  date: string;
  amountCents: number;
  source: string;
  evidence: string;
  creatorVerified: true;
  recordedAt: string;
}

export interface EarningsGateStatus {
  minimumDailyEarningsCents: number;
  requiredQualifyingDays: number;
  qualifyingDates: string[];
  dailyTotalsCents: Record<string, number>;
  earningsGatePassed: boolean;
  creatorApprovalPresent: boolean;
  cryptoResearchUnlocked: boolean;
}

export function evaluateEarningsGate(
  records: VerifiedEarning[],
  now = new Date(),
  approval = process.env.AUTOMATON_CRYPTO_APPROVAL,
): EarningsGateStatus {
  const dailyTotalsCents: Record<string, number> = {};
  for (const record of records) {
    if (!record.creatorVerified || !/^\d{4}-\d{2}-\d{2}$/.test(record.date)) continue;
    if (!Number.isSafeInteger(record.amountCents) || record.amountCents <= 0) continue;
    dailyTotalsCents[record.date] = (dailyTotalsCents[record.date] || 0) + record.amountCents;
  }

  const qualifyingDates = requiredCalendarDates(now, REQUIRED_QUALIFYING_DAYS);
  const earningsGatePassed = qualifyingDates.every(
    (date) => (dailyTotalsCents[date] || 0) >= MINIMUM_DAILY_EARNINGS_CENTS,
  );
  const creatorApprovalPresent = approval === CRYPTO_APPROVAL_PHRASE;

  return {
    minimumDailyEarningsCents: MINIMUM_DAILY_EARNINGS_CENTS,
    requiredQualifyingDays: REQUIRED_QUALIFYING_DAYS,
    qualifyingDates,
    dailyTotalsCents,
    earningsGatePassed,
    creatorApprovalPresent,
    cryptoResearchUnlocked: earningsGatePassed && creatorApprovalPresent,
  };
}

export function requiredCalendarDates(now: Date, days: number): string[] {
  const dates: string[] = [];
  const cursor = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12);
  for (let offset = days - 1; offset >= 0; offset--) {
    const date = new Date(cursor);
    date.setDate(cursor.getDate() - offset);
    dates.push(formatLocalDate(date));
  }
  return dates;
}

export function formatLocalDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

