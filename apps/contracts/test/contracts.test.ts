import { describe, expect, it } from "vitest";
import { PaymentResults, isTerminal, money, sameAmount, stateOfResult } from "../src/index.js";

describe("contracts", () => {
  it("compares amounts in cents", () => {
    expect(sameAmount(99.9, 99.9)).toBe(true);
    expect(sameAmount(0.1 + 0.2, 0.3)).toBe(true);
    expect(sameAmount(200, 250)).toBe(false);
    expect(sameAmount(99.9, 99.91)).toBe(false);
  });

  it("writes money with two decimals", () => {
    expect(money(99.9)).toBe("R$ 99.90");
    expect(money(250)).toBe("R$ 250.00");
  });

  it("tells a review from a release by the result text", () => {
    expect(stateOfResult(PaymentResults.released)).toBe("Released");
    expect(stateOfResult(PaymentResults.pending("no invoice for order P-9"))).toBe("Pending");
    expect(stateOfResult(undefined)).toBe("Released");
  });

  it("knows the terminal states", () => {
    expect(["Released", "Pending", "Failed"].every((s) => isTerminal(s as never))).toBe(true);
    expect(["Received", "NotAccepted", "Running"].some((s) => isTerminal(s as never))).toBe(false);
  });
});
