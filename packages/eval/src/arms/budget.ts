/**
 * Shared context budget for the matched-budget complementarity experiment.
 *
 * The combined arm splits a 4000-char budget into 2000 chars of PIM + 2000 chars
 * of locally indexed code. To tell "the two sources interfere" apart from "the
 * useful part was clipped away", the single-source clipped arms (`pim-clipped`,
 * `lic-clipped`) receive the SAME 2000-char budget. Complementarity is then read
 * against the matched-budget singles, not the full-budget `pim-full` / `lic-full`.
 */
export const HALF_BUDGET_CHARS = 2000;

/** Truncate a rendered block to `max` chars, preserving a truncation marker. */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 40) + "\n_[truncated to matched budget]_\n";
}
