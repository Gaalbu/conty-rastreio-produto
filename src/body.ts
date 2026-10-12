import type { Context } from "hono";

export const MAX_BODY_BYTES = 64 * 1024;

export class BodyError extends Error {
  constructor(
    readonly status: 400 | 415,
    readonly payload: Record<string, unknown>,
  ) {
    super(String(payload.error));
  }
}

// Lê o corpo de forma estrita: Content-Type JSON, JSON válido e objeto. Com
// `allowed`, campo fora da lista é recusado com o nome dele. Corpo vazio vale {}.
export async function body(c: Context, allowed?: readonly string[]): Promise<Record<string, unknown>> {
  const text = await c.req.text();
  if (!text.trim()) return {};
  if (!/^application\/json\b/i.test(c.req.header("content-type") ?? "")) {
    throw new BodyError(415, { error: "corpo precisa ser application/json" });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new BodyError(400, { error: "JSON inválido" });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new BodyError(400, { error: "corpo precisa ser um objeto JSON" });
  }
  const unknown = allowed ? Object.keys(parsed).find((key) => !allowed.includes(key)) : undefined;
  if (unknown !== undefined) throw new BodyError(400, { error: "campo desconhecido", field: unknown });
  return parsed as Record<string, unknown>;
}
