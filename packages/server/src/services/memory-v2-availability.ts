import type { PimErrorV2 } from "@pim/shared";

export type MemoryV2UnavailableReason =
  | "migration_failed"
  | "reconciliation_failed"
  | "admission_failed"
  | "startup_validation_failed";

export type MemoryV2Availability =
  | {
      readonly status: "ready";
      readonly reason: null;
      readonly changed_at: string;
    }
  | {
      readonly status: "unavailable";
      readonly reason: MemoryV2UnavailableReason;
      readonly changed_at: string;
    };

type MemoryV2UnavailableAvailability = Extract<
  MemoryV2Availability,
  { status: "unavailable" }
>;

let availability: MemoryV2Availability = Object.freeze({
  status: "ready",
  reason: null,
  changed_at: new Date().toISOString(),
});

function changedAt(now: Date): string {
  return now.toISOString();
}

export function getMemoryV2Availability(): MemoryV2Availability {
  return availability;
}

export function markMemoryV2Ready(now: Date = new Date()): MemoryV2Availability {
  availability = Object.freeze({
    status: "ready",
    reason: null,
    changed_at: changedAt(now),
  });
  return availability;
}

export function markMemoryV2Unavailable(
  reason: MemoryV2UnavailableReason,
  now: Date = new Date(),
): MemoryV2UnavailableAvailability {
  availability = Object.freeze({
    status: "unavailable",
    reason,
    changed_at: changedAt(now),
  });
  return availability;
}

export function memoryV2UnavailableError(
  state: MemoryV2UnavailableAvailability,
): PimErrorV2 {
  return {
    schema_version: "pim.error.v2",
    code: "temporarily_unavailable",
    message: "Memory v2 is temporarily unavailable",
    request_id: null,
    plane: null,
    retryable: true,
    details: [
      { path: "/availability/reason", reason: state.reason },
      { path: "/availability/changed_at", reason: state.changed_at },
    ],
  };
}

export interface MemoryV2StartupOperations {
  migrate: () => void;
  reconcile: () => void;
  admit: () => void;
  validate: () => void;
}

export interface MemoryV2StartupResult {
  availability: MemoryV2Availability;
  error: unknown | null;
}

/** Runs the synchronous v2-only startup chain without making the shared process fatal. */
export function initializeMemoryV2Availability(
  operations: MemoryV2StartupOperations,
): MemoryV2StartupResult {
  let failureReason: MemoryV2UnavailableReason = "migration_failed";
  try {
    operations.migrate();
    failureReason = "reconciliation_failed";
    operations.reconcile();
    failureReason = "admission_failed";
    operations.admit();
    failureReason = "startup_validation_failed";
    operations.validate();
    return { availability: markMemoryV2Ready(), error: null };
  } catch (error) {
    return {
      availability: markMemoryV2Unavailable(failureReason),
      error,
    };
  }
}
