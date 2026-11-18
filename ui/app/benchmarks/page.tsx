"use client";

import { LineChart, type Series } from "@/components/line-chart";
import type { SweepPoint, Summary } from "@/lib/api";
import { usePolled } from "@/lib/hooks";

// Colour follows the target, never its position in the file, so a target keeps
// its colour when another one is added or removed.
const COLOR: Record<string, string> = {
  "vllm-awq": "var(--series-1)",
  "trtllm-awq": "var(--series-2)",
  "trtllm-fp8": "var(--series-3)",
  "trtllm-fp8-spec": "var(--series-4)",
};
const RAMP = ["var(--ramp-1)", "var(--ramp-2)", "var(--ramp-3)"];

const compact = (value: number) => (value >= 100 ? value.toFixed(0) : value.toFixed(1).replace(/\.0$/, ""));
const percent = (value: number) => `${(value * 100).toFixed(1)}%`;

export default function Benchmarks() {
  const { data, error } = usePolled<Summary>("results");

  if (!data) {
    return (
      <div className="mx-auto max-w-[88rem] px-4 py-6">
        <h1 className="text-lg font-semibold">Benchmarks</h1>
        {error?.code === "no_results" ? (
          <>
            <p className="mt-2 max-w-[62ch] text-ink-2">
              Nothing has been measured yet. This page only shows numbers from real runs on the GPU host: an
              AIPerf concurrency sweep per engine, an lm-eval accuracy score per quantized variant, and a
              speculative-decoding sweep.
            </p>
            <p className="mt-3 text-ink-2">
              Run <code className="font-mono text-ink">make bench eval summary</code> there, then reload.
            </p>
          </>
        ) : (
          <p className="mt-2 text-ink-2" role={error ? "alert" : undefined}>
            {error ? error.message : "Loading…"}
          </p>
        )}
      </div>
    );
  }

  const loaded = data.targets.filter((t) => t.sweep.length > 0);
  const sweep = (pick: (point: SweepPoint) => number): Series[] =>
    loaded.map((t) => ({
      id: t.id,
      label: t.label,
      color: COLOR[t.id] ?? "var(--ink-2)",
      points: t.sweep.map((point) => ({ x: point.concurrency, y: pick(point) })),
    }));

  const draftLens = [...new Set(data.spec_decode.map((p) => p.draft_len))].sort((a, b) => a - b);
  const spec = (pick: (point: Summary["spec_decode"][number]) => number): Series[] =>
    draftLens.map((len, i) => ({
      id: String(len),
      label: `draft ${len}`,
      color: RAMP[i] ?? RAMP[2],
      points: data.spec_decode
        .filter((p) => p.draft_len === len)
        .map((p) => ({ x: p.concurrency, y: pick(p) })),
    }));

  const reference = data.targets.find((t) => t.id === data.reference)?.accuracy;
  const scored = data.targets.filter((t) => t.accuracy);
  const opened = data.targets.filter((t) => t.open_loop);

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-[88rem] px-4 py-6">
        <h1 className="text-lg font-semibold">Benchmarks</h1>
        <p className="mt-1 text-ink-2">
          {data.hardware} · {data.workload} · measured {data.generated_at.slice(0, 10)}
        </p>
        {data.synthetic && (
          <p role="alert" className="mt-3 w-fit rounded-md border border-danger px-3 py-2 text-danger">
            Synthetic fixture for UI development. These are not measurements.
          </p>
        )}

        <section className="mt-8">
          <h2 className="text-base font-semibold">Under load</h2>
          <p className="mt-1 max-w-[75ch] text-ink-2">
            Closed loop: each level keeps that many requests in flight. Goodput counts only the requests that
            met the SLO of {data.slo.ttft_ms} ms to first token and {data.slo.itl_ms} ms between tokens.
          </p>
          <div className="mt-5 grid gap-x-10 gap-y-8 xl:grid-cols-2">
            <LineChart
              title="Output tokens per second"
              xLabel="Concurrent requests"
              series={sweep((p) => p.output_tps)}
              format={compact}
            />
            <LineChart
              title="Goodput, requests per second within SLO"
              xLabel="Concurrent requests"
              series={sweep((p) => p.goodput_rps)}
              format={compact}
            />
            <LineChart
              title="Time to first token, p99 (ms)"
              xLabel="Concurrent requests"
              series={sweep((p) => p.ttft_ms.p99)}
              format={compact}
            />
            <LineChart
              title="Inter-token latency, p99 (ms)"
              xLabel="Concurrent requests"
              series={sweep((p) => p.itl_ms.p99)}
              format={compact}
            />
          </div>
        </section>

        {opened.length > 0 && (
          <section className="mt-10">
            <h2 className="text-base font-semibold">At a fixed arrival rate</h2>
            <p className="mt-1 max-w-[75ch] text-ink-2">
              Open loop: requests arrive on a Poisson clock at 70% of each target’s peak closed-loop
              throughput, whether or not earlier ones have finished. A closed loop slows its own arrivals when
              the server slows, which hides queueing; this run does not.
            </p>
            <div className="mt-3 overflow-x-auto">
              <table className="data-table max-w-4xl">
                <thead>
                  <tr>
                    <th>Target</th>
                    <th>Arrival rate</th>
                    <th>TTFT p50 / p99</th>
                    <th>ITL p50 / p99</th>
                    <th>Within SLO</th>
                  </tr>
                </thead>
                <tbody>
                  {opened.map((t) => (
                    <tr key={t.id}>
                      <td>{t.label}</td>
                      <td>{t.open_loop!.rate_rps.toFixed(2)} req/s</td>
                      <td>
                        {compact(t.open_loop!.ttft_ms.p50)} / {compact(t.open_loop!.ttft_ms.p99)} ms
                      </td>
                      <td>
                        {compact(t.open_loop!.itl_ms.p50)} / {compact(t.open_loop!.itl_ms.p99)} ms
                      </td>
                      <td>{percent(t.open_loop!.within_slo)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {scored.length > 0 && (
          <section className="mt-10">
            <h2 className="text-base font-semibold">Accuracy after quantization</h2>
            <p className="mt-1 max-w-[75ch] text-ink-2">
              {scored[0].accuracy!.task}, {scored[0].accuracy!.n} questions, temperature 0. The ± is one
              standard error. A difference smaller than two combined standard errors cannot be told apart from
              noise.
            </p>
            <div className="mt-3 overflow-x-auto">
              <table className="data-table max-w-3xl">
                <thead>
                  <tr>
                    <th>Target</th>
                    <th>Accuracy</th>
                    <th>Change vs reference</th>
                    <th>Weights on disk</th>
                  </tr>
                </thead>
                <tbody>
                  {scored.map((t) => {
                    const { score, stderr } = t.accuracy!;
                    const delta = reference && t.id !== data.reference ? score - reference.score : null;
                    // Standard error of a difference of two independent scores.
                    const noise = reference ? 2 * Math.hypot(stderr, reference.stderr) : 0;
                    return (
                      <tr key={t.id}>
                        <td>{t.label}</td>
                        <td>
                          {percent(score)} ± {(stderr * 100).toFixed(1)}
                        </td>
                        <td>
                          {delta === null
                            ? t.id === data.reference
                              ? "reference"
                              : "n/a"
                            : `${delta > 0 ? "+" : ""}${(delta * 100).toFixed(1)} pts${Math.abs(delta) < noise ? ", within noise" : ""}`}
                        </td>
                        <td>{t.weights_gib === undefined ? "n/a" : `${t.weights_gib.toFixed(1)} GiB`}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {draftLens.length > 0 && (
          <section className="mt-10 pb-6">
            <h2 className="text-base font-semibold">Speculative decoding</h2>
            <p className="mt-1 max-w-[75ch] text-ink-2">
              A small draft model proposes tokens and the 7B model verifies them in one pass. Speed-up is
              output tokens per second against the same engine without speculation, at the same concurrency.
            </p>
            <div className="mt-5 grid gap-x-10 gap-y-8 xl:grid-cols-2">
              <LineChart
                title="Speed-up over no speculation (×)"
                xLabel="Concurrent requests"
                series={spec((p) => p.speedup)}
                format={(y) => y.toFixed(2).replace(/0$/, "")}
                reference={{ y: 1, label: "no speculation" }}
                fromZero={false}
              />
              <LineChart
                title="Draft tokens accepted (%)"
                xLabel="Concurrent requests"
                series={spec((p) => p.acceptance_rate * 100)}
                format={compact}
              />
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
