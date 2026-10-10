import type { ShipmentStatus } from "./status.ts";

export const DEFAULT_TRANSIT_LIMIT_HOURS = 120;
const HOUR_MS = 60 * 60 * 1000;

export type DelayVerdict = { delayed: boolean; reason: string };

// Função pura: o relógio é o argumento `now`.
export function assessDelay(input: {
  status: ShipmentStatus | null;
  postedAt: string | null;
  now: Date;
  limitHours?: number;
}): DelayVerdict {
  const limit = input.limitHours ?? DEFAULT_TRANSIT_LIMIT_HOURS;
  if (input.status === "delivered") return { delayed: false, reason: "já foi entregue" };
  if (input.status === "exception") {
    return { delayed: false, reason: "exceção da transportadora, não atraso de trânsito" };
  }
  if (!input.postedAt) return { delayed: false, reason: "ainda não foi postado" };

  const elapsedHours = (input.now.getTime() - Date.parse(input.postedAt)) / HOUR_MS;
  if (elapsedHours > limit) {
    return {
      delayed: true,
      reason: `${Math.floor(elapsedHours)}h desde a postagem, acima do limite de ${limit}h`,
    };
  }
  return { delayed: false, reason: "ainda dentro do limite desde a postagem" };
}
