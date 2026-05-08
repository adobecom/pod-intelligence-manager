import type { Arm } from "./types.js";
import { controlArm } from "./control.js";
import { pimFullArm } from "./pim-full.js";

export const ARMS: Arm[] = [controlArm, pimFullArm];

export function getArm(id: string): Arm {
  const arm = ARMS.find((a) => a.id === id);
  if (!arm) throw new Error(`Unknown arm: ${id}. Known: ${ARMS.map((a) => a.id).join(", ")}`);
  return arm;
}

export { controlArm, pimFullArm };
export type { Arm, SessionContextFixture } from "./types.js";
