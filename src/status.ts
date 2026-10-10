export type ShipmentStatus = "posted" | "in_transit" | "out_for_delivery" | "delivered" | "exception";
export type NormalizedStatus = ShipmentStatus | "unknown";

const DIALECT: Record<string, ShipmentStatus> = {
  posted: "posted",
  postado: "posted",
  collected: "posted",
  in_transit: "in_transit",
  "em transito": "in_transit",
  "em trânsito": "in_transit",
  transit: "in_transit",
  out_for_delivery: "out_for_delivery",
  "saiu para entrega": "out_for_delivery",
  delivered: "delivered",
  entregue: "delivered",
  exception: "exception",
  excecao: "exception",
  "exceção": "exception",
  failed: "exception",
};

// Texto que nenhuma transportadora conhecida usa vira "unknown". Unknown entra
// no histórico mas nunca muda o status atual, e nunca vira "delivered".
export function normalizeStatus(raw: string): NormalizedStatus {
  const key = raw.trim().toLowerCase().replace(/\s+/g, " ");
  return DIALECT[key] ?? "unknown";
}

export type KnownEvent = { event_id: string; occurred_at: string; status: NormalizedStatus };

// O status atual é o evento conhecido de maior occurred_at, não o último que
// chegou. Um evento atrasado do meio da viagem não faz o pacote regredir.
export function currentStatus(events: KnownEvent[]): ShipmentStatus | null {
  let best: (KnownEvent & { status: ShipmentStatus }) | null = null;
  for (const event of events) {
    if (event.status === "unknown") continue;
    const known = event as KnownEvent & { status: ShipmentStatus };
    if (
      !best ||
      Date.parse(known.occurred_at) > Date.parse(best.occurred_at) ||
      (known.occurred_at === best.occurred_at && known.event_id > best.event_id)
    ) {
      best = known;
    }
  }
  return best?.status ?? null;
}
