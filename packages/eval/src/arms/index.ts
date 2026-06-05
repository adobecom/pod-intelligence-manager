import type { Arm } from "./types.js";
import { controlArm } from "./control.js";
import { pimFullArm } from "./pim-full.js";
import { kgOnlyArm } from "./kg-only.js";
import { kgLicArm } from "./kg-lic.js";
import { lengthMatchedNeutralArm } from "./neutral.js";
import { licFullArm } from "./lic-full.js";
import { licPimCombinedArm } from "./lic-pim-combined.js";
import { pimClippedArm, licClippedArm } from "./clipped.js";

export const ARMS: Arm[] = [
  controlArm,
  pimFullArm,
  kgOnlyArm,
  licFullArm,
  licPimCombinedArm,
  lengthMatchedNeutralArm,
  kgLicArm,
  pimClippedArm,
  licClippedArm,
];

export function getArm(id: string): Arm {
  const arm = ARMS.find((a) => a.id === id);
  if (!arm) throw new Error(`Unknown arm: ${id}. Known: ${ARMS.map((a) => a.id).join(", ")}`);
  return arm;
}

export {
  controlArm,
  pimFullArm,
  kgOnlyArm,
  licFullArm,
  licPimCombinedArm,
  lengthMatchedNeutralArm,
  kgLicArm,
  pimClippedArm,
  licClippedArm,
};
export type { Arm, FixtureLearnings, SessionContextFixture, LicContextFixture, LicIndexSource, ArmBuildInputs } from "./types.js";
