import { describe, expect, it } from "vitest";
import { executionIdFromEventId } from "../src/execution-ids.js";

describe("executionIdFromEventId", () => {
  it("gives the same execution id for the same event id", () => {
    expect(executionIdFromEventId("evt_1")).toBe(executionIdFromEventId("evt_1"));
  });

  it("gives different execution ids for different event ids", () => {
    expect(executionIdFromEventId("evt_1")).not.toBe(executionIdFromEventId("evt_2"));
  });

  it("is the UUID v5 of the event id in the application namespace", () => {
    expect(executionIdFromEventId("evt_1")).toBe("25679aad-4e35-5329-a02b-5223f8bc34f2");
    expect(executionIdFromEventId("evt_ação")).toBe("a39cdf55-66a3-5499-9c96-a3c2916d3c7b");
  });
});
