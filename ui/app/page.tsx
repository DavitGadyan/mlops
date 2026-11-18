"use client";

import { useEffect, useRef, useState } from "react";
import type { Engine, Gpu } from "@/lib/api";
import { usePolled, useStored } from "@/lib/hooks";
import { streamChat, type Stats, type ToolCall } from "@/lib/stream";

type Message = {
  role: "user" | "assistant";
  content: string;
  toolCalls?: ToolCall[];
  stats?: Stats;
  engine?: string; // label of the engine that answered
  error?: string;
};

const DEFAULTS = { engine: "", maxTokens: 512, temperature: 0.7, tools: false };

// One function the model may call, to show tool-call parsing end to end.
const WEATHER_TOOL = {
  type: "function",
  function: {
    name: "get_weather",
    description: "Get the current weather for a city.",
    parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
  },
};

const EXAMPLES = [
  "Explain in three sentences why LLM decode is bound by memory bandwidth.",
  "Write a Python function that merges two sorted lists.",
  "What is the weather in Yerevan? (turn on “Offer a tool” first)",
];

const number = (value: number | null, unit: string, digits = 0) =>
  value === null ? "n/a" : `${value.toFixed(digits)} ${unit}`;

export default function Playground() {
  const [settings, setSettings] = useStored("playground", DEFAULTS);
  const engines = usePolled<Engine[]>("engines", 5000);
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const running = useRef<AbortController | null>(null);
  const end = useRef<HTMLDivElement>(null);

  // The stored choice if that engine still exists, otherwise the gateway's default.
  const engine = engines.data?.find((e) => e.id === settings.engine) ?? engines.data?.find((e) => e.default);

  // Braces matter: scrollIntoView returns a promise in current Chrome, and an
  // effect may only return a clean-up function.
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [messages]);

  const patchLast = (patch: Partial<Message>) =>
    setMessages((all) => [...all.slice(0, -1), { ...all.at(-1)!, ...patch }]);

  async function send(prompt: string) {
    if (!engine?.healthy || busy || !prompt.trim()) return;
    const history: Message[] = [...messages, { role: "user", content: prompt.trim() }];
    setMessages([...history, { role: "assistant", content: "", engine: engine.label }]);
    setDraft("");
    setBusy(true);
    running.current = new AbortController();
    try {
      const stats = await streamChat(
        {
          model: engine.model,
          // Tool-call turns carry no text, and this demo does not feed tool results back.
          messages: history.filter((m) => m.content).map(({ role, content }) => ({ role, content })),
          max_tokens: settings.maxTokens,
          temperature: settings.temperature,
          tools: settings.tools ? [WEATHER_TOOL] : undefined,
        },
        running.current.signal,
        (content, toolCalls) => patchLast({ content, toolCalls }),
      );
      patchLast({ stats });
    } catch (error) {
      patchLast({ error: (error as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto grid h-full max-w-[88rem] grid-rows-[auto_minmax(0,1fr)] gap-x-8 px-4 lg:grid-cols-[minmax(0,1fr)_19rem] lg:grid-rows-1">
      <h1 className="sr-only">Playground</h1>

      <section className="order-2 flex min-h-0 flex-col lg:order-1">
        <div className="flex-1 overflow-y-auto py-4" role="log" aria-busy={busy}>
          {messages.length === 0 && (
            <div className="max-w-[62ch] py-2">
              <p className="text-ink-2">
                Prompts go to the engine selected in Settings. Each reply reports time to first token,
                inter-token latency and decode speed as measured in this browser, with the engine’s own token
                counts.
              </p>
              <ul className="mt-4 flex flex-col items-start gap-2">
                {EXAMPLES.map((text) => (
                  <li key={text}>
                    <button
                      type="button"
                      className="btn h-auto py-2 text-left font-normal"
                      disabled={!engine?.healthy}
                      onClick={() => send(text)}
                    >
                      {text}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {messages.map((message, i) => (
            <article key={i} className="grid grid-cols-[4rem_minmax(0,1fr)] gap-x-3 py-3">
              <div className="text-ink-2">{message.role === "user" ? "You" : "qwen7b"}</div>
              <div className="max-w-[72ch] min-w-0">
                {message.content ? (
                  <p className="text-[0.9375rem] leading-relaxed whitespace-pre-wrap">{message.content}</p>
                ) : (
                  busy &&
                  i === messages.length - 1 &&
                  !message.toolCalls?.length && <p className="text-ink-2">Waiting for the first token…</p>
                )}
                {message.toolCalls?.map((call, n) => (
                  <div key={n}>
                    <p className="text-ink-2">The model asked to call a tool:</p>
                    <pre className="mt-1 overflow-x-auto rounded-md border border-line bg-surface px-3 py-2 font-mono text-[0.8125rem]">
                      {call.name}({call.arguments})
                    </pre>
                  </div>
                ))}
                {message.error && (
                  <p role="alert" className="text-danger">
                    {message.error}
                  </p>
                )}
                {message.stats && <ReplyStats stats={message.stats} engine={message.engine} />}
              </div>
            </article>
          ))}
          <div ref={end} />
        </div>

        <form
          className="border-t border-line py-3"
          onSubmit={(event) => {
            event.preventDefault();
            send(draft);
          }}
        >
          {engines.error && !engines.data && (
            <p role="alert" className="mb-2 text-danger">
              {engines.error.message}
            </p>
          )}
          {engine && !engine.healthy && (
            <p role="status" className="mb-2 text-ink-2">
              {engine.label} is not running. Start it on the GPU host with{" "}
              <code className="font-mono">make up</code>, or pick another engine in Settings.
            </p>
          )}
          <div className="flex items-end gap-2">
            <textarea
              aria-label="Prompt"
              rows={2}
              value={draft}
              placeholder="Ask something. Enter sends, Shift+Enter adds a line."
              className="field h-auto resize-none py-2"
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  send(draft);
                }
              }}
            />
            {busy ? (
              <button type="button" className="btn" onClick={() => running.current?.abort()}>
                Stop
              </button>
            ) : (
              <button className="btn btn-primary" disabled={!engine?.healthy || !draft.trim()}>
                Send
              </button>
            )}
          </div>
        </form>
      </section>

      <aside className="order-1 border-b border-line py-3 lg:order-2 lg:overflow-y-auto lg:border-b-0 lg:border-l lg:py-4 lg:pl-6">
        <button
          type="button"
          className="btn lg:hidden"
          aria-expanded={settingsOpen}
          onClick={() => setSettingsOpen(!settingsOpen)}
        >
          {settingsOpen ? "Hide settings" : "Settings"}
        </button>
        <div className={`${settingsOpen ? "mt-3" : "hidden"} lg:mt-0 lg:block`}>
          <h2 className="hidden font-semibold lg:block">Settings</h2>

          <fieldset className="lg:mt-4">
            <legend className="font-medium">Engine</legend>
            {!engines.data && <p className="mt-1 text-ink-2">{engines.error ? "Unavailable" : "Loading…"}</p>}
            {engines.data?.map((e) => (
              <label key={e.id} className="mt-2 flex cursor-pointer items-start gap-2.5">
                <input
                  type="radio"
                  name="engine"
                  className="mt-1 accent-ink"
                  checked={engine?.id === e.id}
                  onChange={() => setSettings({ engine: e.id })}
                />
                <span>
                  <span className="block">{e.label}</span>
                  <span className="flex items-center gap-1.5 text-[0.8125rem] text-ink-2">
                    <span className={`size-2 rounded-full ${e.healthy ? "bg-good" : "bg-line-strong"}`} />
                    {e.healthy ? "running" : "not running"}
                    {e.replicas > 1 && ` · ${e.replicas} replicas`}
                    {e.default && " · default"}
                  </span>
                </span>
              </label>
            ))}
          </fieldset>

          <label className="mt-5 block font-medium">
            Max output tokens
            <input
              type="number"
              min={1}
              max={4096}
              className="field mt-1 font-normal"
              value={settings.maxTokens}
              onChange={(event) => setSettings({ maxTokens: event.target.valueAsNumber || 1 })}
            />
          </label>

          <label className="mt-4 block font-medium">
            Temperature
            <input
              type="number"
              min={0}
              max={2}
              step={0.1}
              className="field mt-1 font-normal"
              value={settings.temperature}
              onChange={(event) => setSettings({ temperature: event.target.valueAsNumber || 0 })}
            />
          </label>

          <label className="mt-5 flex cursor-pointer items-start gap-2.5">
            <input
              type="checkbox"
              className="mt-1 accent-ink"
              checked={settings.tools}
              onChange={(event) => setSettings({ tools: event.target.checked })}
            />
            <span>
              <span className="block font-medium">Offer a tool</span>
              <span className="text-[0.8125rem] text-ink-2">
                Sends a get_weather function, so the reply can be a parsed tool call.
              </span>
            </span>
          </label>

          <GpuReadout />
        </div>
      </aside>
    </div>
  );
}

function ReplyStats({ stats, engine }: { stats: Stats; engine?: string }) {
  const tokens =
    stats.completionTokens === null ? "n/a" : `${stats.promptTokens} in, ${stats.completionTokens} out`;
  const rows: [label: string, value: string, meaning: string][] = [
    [
      "TTFT",
      number(stats.ttftMs, "ms"),
      "Time to first token: from sending the request to the first output reaching this browser",
    ],
    [
      "ITL",
      number(stats.itlMs, "ms", 1),
      "Inter-token latency: mean time between output tokens after the first",
    ],
    [
      "Decode",
      number(stats.itlMs && 1000 / stats.itlMs, "tok/s", 1),
      "Decode speed for this request: 1000 / ITL",
    ],
    ["Tokens", tokens, "Prompt and completion tokens, from the engine’s usage block"],
    ["Finish", stats.finishReason ?? "n/a", "Why generation ended"],
    ["Engine", engine ?? "n/a", "The engine that served this reply"],
  ];
  return (
    <dl className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-[0.8125rem] text-ink-2 tabular-nums">
      {rows.map(([label, value, meaning]) => (
        <div key={label} className="flex gap-1.5" title={meaning}>
          <dt>{label}</dt>
          <dd className="text-ink">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function GpuReadout() {
  const gpu = usePolled<Gpu>("gpu", 2000);
  const cells: [label: string, value: string][] = gpu.data
    ? [
        ["Utilisation", number(gpu.data.util_pct, "%")],
        ["Memory", number(gpu.data.vram_used_gib, "GiB", 1)],
        ["Power", number(gpu.data.power_w, "W")],
      ]
    : [];
  return (
    <section className="mt-6 border-t border-line pt-4">
      <h3 className="font-medium">GPU</h3>
      {gpu.error || !gpu.data ? (
        <p className="mt-1 text-[0.8125rem] text-ink-2">
          {gpu.error ? "No GPU metrics. Prometheus and dcgm-exporter run on the GPU host." : "Loading…"}
        </p>
      ) : (
        <dl className="mt-2 grid grid-cols-3 gap-2">
          {cells.map(([label, value]) => (
            <div key={label}>
              <dd className="text-base font-semibold">{value}</dd>
              <dt className="text-[0.8125rem] text-ink-2">{label}</dt>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}
