import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";
import { openDatabase } from "../src/db.ts";

const VALID = {"tracking_code": "BR1", "creator_id": "crt_ana"};

describe("entrada HTTP estrita", () => {
  let db: ReturnType<typeof openDatabase>;
  let app: ReturnType<typeof createApp>;
  beforeEach(() => {
    db = openDatabase();
    app = createApp({ db, aggregator: { register: async () => {}, events: async () => [] } });
  });
  const raw = (body: string, contentType = "application/json") =>
    app.request("/shipments", { method: "POST", headers: { "content-type": contentType }, body });
  const count = () => (db.prepare("SELECT COUNT(*) AS n FROM shipments").get() as { n: number }).n;

  it("JSON inválido é 400 e não grava nada", async () => {
    const res = await raw(JSON.stringify(VALID).slice(0, -2));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "JSON inválido" });
    expect(count()).toBe(0);
  });

  it("corpo que não é objeto é 400", async () => {
    expect((await raw(JSON.stringify([VALID]))).status).toBe(400);
    expect(count()).toBe(0);
  });

  it("corpo sem Content-Type JSON é 415; com charset é aceito", async () => {
    expect((await raw(JSON.stringify(VALID), "text/plain")).status).toBe(415);
    expect(count()).toBe(0);
    expect((await raw(JSON.stringify(VALID), "application/json; charset=utf-8")).status).toBe(201);
  });

  it("campo desconhecido é recusado com 400 e o nome do campo, sem gravar", async () => {
    const res = await raw(JSON.stringify({ ...VALID, campo_inventado: 1 }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ field: "campo_inventado" });
    expect(count()).toBe(0);
  });

  it("corpo acima de 64 KB é 413", async () => {
    const res = await raw(JSON.stringify({ ...VALID, pad: "x".repeat(70 * 1024) }));
    expect(res.status).toBe(413);
    expect(count()).toBe(0);
  });
});
