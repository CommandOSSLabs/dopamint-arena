export type Handler = (req: Request) => Promise<Response> | Response;

export interface Route {
  method: string;
  path: string;
  handler: Handler;
}

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export function createRouter(allowedOrigin: string, routes: Route[]) {
  const corsHeaders = {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };

  return async function handle(req: Request): Promise<Response> {
    const { pathname } = new URL(req.url);

    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    const route = routes.find(
      (r) => r.method === req.method && r.path === pathname
    );

    let res: Response;
    if (!route) {
      res = json({ error: "Not found" }, 404);
    } else {
      try {
        res = await route.handler(req);
      } catch (error) {
        console.error(error);
        res = json({ error: "Internal server error" }, 500);
      }
    }

    for (const [k, v] of Object.entries(corsHeaders)) res.headers.set(k, v);
    return res;
  };
}
