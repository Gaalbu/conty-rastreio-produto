import { expect, it } from "vitest";
import { createApp } from "../src/app.ts";
import { openDatabase } from "../src/db.ts";

it("rota inexistente responde 404 em JSON", async () => {
  const app = createApp({ db: openDatabase(), aggregator: { register: async () => {}, events: async () => [] } });
  const res = await app.request("/nao-existe");
  expect(res.status).toBe(404);
  expect(await res.json()).toEqual({ error: "rota não encontrada" });
});
