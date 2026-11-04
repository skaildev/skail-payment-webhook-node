import fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import type {
  EventStatus,
  MarkPaidRequest,
  PaymentConfirmed,
  ReviewRequest,
  ReleaseRequest,
  StateView,
} from "@skail-payment-webhook/contracts";
import { AlreadyPaidByAnother } from "@skail-payment-webhook/contracts";
import { executionIdFromEventId } from "./execution-ids.js";
import { SkailGatewayError, type SkailGateway } from "./gateway.js";
import type { PaymentStore } from "./payment-store.js";

export interface AppOptions {
  store: PaymentStore;
  gateway: SkailGateway;
  /** Directory with the built front end (index.html + assets). Optional: tests do not need it. */
  staticDir?: string;
}

const blank = (value: unknown) => typeof value !== "string" || value.trim() === "";

export function createApp({ store, gateway, staticDir }: AppOptions): FastifyInstance {
  const app = fastify({ bodyLimit: 1024 * 1024 });

  app.get("/healthz", async () => "ok");

  // The endpoint the payment gateway calls (the page calls this same one). The event id becomes the execution id.
  app.post<{ Body: Partial<PaymentConfirmed> | null }>("/webhooks/payments", async (request, reply) => {
    // In production, first validate the signature the gateway sends in the header.
    const body = request.body;
    if (!body || blank(body.eventId) || blank(body.orderId) || typeof body.amount !== "number") {
      return reply.code(400).send({ error: "eventId, orderId and amount are required" });
    }
    const payment: PaymentConfirmed = { eventId: body.eventId!, orderId: body.orderId!, amount: body.amount };

    const taskId = executionIdFromEventId(payment.eventId); // same event => same execution id
    store.recordDelivery(payment, taskId);
    try {
      await gateway.trigger(taskId, payment);
    } catch (error) {
      if (!(error instanceof SkailGatewayError)) throw error;
      // If skail did not accept it, answer with an error: the gateway resends later and the resend lands on the same execution.
      store.markNotAccepted(payment.eventId);
      return reply.code(502).send({ taskId, error: "skail unavailable, resend" });
    }

    store.markAccepted(payment.eventId);
    return { taskId };
  });

  app.get("/api/state", async () => store.snapshot());

  app.post("/api/reset", async (_request, reply) => {
    store.reset();
    return reply.code(204).send();
  });

  app.get("/api/stream", (request, reply) => {
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    const send = (state: StateView) => raw.write(`data: ${JSON.stringify(state)}\n\n`);

    // subscribe before sending the snapshot: no update is lost
    const unsubscribe = store.subscribe(send);
    raw.on("close", unsubscribe);
    send(store.snapshot());
  });

  // ---- called by the worker: the demo "database" ---------------------------------------------------------------

  app.get<{ Params: { orderId: string } }>("/internal/invoices/:orderId", async (request, reply) => {
    const invoice = store.getInvoice(request.params.orderId);
    return invoice ?? reply.code(404).send();
  });

  app.post<{ Params: { orderId: string }; Body: MarkPaidRequest }>(
    "/internal/invoices/:orderId/paid",
    async (request, reply) => {
      switch (store.markPaid(request.params.orderId, request.body.eventId)) {
        case "ok":
          return reply.code(204).send();
        case "notFound":
          return reply.code(404).send();
        case "paidByAnother":
          return reply.code(409).send({ error: AlreadyPaidByAnother });
      }
    },
  );

  app.post<{ Params: { orderId: string }; Body: ReleaseRequest }>(
    "/internal/orders/:orderId/release",
    async (request, reply) => {
      store.release(request.params.orderId, request.body.eventId);
      return reply.code(204).send();
    },
  );

  app.post<{ Body: ReviewRequest }>("/internal/reviews", async (request, reply) => {
    store.addReview(request.body);
    return reply.code(204).send();
  });

  app.post<{ Params: { eventId: string }; Body: EventStatus }>(
    "/internal/events/:eventId/status",
    async (request, reply) => {
      store.applyStatus({ ...request.body, eventId: request.params.eventId });
      return reply.code(204).send();
    },
  );

  if (staticDir) app.register(fastifyStatic, { root: staticDir });

  return app;
}
