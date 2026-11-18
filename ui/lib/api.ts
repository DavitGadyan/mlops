// Shapes returned by the gateway, and the one way the UI reads them.

export type Engine = {
  id: string;
  model: string;
  label: string;
  healthy: boolean;
  replicas: number; // ready replicas of this engine; more than one on Kubernetes
  default: boolean;
};

export type Gpu = { util_pct: number | null; vram_used_gib: number | null; power_w: number | null };

type Percentiles = { p50: number; p99: number };

export type SweepPoint = {
  concurrency: number;
  output_tps: number; // output tokens per second, all requests together
  goodput_rps: number; // requests per second that met the SLO
  ttft_ms: Percentiles;
  itl_ms: Percentiles;
};

export type Target = {
  id: string;
  label: string;
  sweep: SweepPoint[];
  // Open loop: requests arrive on a Poisson clock at a fixed rate, whether or
  // not earlier ones have finished, like real users.
  open_loop?: { rate_rps: number; ttft_ms: Percentiles; itl_ms: Percentiles; within_slo: number };
  accuracy?: { task: string; n: number; score: number; stderr: number };
  weights_gib?: number; // size of the checkpoint on disk
};

export type SpecPoint = { draft_len: number; concurrency: number; speedup: number; acceptance_rate: number };

/** Written by bench/summarize.py from AIPerf and lm-eval output. */
export type Summary = {
  generated_at: string;
  hardware: string;
  workload: string;
  synthetic?: boolean; // true only for the test fixture
  slo: { ttft_ms: number; itl_ms: number };
  reference?: string; // target id the accuracy deltas are measured against
  targets: Target[];
  spec_decode: SpecPoint[];
};

export class ApiError extends Error {
  constructor(
    message: string,
    public code?: string,
  ) {
    super(message);
  }
}

/** Turns a failed reply into the gateway's own error message. */
export async function toError(reply: Response): Promise<ApiError> {
  const body = await reply.json().catch(() => null);
  return new ApiError(
    body?.error?.message ?? `Request failed with status ${reply.status}`,
    body?.error?.code,
  );
}

export async function getJson<T>(path: string): Promise<T> {
  const reply = await fetch(`/api/${path}`, { cache: "no-store" });
  if (!reply.ok) throw await toError(reply);
  return reply.json();
}
