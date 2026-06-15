import type { Arm } from "./types.js";
import { controlArm } from "./control.js";
import { pimFullArm } from "./pim-full.js";
import { kgOnlyArm } from "./kg-only.js";
import { kgCompactArm } from "./kg-compact.js";
import { kgLicArm } from "./kg-lic.js";
import { licFullArm } from "./lic-full.js";
import { licPimCombinedArm } from "./lic-pim-combined.js";
import { pimClippedArm, licClippedArm } from "./clipped.js";
import { serenaFullArm } from "./serena-full.js";
import { serenaPimCombinedArm } from "./serena-pim-combined.js";
import { serenaClippedArm } from "./serena-clipped.js";
import { kgSerenaArm } from "./kg-serena.js";

export const ARMS: Arm[] = [
  controlArm,
  pimFullArm,
  kgOnlyArm,
  kgCompactArm,
  licFullArm,
  licPimCombinedArm,
  kgLicArm,
  pimClippedArm,
  licClippedArm,
  serenaFullArm,
  serenaPimCombinedArm,
  serenaClippedArm,
  kgSerenaArm,
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
  kgCompactArm,
  licFullArm,
  licPimCombinedArm,
  kgLicArm,
  pimClippedArm,
  licClippedArm,
  serenaFullArm,
  serenaPimCombinedArm,
  serenaClippedArm,
  kgSerenaArm,
};
export type { Arm, FixtureLearnings, SessionContextFixture, LicContextFixture, LicIndexSource, ArmBuildInputs } from "./types.js";
