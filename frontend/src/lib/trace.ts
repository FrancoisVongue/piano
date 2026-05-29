// W3C trace-context — minimal client-side implementation.
//
// We don't ship the full @opentelemetry/sdk-trace-web on the frontend because
// 80% of the value is just propagating a trace_id to the backend so the request
// shows up under "browser → API → temporal" in Cloud Trace. That's a single
// HTTP header generated per fetch.
//
// Format: `00-<trace-id (32 hex)>-<span-id (16 hex)>-01` (sampled).
// See https://www.w3.org/TR/trace-context/#traceparent-header

const hex = (bytes: number): string => {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => b.toString(16).padStart(2, '0')).join('');
};

// One trace per browser session (page load) — every fetch becomes a child span
// of that trace. Cheap to make finer-grained later (per-route, per-mutation).
const sessionTraceId = typeof window !== 'undefined' ? hex(16) : null;

export const traceparent = (): string | null => {
  if (!sessionTraceId) return null;
  return `00-${sessionTraceId}-${hex(8)}-01`;
};
