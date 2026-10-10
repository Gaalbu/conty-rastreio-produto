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
  it("sync e GET aplicam o mesmo limite de 24 horas a um envio postado há 48 horas", async () => {
    const { aggregator, create, sync, read } = setup(24);
    const id = await shipmentId(create);
    aggregator.feed = [
      { id: "ev_posted", occurred_at: "2026-06-01T00:00:00Z", status: "postado" },
      { id: "ev_transit", occurred_at: "2026-06-02T00:00:00Z", status: "em trânsito" },
    ];

    const response = await sync(id);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "in_transit", delayed: true });
    expect(await (await read(id)).json()).toMatchObject({ status: "in_transit", delayed: true });
  });
  it("cadastros concorrentes do mesmo dono convergem para um envio e um registro externo", async () => {
    const { db, aggregator, create } = setup();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    aggregator.registerEffect = () => gate;

    const first = create();
    const second = create();
    // Dá às duas rotas a chance de chegar ao await externo. Não espera duas
    // chamadas: a implementação corrigida deve chegar ao agregador só uma vez.
    for (let turn = 0; turn < 50; turn += 1) await Promise.resolve();
    release();
    const responses = await Promise.all([first, second]);

    expect(responses.map((response) => response.ok)).toEqual([true, true]);
    const bodies = await Promise.all(responses.map((response) => response.json())) as Array<{ id: string }>;
    expect(bodies[0].id).toBeTruthy();
    expect(bodies[1].id).toBe(bodies[0].id);
    expect(aggregator.registered).toEqual(["BR123"]);
    expect(db.prepare("SELECT COUNT(*) AS count FROM shipments").get()).toMatchObject({ count: 1 });
  });
  it("permite retry depois que o agregador falha no primeiro cadastro", async () => {
    const { db, aggregator, create, read } = setup();
    aggregator.registerEffect = async () => { throw new Error("agregador indisponível"); };
    expect((await create()).ok).toBe(false);
    aggregator.registerEffect = async () => {};

    const retry = await create();
    expect(retry.ok).toBe(true);
    const { id } = (await retry.json()) as { id: string };
    expect((await read(id)).status).toBe(200);
    expect(aggregator.registered).toEqual(["BR123", "BR123"]);
    expect(db.prepare("SELECT COUNT(*) AS count FROM shipments").get()).toMatchObject({ count: 1 });
  });
  it("recusa o mesmo código para outro dono sem alterar o envio existente", async () => {
    const { db, aggregator, create, read } = setup();
    const id = await shipmentId(create);
    const before = db.prepare("SELECT * FROM shipments").all();

    expect((await create("crt_bia")).status).toBe(409);
    expect(db.prepare("SELECT * FROM shipments").all()).toEqual(before);
    expect(await (await read(id)).json()).toMatchObject({ creator_id: "crt_ana" });
    expect(aggregator.registered).toEqual(["BR123"]);
  });
});
