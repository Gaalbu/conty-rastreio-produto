// Borda com o agregador de rastreio. O formato bruto não passa daqui e de
// normalizeStatus.
export type RawTrackingEvent = { id: string; occurred_at: string; status: string };

export interface TrackingAggregator {
  register(code: string): Promise<void>;
  events(code: string): Promise<RawTrackingEvent[]>;
}
