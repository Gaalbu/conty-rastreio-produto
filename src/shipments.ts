import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { TrackingAggregator } from "./aggregator.ts";
import { assessDelay } from "./delay.ts";
import { currentStatus, normalizeStatus } from "./status.ts";
import type { NormalizedStatus } from "./status.ts";

export type Outcome = { status: 200 | 201 | 400 | 404 | 409 | 502; body: unknown };

type ShipmentRow = { id: string; tracking_code: string; creator_id: string; created_at: string };
type EventRow = {
  event_id: string;
  occurred_at: string;
  raw_status: string;
  status: NormalizedStatus;
  received_at: string;
};

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function findShipment(db: DatabaseSync, id: string): ShipmentRow | undefined {
  return db.prepare("SELECT * FROM shipments WHERE id = ?").get(id) as ShipmentRow | undefined;
}

// Cadastros em andamento por banco e código: o segundo request do mesmo código
// espera o primeiro em vez de registrar de novo no agregador. Não há transação
// aberta durante a chamada de rede.
const inFlight = new WeakMap<DatabaseSync, Map<string, Promise<unknown>>>();

function ownerOutcome(existing: ShipmentRow, creatorId: string): Outcome {
  if (existing.creator_id !== creatorId) {
    return { status: 409, body: { error: "código de rastreio já pertence a outro criador" } };
  }
  return { status: 200, body: existing };
}

function findByCode(db: DatabaseSync, code: string): ShipmentRow | undefined {
  return db.prepare("SELECT * FROM shipments WHERE tracking_code = ?").get(code) as ShipmentRow | undefined;
}

export async function createShipment(
  db: DatabaseSync,
  aggregator: TrackingAggregator,
  input: Record<string, unknown>,
  now: Date,
): Promise<Outcome> {
  const code = text(input.tracking_code);
  const creatorId = text(input.creator_id);
  if (!code) return { status: 400, body: { error: "tracking_code é obrigatório" } };
  if (!creatorId) return { status: 400, body: { error: "creator_id é obrigatório" } };

  const pending = inFlight.get(db) ?? new Map<string, Promise<unknown>>();
  inFlight.set(db, pending);
  const running = pending.get(code);
  if (running) await running.catch(() => {});

  const existing = findByCode(db, code);
  if (existing) return ownerOutcome(existing, creatorId);

  const registration = aggregator.register(code);
  pending.set(code, registration);
  try {
    await registration;
  } catch {
    // Nada foi gravado: o próximo request tenta registrar de novo.
    return { status: 502, body: { error: "agregador de rastreio indisponível" } };
  } finally {
    if (pending.get(code) === registration) pending.delete(code);
  }

  const id = `shp_${randomUUID()}`;
  const inserted = db
    .prepare(
      `INSERT INTO shipments (id, tracking_code, creator_id, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (tracking_code) DO NOTHING`,
    )
    .run(id, code, creatorId, now.toISOString());
  // Outro processo pode ter gravado o mesmo código enquanto o registro corria.
  if (Number(inserted.changes) === 0) return ownerOutcome(findByCode(db, code)!, creatorId);
  return { status: 201, body: findShipment(db, id) };
}

function isoOrRaw(value: string): string {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? value : new Date(parsed).toISOString();
}

export async function syncShipment(
  db: DatabaseSync,
  aggregator: TrackingAggregator,
  shipmentId: string,
  now: Date,
  limitHours?: number,
): Promise<Outcome> {
  const shipment = findShipment(db, shipmentId);
  if (!shipment) return { status: 404, body: { error: "envio não encontrado" } };

  const raw = await aggregator.events(shipment.tracking_code);
  const insert = db.prepare(
    `INSERT INTO tracking_events (shipment_id, event_id, occurred_at, raw_status, status, received_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (shipment_id, event_id) DO NOTHING`,
  );
  let inserted = 0;
  let duplicates = 0;
  db.exec("BEGIN");
  try {
    for (const event of raw) {
      const occurredAt = isoOrRaw(event.occurred_at);
      // Instante ilegível não ordena: o evento fica no histórico como unknown.
      const status = Number.isNaN(Date.parse(occurredAt)) ? "unknown" : normalizeStatus(event.status);
      const result = insert.run(shipmentId, event.id, occurredAt, event.status, status, now.toISOString());
      if (Number(result.changes) === 1) inserted += 1;
      else duplicates += 1;
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return { status: 200, body: { inserted, duplicates, ...readShipment(db, shipmentId, now, limitHours) } };
}

export function readShipment(db: DatabaseSync, shipmentId: string, now: Date, limitHours?: number) {
  const shipment = findShipment(db, shipmentId);
  if (!shipment) return null;
  const events = db
    .prepare(
      `SELECT event_id, occurred_at, raw_status, status, received_at
       FROM tracking_events WHERE shipment_id = ? ORDER BY occurred_at ASC, event_id ASC`,
    )
    .all(shipmentId) as EventRow[];

  const status = currentStatus(events);
  const posted = events.find((event) => event.status === "posted");
  const delay = assessDelay({ status, postedAt: posted?.occurred_at ?? null, now, limitHours });

  return {
    id: shipment.id,
    tracking_code: shipment.tracking_code,
    creator_id: shipment.creator_id,
    status,
    delayed: delay.delayed,
    delay_reason: delay.reason,
    events: events.map((event) => ({
      id: event.event_id,
      occurred_at: event.occurred_at,
      raw_status: event.raw_status,
      status: event.status,
    })),
  };
}
