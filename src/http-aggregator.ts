import type { RawTrackingEvent, TrackingAggregator } from "./aggregator.ts";

// Cliente HTTP do agregador fictício. Contrato do agregador:
//   POST {base}/trackers                 {"tracking_code": "BR123"}
//   GET  {base}/trackers/{code}/events   {"tracking_code": "BR123", "events": [{id, occurred_at, status}]}
// O formato do agregador para aqui: o resto do código só vê RawTrackingEvent.
// Resposta fora do contrato vira AggregatorResponseError, que a API traduz em 502.

export class AggregatorResponseError extends Error {}

async function readJson(response: Response, operation: string): Promise<unknown> {
  if (!response.ok) throw new AggregatorResponseError(`${operation}: agregador respondeu HTTP ${response.status}`);
  if (!/^application\/json\b/i.test(response.headers.get("content-type") ?? "")) {
    throw new AggregatorResponseError(`${operation}: resposta não é JSON`);
  }
  try {
    return await response.json();
  } catch {
    throw new AggregatorResponseError(`${operation}: JSON inválido`);
  }
}

export class HttpTrackingAggregator implements TrackingAggregator {
  constructor(private readonly baseUrl: string) {}

  async register(code: string, signal?: AbortSignal): Promise<void> {
    const response = await fetch(new URL("/trackers", this.baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tracking_code: code }),
      signal,
    });
    const body = (await readJson(response, "register")) as { tracking_code?: unknown };
    if (body?.tracking_code !== code) throw new AggregatorResponseError("register: agregador devolveu outro código");
  }

  async events(code: string, signal?: AbortSignal): Promise<RawTrackingEvent[]> {
    const response = await fetch(new URL(`/trackers/${encodeURIComponent(code)}/events`, this.baseUrl), { signal });
    const body = (await readJson(response, "events")) as { tracking_code?: unknown; events?: unknown };
    if (body?.tracking_code !== code) throw new AggregatorResponseError("events: agregador devolveu outro código");
    if (!Array.isArray(body.events)) throw new AggregatorResponseError("events: campo events não é uma lista");
    // A validação item a item é do sync (validateBatch), igual para qualquer agregador.
    return body.events as RawTrackingEvent[];
  }
}
