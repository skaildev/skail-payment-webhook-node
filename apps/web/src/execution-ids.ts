import { createHash } from "node:crypto";

/** Fixed namespace of this application: the same event id gives the same execution id here, and only here. */
export const EXECUTION_ID_NAMESPACE = "975e566d-2cea-4a3b-bf9c-e0e440a274d3";

/**
 * The event id becomes the execution id: a UUID v5 of the event id, so a resent webhook lands on the execution that
 * already exists and nothing needs to be stored to find it again.
 */
export function executionIdFromEventId(eventId: string): string {
  const namespace = Buffer.from(EXECUTION_ID_NAMESPACE.replaceAll("-", ""), "hex");
  const hash = createHash("sha1").update(namespace).update(eventId, "utf8").digest();
  hash[6] = (hash[6]! & 0x0f) | 0x50; // version 5
  hash[8] = (hash[8]! & 0x3f) | 0x80; // RFC 4122 variant
  const hex = hash.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
