// One streamed chat completion, timed the way a load generator times it.

import { toError } from "./api";

export type ToolCall = { name: string; arguments: string };

export type Stats = {
  ttftMs: number | null; // request sent -> first chunk that carries output
  itlMs: number | null; // mean time between output tokens after the first
  promptTokens: number | null;
  completionTokens: number | null;
  finishReason: string | null;
};

type Chunk = {
  choices: {
    delta: {
      content?: string | null;
      tool_calls?: { index: number; function?: { name?: string; arguments?: string } }[];
    };
    finish_reason: string | null;
  }[];
  usage?: { prompt_tokens: number; completion_tokens: number } | null;
};

/** Yields the payload of each `data:` line as it arrives. */
async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    // stream: true keeps a multi-byte character that was split across reads intact.
    buffer = (buffer + decoder.decode(value, { stream: true })).replace(/\r\n/g, "\n");
    for (let end = buffer.indexOf("\n\n"); end >= 0; end = buffer.indexOf("\n\n")) {
      for (const line of buffer.slice(0, end).split("\n")) {
        if (line.startsWith("data:")) yield line.slice(5).trim();
      }
      buffer = buffer.slice(end + 2);
    }
  }
}

export async function streamChat(
  body: object,
  signal: AbortSignal,
  onUpdate: (content: string, toolCalls: ToolCall[]) => void,
): Promise<Stats> {
  const stats: Stats = {
    ttftMs: null,
    itlMs: null,
    promptTokens: null,
    completionTokens: null,
    finishReason: null,
  };
  const toolCalls: ToolCall[] = [];
  let content = "";
  let firstAt = 0;
  let lastAt = 0;
  const sentAt = performance.now();

  try {
    const reply = await fetch("/api/v1/chat/completions", {
      method: "POST",
      // include_usage: the engine ends the stream with one chunk of exact token counts.
      body: JSON.stringify({ ...body, stream: true, stream_options: { include_usage: true } }),
      signal,
    });
    if (!reply.ok || !reply.body) throw await toError(reply);

    for await (const data of sseData(reply.body)) {
      if (data === "[DONE]") break;
      const chunk: Chunk = JSON.parse(data);
      const choice = chunk.choices[0];

      // The opening chunk only announces the role; it is not a token.
      if (choice?.delta.content || choice?.delta.tool_calls) {
        lastAt = performance.now();
        firstAt ||= lastAt;
        content += choice.delta.content ?? "";
        for (const call of choice.delta.tool_calls ?? []) {
          // Arguments arrive as string fragments, keyed by the call's index.
          const slot = (toolCalls[call.index] ??= { name: "", arguments: "" });
          slot.name += call.function?.name ?? "";
          slot.arguments += call.function?.arguments ?? "";
        }
        onUpdate(content, [...toolCalls]);
      }
      if (choice?.finish_reason) stats.finishReason = choice.finish_reason;
      if (chunk.usage) {
        stats.promptTokens = chunk.usage.prompt_tokens;
        stats.completionTokens = chunk.usage.completion_tokens;
      }
    }
  } catch (error) {
    if (!signal.aborted) throw error;
    stats.finishReason = "cancelled"; // Stop was pressed: keep what arrived
  }

  if (firstAt) stats.ttftMs = firstAt - sentAt;
  // AIPerf's definition: (last token time - first token time) / (output tokens - 1).
  // It needs the usage block because chunks are not tokens: one chunk can carry
  // several, and under speculative decoding it usually does. A reply that came
  // in a single chunk has no gap to measure.
  if (stats.completionTokens && stats.completionTokens > 1 && lastAt > firstAt) {
    stats.itlMs = (lastAt - firstAt) / (stats.completionTokens - 1);
  }
  return stats;
}
