export function jsonResponse(data: unknown, status = 200, extraHeaders?: Record<string, string>): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...extraHeaders },
  });
}

export async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  try {
    return (await request.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function errorDetail(error: unknown, fallback: string): string {
  const message = error instanceof Error && error.message ? error.message.split("\n")[0].trim() : "";
  return message ? message.slice(0, 300) : fallback;
}
