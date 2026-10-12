import { DatabaseSync } from "node:sqlite";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS shipments (
  id TEXT PRIMARY KEY,
  tracking_code TEXT NOT NULL UNIQUE,
  creator_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Histórico append-only: evento nunca é atualizado nem apagado.
-- Aviso de atraso: no máximo um por envio, encerrado quando o pacote é entregue.
CREATE TABLE IF NOT EXISTS delay_alerts (
  shipment_id TEXT PRIMARY KEY REFERENCES shipments(id),
  alerted_at TEXT NOT NULL,
  limit_hours REAL NOT NULL,
  reason TEXT NOT NULL,
  resolved_at TEXT
);

CREATE TABLE IF NOT EXISTS tracking_events (
  shipment_id TEXT NOT NULL REFERENCES shipments(id),
  event_id TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  raw_status TEXT NOT NULL,
  status TEXT NOT NULL,
  received_at TEXT NOT NULL,
  UNIQUE (shipment_id, event_id)
);
`;

export function openDatabase(path = ":memory:"): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(SCHEMA);
  return db;
}
