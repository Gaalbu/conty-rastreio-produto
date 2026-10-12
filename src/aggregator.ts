// Borda com o agregador de rastreio. O formato bruto não passa daqui e de
// normalizeStatus. O signal é abortado quando a chamada estoura o prazo; o
// adaptador real deve repassá-lo ao fetch.
export type RawTrackingEvent = { id: string; occurred_at: string; status: string };

export interface TrackingAggregator {
  register(code: string, signal?: AbortSignal): Promise<void>;
  events(code: string, signal?: AbortSignal): Promise<RawTrackingEvent[]>;
}

export const DEFAULT_AGGREGATOR_TIMEOUT_MS = 10_000;

export class AggregatorTimeout extends Error {
  constructor(readonly operation: string) {
    super(`agregador não respondeu a ${operation} no prazo`);
  }
}

async function race<T>(operation: string, ms: number, call: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new AggregatorTimeout(operation));
    }, ms);
  });
  try {
    return await Promise.race([call(controller.signal), expired]);
  } finally {
    clearTimeout(timer);
  }
}

// Nenhuma request espera o agregador além do prazo.
export function withDeadline(aggregator: TrackingAggregator, ms: number): TrackingAggregator {
  return {
    register: (code) => race("register", ms, (signal) => aggregator.register(code, signal)),
    events: (code) => race("events", ms, (signal) => aggregator.events(code, signal)),
  };
}
