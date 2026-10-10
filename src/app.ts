import type { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import type { Context } from "hono";
import type { TrackingAggregator } from "./aggregator.ts";
import { DEFAULT_TRANSIT_LIMIT_HOURS } from "./delay.ts";
import { createShipment, readShipment, syncShipment } from "./shipments.ts";

async function body(c: Context): Promise<Record<string, unknown>> {
  const parsed: unknown = await c.req.json().catch(() => ({}));
  return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
}

export function createApp(deps: {
  db: DatabaseSync;
  aggregator: TrackingAggregator;
  limitHours?: number;
  now?: () => Date;
}) {
  const { db, aggregator } = deps;
  const limitHours = deps.limitHours ?? DEFAULT_TRANSIT_LIMIT_HOURS;
  const now = deps.now ?? (() => new Date());
  const app = new Hono();

  app.post("/shipments", async (c) => {
    const outcome = await createShipment(db, aggregator, await body(c), now());
    return c.json(outcome.body, outcome.status);
  });

  app.post("/shipments/:id/sync", async (c) => {
    const outcome = await syncShipment(db, aggregator, c.req.param("id"), now());
    return c.json(outcome.body, outcome.status);
  });

  app.get("/shipments/:id", (c) => {
    const query = c.req.query("now");
    const at = query === undefined ? now() : new Date(query);
    if (Number.isNaN(at.getTime())) return c.json({ error: "now inválido" }, 400);
    const shipment = readShipment(db, c.req.param("id"), at, limitHours);
    return shipment ? c.json(shipment) : c.json({ error: "envio não encontrado" }, 404);
  });

  return app;
}
