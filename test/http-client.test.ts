import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";
import { openDatabase } from "../src/db.ts";
import { AggregatorResponseError, HttpTrackingAggregator } from "../src/http-aggregator.ts";

// Agregador falso servido por HTTP de verdade em 127.0.0.1, sem rede externa.
type Reply = { status: number; type?: string; body: string };
let server: Server | undefined;
let requests: Array<{ method: string; url: string; body: string }> = [];

async function serve(reply: (method: string, url: string) => Reply): Promise<string> {
  requests = [];
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      requests.push({ method: req.method ?? "", url: req.url ?? "", body });
      const r = reply(req.method ?? "", req.url ?? "");
      res.writeHead(r.status, { "content-type": r.type ?? "application/json" });
      res.end(r.body);
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
}

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

const json = (status: number, value: unknown): Reply => ({ status, body: JSON.stringify(value) });

describe("cliente HTTP do agregador", () => {
  it("cadastra o código e lê os eventos no formato do agregador", async () => {
    const base = await serve((method) =>
      method === "POST"
        ? json(201, { tracking_code: "BR123" })
        : json(200, { tracking_code: "BR123", events: [{ id: "ev_1", occurred_at: "2026-06-01T09:00:00Z", status: "Postado" }] }),
    );
    const client = new HttpTrackingAggregator(base);
    await client.register("BR123");
    expect(await client.events("BR123")).toEqual([{ id: "ev_1", occurred_at: "2026-06-01T09:00:00Z", status: "Postado" }]);
    expect(requests.map((r) => `${r.method} ${r.url}`)).toEqual(["POST /trackers", "GET /trackers/BR123/events"]);
    expect(JSON.parse(requests[0]!.body)).toEqual({ tracking_code: "BR123" });
  });

  it.each([
    ["HTML no lugar de JSON", { status: 200, type: "text/html", body: "<html>erro</html>" }],
    ["HTTP 500", json(500, { error: "fora do ar" })],
    ["eventos de outro código", json(200, { tracking_code: "OUTRO", events: [] })],
    ["events que não é lista", json(200, { tracking_code: "BR123", events: "nada" })],
  ])("resposta inválida (%s) vira AggregatorResponseError", async (_name, reply) => {
    const base = await serve(() => reply as Reply);
    await expect(new HttpTrackingAggregator(base).events("BR123")).rejects.toBeInstanceOf(AggregatorResponseError);
  });

  it("pela API, cadastro e sync usam o cliente HTTP, e agregador fora do ar dá 502 sem gravar", async () => {
    let down = false;
    const base = await serve((method) =>
      down
        ? json(503, { error: "manutenção" })
        : method === "POST"
          ? json(201, { tracking_code: "BR7" })
          : json(200, { tracking_code: "BR7", events: [{ id: "e1", occurred_at: "2026-06-01T00:00:00Z", status: "entregue" }] }),
    );
    const db = openDatabase();
    const app = createApp({ db, aggregator: new HttpTrackingAggregator(base) });
    const post = (path: string, body?: unknown) =>
      app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

    const created = await post("/shipments", { tracking_code: "BR7", creator_id: "crt_ana" });
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };
    expect(await (await post(`/shipments/${id}/sync`)).json()).toMatchObject({ status: "delivered", inserted: 1 });

    down = true;
    expect((await post(`/shipments/${id}/sync`)).status).toBe(502);
    expect((await post("/shipments", { tracking_code: "BR8", creator_id: "crt_ana" })).status).toBe(502);
    expect((db.prepare("SELECT COUNT(*) AS n FROM shipments").get() as { n: number }).n).toBe(1);
  });
});
