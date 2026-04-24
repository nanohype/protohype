/**
 * The only shape used to reject a request. No layer name, no model, no
 * upstream identity. `scripts/ci/grep-error-leak.sh` grep-gates any other
 * error string in `src/proxy/` and `src/honeypot/`.
 */
export interface RejectBody {
  readonly code: "REQUEST_REJECTED";
  readonly trace_id: string;
}

export function rejectBody(traceId: string): RejectBody {
  return { code: "REQUEST_REJECTED", trace_id: traceId };
}
