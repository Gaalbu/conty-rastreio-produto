import { describe, expect, it } from "vitest";
import type { RawTrackingEvent } from "../src/aggregator.ts";
import { createApp } from "../src/app.ts";
import { openDatabase } from "../src/db.ts";

function setup() {
  const feed: RawTrackingEvent[] = [];
  const app = createApp({ db: openDatabase(), aggregator: { register: async () => {}, events: async () => [...feed] }, limitHours: 120 });
  const post = (path: string, body?: unknown) =>
    app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { app, feed, post };
}

describe("aviso de atraso", () => {
  it("1 ms antes do limite não avisa; 1 ms depois avisa uma vez só, mesmo rodando a checagem de novo", async () => {
    const { app, feed, post } = setup();
    const { id } = (await (await post("/shipments", { tracking_code: "BR1", creator_id: "crt_ana" })).json()) as { id: string };
    feed.push({ id: "e1", occurred_at: "2026-06-01T00:00:00.000Z", status: "postado" });
    await post(`/shipments/${id}/sync`);

    expect(await (await post("/delay-checks?now=2026-06-05T23:59:59.999Z")).json()).toMatchObject({ new_alerts: 0 });
    expect(await (await post("/delay-checks?now=2026-06-06T00:00:00.001Z")).json()).toMatchObject({ new_alerts: 1 });
    expect(await (await post("/delay-checks?now=2026-06-07T00:00:00.000Z")).json()).toMatchObject({ new_alerts: 0 });

    const alerts = (await (await app.request("/alerts")).json()) as { alerts: Array<{ shipment_id: string; alerted_at: string }> };
    expect(alerts.alerts).toEqual([expect.objectContaining({ shipment_id: id, alerted_at: "2026-06-06T00:00:00.001Z" })]);
  });

  it("entrega depois do alerta encerra o aviso; entrega normal dentro do limite nunca avisa", async () => {
    const { app, feed, post } = setup();
    const late = ((await (await post("/shipments", { tracking_code: "BR1", creator_id: "crt_ana" })).json()) as { id: string }).id;
    feed.push({ id: "e1", occurred_at: "2026-06-01T00:00:00.000Z", status: "postado" });
    await post(`/shipments/${late}/sync`);
    await post("/delay-checks?now=2026-06-07T00:00:00.000Z");

    feed.push({ id: "e2", occurred_at: "2026-06-07T10:00:00.000Z", status: "entregue" });
    await post(`/shipments/${late}/sync`);
    expect(await (await post("/delay-checks?now=2026-06-08T00:00:00.000Z")).json()).toMatchObject({ resolved: 1 });
    expect(((await (await app.request("/alerts")).json()) as { alerts: unknown[] }).alerts).toEqual([]);
    const all = (await (await app.request("/alerts?include_resolved=true")).json()) as { alerts: Array<{ resolved_at: string }> };
    expect(all.alerts[0]?.resolved_at).toBe("2026-06-08T00:00:00.000Z");
  });

  it("now inválido e include_resolved fora de true/false dão 400", async () => {
    const { app, post } = setup();
    expect((await post("/delay-checks?now=ontem")).status).toBe(400);
    expect((await app.request("/alerts?include_resolved=talvez")).status).toBe(400);
  });
});
