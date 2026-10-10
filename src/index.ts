import { serve } from "@hono/node-server";
import type { RawTrackingEvent, TrackingAggregator } from "./aggregator.ts";
import { createApp } from "./app.ts";
import { openDatabase } from "./db.ts";
import { DEFAULT_TRANSIT_LIMIT_HOURS } from "./delay.ts";

// Demo: uma viagem curta, no dialeto de uma transportadora fictícia.
const trip: RawTrackingEvent[] = [
  { id: "ev_1", occurred_at: "2026-06-01T09:00:00.000Z", status: "Postado" },
  { id: "ev_2", occurred_at: "2026-06-02T14:00:00.000Z", status: "Em trânsito" },
  { id: "ev_3", occurred_at: "2026-06-03T08:00:00.000Z", status: "Saiu para entrega" },
  { id: "ev_4", occurred_at: "2026-06-03T16:30:00.000Z", status: "Entregue" },
];

const demoAggregator: TrackingAggregator = {
  async register() {},
  async events() {
    return trip;
  },
};

const limit = Number(process.env.TRANSIT_LIMIT_HOURS);
const port = Number(process.env.PORT ?? 43125);
const app = createApp({
  db: openDatabase(),
  aggregator: demoAggregator,
  limitHours: Number.isFinite(limit) && limit > 0 ? limit : DEFAULT_TRANSIT_LIMIT_HOURS,
});

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`rastreio em http://127.0.0.1:${info.port}`);
});
