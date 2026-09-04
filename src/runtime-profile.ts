export const DEFAULT_IDLE_SLEEP_MS = 15 * 60_000;

export function getIdleSleepMs(value = process.env.AUTOMATON_IDLE_SLEEP_MS): number {
  const parsed = Number(value || DEFAULT_IDLE_SLEEP_MS);
  if (!Number.isSafeInteger(parsed) || parsed < 60_000 || parsed > 24 * 60 * 60_000) {
    return DEFAULT_IDLE_SLEEP_MS;
  }
  return parsed;
}
