import type { NextRequest } from "next/server";
import { daemonBaseUrl, daemonToken } from "@/lib/daemon";

/**
 * Loopback BFF (master plan §8.1): Next Route Handlers proxy REST + SSE to
 * agentosd, holding the daemon bearer server-side. The token never reaches
 * the browser; the browser talks only to same-origin `/api/agentos/*`.
 */

export const dynamic = "force-dynamic";

const FORWARDED_REQUEST_HEADERS = [
  "content-type",
  "accept",
  "last-event-id",
  "x-agentos-confirm-safety",
] as const;

type RouteContext = { params: Promise<{ path: string[] }> };

async function proxy(request: NextRequest, context: RouteContext): Promise<Response> {
  const token = daemonToken();
  if (token === null) {
    return Response.json(
      {
        error: {
          code: "BAD_REQUEST",
          message: "daemon token not found — is agentosd initialized?",
          issues: null,
        },
      },
      { status: 502 },
    );
  }

  const { path } = await context.params;
  const search = request.nextUrl.search;
  const url = `${daemonBaseUrl()}/v1/${path.map(encodeURIComponent).join("/")}${search}`;

  const headers = new Headers({ authorization: `Bearer ${token}` });
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }

  const init: RequestInit = {
    method: request.method,
    headers,
    cache: "no-store",
    // Streams SSE bodies through without buffering.
    signal: request.signal,
  };
  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = await request.text();
  }

  let upstream: Response;
  try {
    upstream = await fetch(url, init);
  } catch {
    return Response.json(
      {
        error: {
          code: "BAD_REQUEST",
          message: "agentosd is not reachable on 127.0.0.1",
          issues: null,
        },
      },
      { status: 502 },
    );
  }

  const responseHeaders = new Headers();
  for (const name of ["content-type", "cache-control"]) {
    const value = upstream.headers.get(name);
    if (value !== null) responseHeaders.set(name, value);
  }
  return new Response(upstream.body, {
    status: upstream.status,
    headers: responseHeaders,
  });
}

export async function GET(request: NextRequest, context: RouteContext): Promise<Response> {
  return proxy(request, context);
}

export async function PUT(request: NextRequest, context: RouteContext): Promise<Response> {
  return proxy(request, context);
}

export async function POST(request: NextRequest, context: RouteContext): Promise<Response> {
  return proxy(request, context);
}
