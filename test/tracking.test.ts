import { describe, expect, it } from "vitest";
import type { RawTrackingEvent, TrackingAggregator } from "../src/aggregator.ts";
import { createApp } from "../src/app.ts";
import { openDatabase } from "../src/db.ts";
import { normalizeStatus } from "../src/status.ts";

class FakeAggregator implements TrackingAggregator {
  registered: string[] = [];
  feed: RawTrackingEvent[] = [];

  async register(code: string): Promise<void> {
    this.registered.push(code);
  }

  async events(): Promise<RawTrackingEvent[]> {
    return [...this.feed];
  }
}

type Shipment = {
  id: string;
  status: string | null;
  delayed: boolean;
  delay_reason: string;
  events: Array<{ id: string; raw_status: string; status: string }>;
};

async function setup(limitHours = 120) {
  const aggregator = new FakeAggregator();
  const app = createApp({ db: openDatabase(), aggregator, limitHours });
  const res = await app.request("/shipments", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tracking_code: "BR123", creator_id: "crt_ana" }),
  });
  expect(res.status).toBe(201);
  const { id } = (await res.json()) as { id: string };
  return {
    aggregator,
    sync: () => app.request(`/shipments/${id}/sync`, { method: "POST" }),
    read: async (now: string) => (await (await app.request(`/shipments/${id}?now=${now}`)).json()) as Shipment,
  };
}

describe("rastreio do produto", () => {
  it("TELEPORTADO depois de um in_transit entra no histórico e não muda o status", async () => {
    const { aggregator, sync, read } = await setup();
    aggregator.feed.push({ id: "ev_1", occurred_at: "2026-06-02T10:00:00.000Z", status: "em trânsito" });
    await sync();
    aggregator.feed.push({ id: "ev_2", occurred_at: "2026-06-02T12:00:00.000Z", status: "TELEPORTADO" });
    await sync();

    const shipment = await read("2026-06-02T13:00:00.000Z");
    expect(shipment.status).toBe("in_transit");
    expect(shipment.events.map((e) => [e.raw_status, e.status])).toEqual([
      ["em trânsito", "in_transit"],
      ["TELEPORTADO", "unknown"],
    ]);
  });

  it("in_transit de 2026-06-02 que chega depois do delivered de 2026-06-03 não faz o status regredir", async () => {
    const { aggregator, sync, read } = await setup();
    aggregator.feed.push({ id: "ev_d", occurred_at: "2026-06-03T10:00:00.000Z", status: "Entregue" });
    await sync();
    aggregator.feed.push({ id: "ev_t", occurred_at: "2026-06-02T10:00:00.000Z", status: "in_transit" });
    await sync();

    const shipment = await read("2026-06-04T00:00:00.000Z");
    expect(shipment.status).toBe("delivered");
    expect(shipment.events).toHaveLength(2);
  });

  it("dois sync com o mesmo event id deixam uma linha no histórico", async () => {
    const { aggregator, sync, read } = await setup();
    aggregator.feed.push({ id: "ev_1", occurred_at: "2026-06-01T00:00:00.000Z", status: "postado" });
    expect(await (await sync()).json()).toMatchObject({ inserted: 1, duplicates: 0 });
    expect(await (await sync()).json()).toMatchObject({ inserted: 0, duplicates: 1 });
    expect((await read("2026-06-01T01:00:00.000Z")).events).toHaveLength(1);
  });

  it("postado em 2026-06-01, ainda em trânsito 48 horas depois, limite 120h: não está atrasado", async () => {
    const { aggregator, sync, read } = await setup(120);
    aggregator.feed.push(
      { id: "ev_1", occurred_at: "2026-06-01T00:00:00.000Z", status: "postado" },
      { id: "ev_2", occurred_at: "2026-06-01T20:00:00.000Z", status: "em transito" },
    );
    await sync();
    const shipment = await read("2026-06-03T00:00:00.000Z");
    expect(shipment.status).toBe("in_transit");
    expect(shipment.delayed).toBe(false);
    expect(shipment.delay_reason).toBe("ainda dentro do limite desde a postagem");
  });

  it("o mesmo envio 121 horas depois da postagem, limite 120h: está atrasado", async () => {
    const { aggregator, sync, read } = await setup(120);
    aggregator.feed.push(
      { id: "ev_1", occurred_at: "2026-06-01T00:00:00.000Z", status: "postado" },
      { id: "ev_2", occurred_at: "2026-06-01T20:00:00.000Z", status: "em transito" },
    );
    await sync();
    const shipment = await read("2026-06-06T01:00:00.000Z");
    expect(shipment.delayed).toBe(true);
    expect(shipment.delay_reason).toContain("120h");
  });

  it("entregue dez dias depois da postagem não é marcado como atraso", async () => {
    const { aggregator, sync, read } = await setup(120);
    aggregator.feed.push(
      { id: "ev_1", occurred_at: "2026-06-01T00:00:00.000Z", status: "postado" },
      { id: "ev_2", occurred_at: "2026-06-11T00:00:00.000Z", status: "entregue" },
    );
    await sync();
    const shipment = await read("2026-06-12T00:00:00.000Z");
    expect(shipment.status).toBe("delivered");
    expect(shipment.delayed).toBe(false);
    expect(shipment.delay_reason).toBe("já foi entregue");
  });

  it("sem evento postado não há atraso e exceção não conta como atraso de trânsito", async () => {
    const { aggregator, sync, read } = await setup(120);
    expect((await read("2026-06-20T00:00:00.000Z")).delay_reason).toBe("ainda não foi postado");
    aggregator.feed.push(
      { id: "ev_1", occurred_at: "2026-06-01T00:00:00.000Z", status: "postado" },
      { id: "ev_2", occurred_at: "2026-06-02T00:00:00.000Z", status: "failed" },
    );
    await sync();
    const shipment = await read("2026-06-20T00:00:00.000Z");
    expect(shipment.status).toBe("exception");
    expect(shipment.delayed).toBe(false);
  });

  it("normaliza o dialeto das transportadoras e manda o resto para unknown", () => {
    const cases: Array<[string, string]> = [
      ["postado", "posted"],
      ["collected", "posted"],
      ["Em Trânsito", "in_transit"],
      ["transit", "in_transit"],
      ["saiu para entrega", "out_for_delivery"],
      ["ENTREGUE", "delivered"],
      ["excecao", "exception"],
      ["exceção", "exception"],
      ["failed", "exception"],
      ["TELEPORTADO", "unknown"],
      ["entregue?", "unknown"],
    ];
    for (const [raw, expected] of cases) expect([raw, normalizeStatus(raw)]).toEqual([raw, expected]);
  });
});
