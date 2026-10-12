import { describe, expect, it } from "vitest";
import type { RawTrackingEvent, TrackingAggregator } from "../src/aggregator.ts";
import { createApp } from "../src/app.ts";
import { openDatabase } from "../src/db.ts";

class HangingAggregator implements TrackingAggregator {
  signals: AbortSignal[] = [];
  hangRegister = false;
  hangEvents = true;
  register(_code: string, signal?: AbortSignal): Promise<void> {
    if (signal) this.signals.push(signal);
    return this.hangRegister ? new Promise(() => {}) : Promise.resolve();
  }
  events(_code: string, signal?: AbortSignal): Promise<RawTrackingEvent[]> {
    if (signal) this.signals.push(signal);
    return this.hangEvents ? new Promise(() => {}) : Promise.resolve([]);
  }
}

const post = (app: ReturnType<typeof createApp>, path: string, body?: unknown) =>
  app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

describe("prazo nas chamadas ao agregador", () => {
  it("events que não responde vira 502 dentro do prazo, com o pedido abortado, e nada é gravado", async () => {
    const db = openDatabase();
    const aggregator = new HangingAggregator();
    const app = createApp({ db, aggregator, aggregatorTimeoutMs: 30 });
    const { id } = (await (await post(app, "/shipments", { tracking_code: "BR9", creator_id: "crt_ana" })).json()) as { id: string };

    const started = Date.now();
    const res = await post(app, `/shipments/${id}/sync`);
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: "agregador de rastreio indisponível" });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(aggregator.signals.at(-1)?.aborted).toBe(true);
    expect((db.prepare("SELECT COUNT(*) AS n FROM tracking_events").get() as { n: number }).n).toBe(0);
  });

  it("register que não responde vira 502 sem gravar o envio, e o retry funciona", async () => {
    const db = openDatabase();
    const aggregator = new HangingAggregator();
    aggregator.hangRegister = true;
    const app = createApp({ db, aggregator, aggregatorTimeoutMs: 30 });
    expect((await post(app, "/shipments", { tracking_code: "BR9", creator_id: "crt_ana" })).status).toBe(502);
    expect((db.prepare("SELECT COUNT(*) AS n FROM shipments").get() as { n: number }).n).toBe(0);
    aggregator.hangRegister = false;
    expect((await post(app, "/shipments", { tracking_code: "BR9", creator_id: "crt_ana" })).status).toBe(201);
  });

  it("chamada que responde a tempo não é abortada", async () => {
    const aggregator = new HangingAggregator();
    aggregator.hangEvents = false;
    const app = createApp({ db: openDatabase(), aggregator, aggregatorTimeoutMs: 1000 });
    const { id } = (await (await post(app, "/shipments", { tracking_code: "BR9", creator_id: "crt_ana" })).json()) as { id: string };
    expect((await post(app, `/shipments/${id}/sync`)).status).toBe(200);
    expect(aggregator.signals.every((signal) => !signal.aborted)).toBe(true);
  });
});
