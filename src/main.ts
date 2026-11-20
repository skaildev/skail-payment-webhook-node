import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { createSkailPlatform } from "@skail/runtime";
import { PaymentDesk } from "./payment-desk.js";
import { SimulatedStore } from "./simulated-store.js";
import { SkailApiClient, skailApiOptionsFromEnvironment } from "./skail-api.js";
import { Timeline } from "./timeline.js";

// usage: npm start
//   then open http://localhost:8080
if (process.argv.slice(2).some((a) => !a.startsWith("-"))) {
  console.error("This demo takes no arguments.");
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

const timeline = new Timeline();
const store = new SimulatedStore(timeline);
const desk = new PaymentDesk(store, new SkailApiClient(skailApiOptionsFromEnvironment()), timeline);

const page = readFileSync(new URL("../page/index.html", import.meta.url));
const port = Number(process.env.DEMO_PORT ?? 8080);
// the page: localhost only, unless DEMO_HOST says otherwise (the container listens on all interfaces)
const host = process.env.DEMO_HOST ?? "127.0.0.1";

// the page, its API, and under /internal/ the demo store and the timeline, which the commands call
const server = createServer(async (request, response) => {
  const send = (status: number, body?: unknown) =>
    response
      .writeHead(status, { "content-type": "application/json" })
      .end(body === undefined ? "" : JSON.stringify(body));
  try {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (request.method === "GET" && url.pathname === "/")
      return void response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page);
    if (request.method === "GET" && url.pathname === "/api/state") return send(200, desk.view());
    if (request.method === "POST" && url.pathname === "/api/reset") {
      desk.reset();
      return send(200);
    }

    const payment = /^\/api\/payments\/(\w+)(\/again)?$/.exec(url.pathname);
    if (request.method === "POST" && payment) {
      const done = payment[2] ? await desk.sendAgain(payment[1]!) : await desk.send(payment[1]!);
      return send(done ? 200 : 409);
    }

    if (request.method === "POST" && url.pathname.startsWith("/internal/")) {
      let body = "";
      for await (const chunk of request) body += chunk;
      const data = JSON.parse(body || "{}");
      const route = url.pathname.slice("/internal/".length);
      if (route === "timeline") {
        timeline.add(data.runId, data.text, data.step);
        return send(200);
      }
      return send(200, store.call(route.replace(/^store\//, ""), data) ?? null);
    }
    send(404);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    response.writeHead(500).end(message);
  }
});
await new Promise<void>((resolve) => server.listen(port, host, resolve));

// the commands run in an isolated VM and call the app over HTTP; the address goes in the environment before the worker
// starts
process.env.DEMO_INTERNAL_URL = `http://127.0.0.1:${port}`;

// hosts the worker that executes PaymentFunctions (the bundle from `npm run build`);
// reads SKAIL_WORKLOAD, SKAIL_NAMESPACE, SKAIL_KEY and SKAIL_SIDECAR from the environment
const platform = createSkailPlatform({
  bundle: new URL("../.skail/skail-functions.mjs", import.meta.url),
  manifest: new URL("../.skail/manifest.json", import.meta.url),
});

const shutdown = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    server.close();
    shutdown.abort();
  });
}
const worker = platform.run(shutdown.signal);
console.log(`Open http://localhost:${port} to send payments and resend them. Ctrl+C exits.`);
await worker;

/** Loads .env from the current directory, when present. Variables already set in the environment win. */
function loadDotEnv(): void {
  try {
    process.loadEnvFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
