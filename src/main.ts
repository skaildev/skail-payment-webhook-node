import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { createSkailPlatform } from "@skail/runtime";
import { demoPayments, type DemoPayment } from "./demo-payments.js";
import { runIdFromEventId } from "./run-ids.js";
import { SimulatedStore, money } from "./simulated-store.js";
import { SkailApiClient, skailApiOptionsFromEnvironment } from "./skail-api.js";

// usage: npm start [-- released | amount | paid | missing]
//   no argument: one payment per path; a path: only that payment
const argument = process.argv
  .slice(2)
  .find((a) => !a.startsWith("-"))
  ?.toLowerCase();
const payments: readonly DemoPayment[] =
  argument === undefined ? demoPayments : demoPayments.filter((p) => p.path === argument);
if (payments.length === 0) {
  console.error(`Unknown argument '${argument}'. Use ${demoPayments.map((p) => p.path).join(", ")}.`);
  process.exit(1);
}

loadDotEnv();
const missing = ["SKAIL_WORKLOAD", "SKAIL_NAMESPACE", "SKAIL_KEY", "SKAIL_SIDECAR"].filter(
  (n) => !process.env[n]?.trim(),
);
if (missing.length > 0) {
  console.error(`Missing ${missing.join(", ")}. Copy .env.example to .env and fill it in.`);
  process.exit(1);
}

// the commands run in an isolated VM and reach the demo store over HTTP; the address goes in the environment before
// the worker starts, so the commands can read it
process.env.DEMO_STORE_URL = await new SimulatedStore().listen();

// hosts the worker that executes PaymentFunctions (the bundle from `npm run build`);
// reads SKAIL_WORKLOAD, SKAIL_NAMESPACE, SKAIL_KEY and SKAIL_SIDECAR from the environment
const platform = createSkailPlatform({
  bundle: new URL("../.skail/skail-functions.mjs", import.meta.url),
  manifest: new URL("../.skail/manifest.json", import.meta.url),
});

const shutdown = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => shutdown.abort());
const worker = platform.run(shutdown.signal);

// plays the payment gateway and the webhook endpoint: each delivery of an event starts ReleaseOrder with the run id
// derived from the event id, so a resend does not start a second run
const skail = new SkailApiClient(skailApiOptionsFromEnvironment());
try {
  for (const demo of payments) {
    // a new event id per run of the app, so a new demo does not land on the runs of the previous one
    const payment = { eventId: `evt_${randomUUID().slice(0, 8)}`, orderId: demo.orderId, amount: demo.amount };
    const runId = runIdFromEventId(payment.eventId);

    for (let send = 1; send <= demo.sends; send++) {
      if (send > 1) await sleep(2000); // the gateway resends later
      await skail.trigger(runId, payment);
      console.log(
        send === 1
          ? `[${payment.eventId}] webhook: order ${payment.orderId}, ${money(payment.amount)} → run ${runId.slice(0, 8)} ` +
              `(expected: ${demo.expected})`
          : `[${payment.eventId}] webhook resent (${send}×) → run ${runId.slice(0, 8)}, the same run`,
      );
    }
  }
  console.log("Press Ctrl+C to exit.");
} catch (error) {
  console.error(`Could not start the runs: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
  shutdown.abort();
}

await worker;

/** Loads .env from the current directory, when present. Variables already set in the environment win. */
function loadDotEnv(): void {
  try {
    process.loadEnvFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
