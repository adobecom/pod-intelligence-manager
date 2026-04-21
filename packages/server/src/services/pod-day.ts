/**
 * Compute the current sprint day for a pod.
 *
 * Previously `pods.day_number` was written once at pod creation and never
 * auto-advanced — living doc and UI always showed "Day 1 of N". Rather than
 * run a daily cron to mutate every row, every read path normalizes through
 * this helper.
 *
 * Returns 1-indexed day within [1, totalDays]; clamps early (sprint hasn't
 * started) and late (sprint is over) to the boundaries.
 */
export function computeCurrentDay(sprintStart: string, totalDays: number, now: Date = new Date()): number {
  if (!sprintStart || !totalDays || totalDays < 1) return 1;
  const startMs = Date.parse(sprintStart);
  if (Number.isNaN(startMs)) return 1;
  const elapsedMs = now.getTime() - startMs;
  const day = Math.floor(elapsedMs / 86_400_000) + 1;
  if (day < 1) return 1;
  if (day > totalDays) return totalDays;
  return day;
}
