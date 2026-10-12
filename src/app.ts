import type { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { body, BodyError, MAX_BODY_BYTES } from "./body.ts";
import { listAlerts, runDelayCheck } from "./alerts.ts";
import { DEFAULT_AGGREGATOR_TIMEOUT_MS, withDeadline } from "./aggregator.ts";
import type { TrackingAggregator } from "./aggregator.ts";
import { DEFAULT_TRANSIT_LIMIT_HOURS } from "./delay.ts";
import { createShipment, readShipment, syncShipment } from "./shipments.ts";

export function createApp(deps: {
  db: DatabaseSync;
  aggregator: TrackingAggregator;
  limitHours?: number;
  now?: () => Date;
  aggregatorTimeoutMs?: number;
}) {
  const { db } = deps;
  const aggregator = withDeadline(deps.aggregator, deps.aggregatorTimeoutMs ?? DEFAULT_AGGREGATOR_TIMEOUT_MS);
  const limitHours = deps.limitHours ?? DEFAULT_TRANSIT_LIMIT_HOURS;
  const now = deps.now ?? (() => new Date());
  const app = new Hono();

  app.use("*", bodyLimit({ maxSize: MAX_BODY_BYTES, onError: (c) => c.json({ error: "corpo acima de 64 KB" }, 413) }));
  app.onError((error, c) => {
    if (error instanceof BodyError) return c.json(error.payload, error.status);
    // Erro inesperado: 500 em JSON genérico, sem stack na resposta; o detalhe vai para o log.
    console.error(error);
    return c.json({ error: "erro interno" }, 500);
  });

  app.post("/shipments", async (c) => {
    const outcome = await createShipment(db, aggregator, await body(c, ["tracking_code", "creator_id"]), now());
    return c.json(outcome.body, outcome.status);
  });

  app.post("/shipments/:id/sync", async (c) => {
    const outcome = await syncShipment(db, aggregator, c.req.param("id"), now(), limitHours);
    return c.json(outcome.body, outcome.status);
  });

  app.post("/delay-checks", (c) => {
    const query = c.req.query("now");
    const at = query === undefined ? now() : new Date(query);
    if (Number.isNaN(at.getTime())) return c.json({ error: "now inválido" }, 400);
    return c.json(runDelayCheck(db, at, limitHours));
  });

  app.get("/alerts", (c) => {
    const include = c.req.query("include_resolved") ?? "false";
    if (include !== "true" && include !== "false") return c.json({ error: "include_resolved deve ser true ou false" }, 400);
    return c.json({ alerts: listAlerts(db, include === "true") });
  });

  app.get("/shipments/:id", (c) => {
    const query = c.req.query("now");
    const at = query === undefined ? now() : new Date(query);
    if (Number.isNaN(at.getTime())) return c.json({ error: "now inválido" }, 400);
    const shipment = readShipment(db, c.req.param("id"), at, limitHours);
    return shipment ? c.json(shipment) : c.json({ error: "envio não encontrado" }, 404);
  });

  app.notFound((c) => c.json({ error: "rota não encontrada" }, 404));

  return app;
}
