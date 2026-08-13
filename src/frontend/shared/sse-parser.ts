export type SseRecord = Record<string, unknown>;

/** Parse newline-delimited SSE data while retaining a partial trailing line. */
export function parseSseLines(buffer: string, chunk: string): { buffer: string; events: SseRecord[] } {
  const lines = `${buffer}${chunk}`.split("\n");
  const nextBuffer = lines.pop() ?? "";
  const events: SseRecord[] = [];
  for (const line of lines) {
    const value = line.trim();
    if (!value.startsWith("data:")) continue;
    try {
      const parsed = JSON.parse(value.slice(5).trim()) as unknown;
      if (parsed && typeof parsed === "object") events.push(parsed as SseRecord);
    } catch {
      // Ignore malformed keep-alive/partial records; a later chunk may complete the line.
    }
  }
  return { buffer: nextBuffer, events };
}
