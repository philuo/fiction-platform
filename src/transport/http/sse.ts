export type SseErrorMapper = (error: unknown) => unknown;

export function sseResponse(
  produce: (send: (event: unknown) => void) => Promise<void>,
  mapError: SseErrorMapper,
): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: unknown) => {
        try { controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`)); } catch { /* disconnected */ }
      };
      const heartbeat = setInterval(() => send({ phase: "ping" }), 8_000);
      try {
        await produce(send);
      } catch (error) {
        send(mapError(error));
      } finally {
        clearInterval(heartbeat);
        try { controller.close(); } catch { /* disconnected */ }
      }
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      "X-Accel-Buffering": "no",
      Connection: "keep-alive",
    },
  });
}
