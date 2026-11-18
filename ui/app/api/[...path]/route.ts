// Server-side hop to the gateway. It keeps the API key out of the browser and
// puts the page and the API on one origin, so there is no CORS to configure.

const GATEWAY_URL = process.env.GATEWAY_URL ?? "http://localhost:8080";

async function relay(request: Request, { params }: RouteContext<"/api/[...path]">) {
  const { path } = await params;
  try {
    const upstream = await fetch(`${GATEWAY_URL}/${path.join("/")}`, {
      method: request.method,
      headers: {
        authorization: `Bearer ${process.env.GATEWAY_API_KEY}`,
        "content-type": "application/json",
      },
      body: request.method === "POST" ? await request.text() : undefined,
      // When the browser goes away (Stop button, closed tab) this request is
      // aborted, the gateway closes its engine connection, and generation stops.
      signal: request.signal,
      cache: "no-store",
    });
    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        "content-type": upstream.headers.get("content-type") ?? "application/json",
        // no-transform: compressing a token stream would buffer it and hide the latency we measure.
        "cache-control": "no-store, no-transform",
      },
    });
  } catch {
    return Response.json(
      { error: { message: "The gateway is not reachable.", code: "gateway_unavailable" } },
      { status: 503 },
    );
  }
}

export { relay as GET, relay as POST };
