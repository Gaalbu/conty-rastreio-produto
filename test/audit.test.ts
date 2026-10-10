import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { RawTrackingEvent, TrackingAggregator } from "../src/aggregator.ts";
import { createApp } from "../src/app.ts";
import { openDatabase } from "../src/db.ts";

class FakeAggregator implements TrackingAggregator {
  registered: string[] = [];
  feed: RawTrackingEvent[] = [];
  registerEffect: () => Promise<void> = async () => {};

  async register(code: string): Promise<void> {
    this.registered.push(code);
    await this.registerEffect();
  }

  async events(): Promise<RawTrackingEvent[]> {
    return [...this.feed];
  }
}

const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

function setup(limitHours = 120) {
  const db = openDatabase();
  databases.push(db);
  const aggregator = new FakeAggregator();
  const app = createApp({
    db,
    aggregator,
    limitHours,
    now: () => new Date("2026-06-03T00:00:00.000Z"),
  });
  const create = (creatorId = "crt_ana") => app.request("/shipments", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tracking_code: "BR123", creator_id: creatorId }),
  });
  const sync = (id: string) => app.request(`/shipments/${id}/sync`, { method: "POST" });
  const read = (id: string) => app.request(`/shipments/${id}`);
  return { db, aggregator, create, sync, read };
}

async function shipmentId(create: () => Response | Promise<Response>): Promise<string> {
  const response = await create();
  expect(response.status).toBe(201);
  return ((await response.json()) as { id: string }).id;
}

describe("regressões da auditoria de rastreio", () => {
  it.each(["constructor", "__proto__"])("preserva %s como unknown sem perder o restante do lote", async (rawStatus) => {
    const { aggregator, create, sync, read } = setup();
    const id = await shipmentId(create);
    aggregator.feed = [
      { id: "ev_posted", occurred_at: "2026-06-01T00:00:00Z", status: "postado" },
      { id: "ev_unknown", occurred_at: "2026-06-02T00:00:00Z", status: rawStatus },
    ];

    expect((await sync(id)).status).toBe(200);
    expect(await (await read(id)).json()).toMatchObject({
      status: "posted",
      events: [
        { id: "ev_posted", raw_status: "postado", status: "posted" },
        { id: "ev_unknown", raw_status: rawStatus, status: "unknown" },
      ],
    });
  });
});
