import type { DatabaseSync } from "node:sqlite";
import { readShipment } from "./shipments.ts";

// Checagem de atraso, para rodar periodicamente com o relógio como argumento.
// Envio atrasado ganha um aviso (a chave primária impede o segundo); envio
// entregue encerra o aviso aberto. Nada é apagado.
export function runDelayCheck(db: DatabaseSync, now: Date, limitHours: number) {
  const ids = db.prepare("SELECT id FROM shipments ORDER BY created_at, id").all() as Array<{ id: string }>;
  const open = db.prepare(
    "INSERT INTO delay_alerts (shipment_id, alerted_at, limit_hours, reason) VALUES (?, ?, ?, ?) ON CONFLICT (shipment_id) DO NOTHING",
  );
  const resolve = db.prepare("UPDATE delay_alerts SET resolved_at = ? WHERE shipment_id = ? AND resolved_at IS NULL");
  let newAlerts = 0;
  let resolved = 0;
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const { id } of ids) {
      const shipment = readShipment(db, id, now, limitHours)!;
      if (shipment.delayed) newAlerts += Number(open.run(id, now.toISOString(), limitHours, shipment.delay_reason).changes);
      if (shipment.status === "delivered") resolved += Number(resolve.run(now.toISOString(), id).changes);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return { checked: ids.length, new_alerts: newAlerts, resolved };
}

export function listAlerts(db: DatabaseSync, includeResolved: boolean) {
  const sql = includeResolved
    ? "SELECT * FROM delay_alerts ORDER BY alerted_at, shipment_id"
    : "SELECT * FROM delay_alerts WHERE resolved_at IS NULL ORDER BY alerted_at, shipment_id";
  return db.prepare(sql).all();
}
