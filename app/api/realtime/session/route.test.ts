import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ENDPOINT = "http://localhost/api/realtime/session";
const OFFER_SDP = [
  "v=0",
  "o=- 1 2 IN IP4 127.0.0.1",
  "s=-",
  "t=0 0",
  "m=audio 9 UDP/TLS/RTP/SAVPF 111",
  "",
].join("\r\n");
const ANSWER_SDP = [
  "v=0",
  "o=- 2 3 IN IP4 127.0.0.1",
  "s=-",
  "t=0 0",
  "m=audio 9 UDP/TLS/RTP/SAVPF 111",
  "",
].join("\r\n");

type RouteModule = typeof import("@/app/api/realtime/session/route");

let route: RouteModule;

beforeEach(async () => {
  vi.resetModules();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.stubEnv("OPENAI_API_KEY", "");
  route = await import("@/app/api/realtime/session/route");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function createRequest(
  body: string,
  headers: Record<string, string> = {},
): Request {
  return new Request(ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "http://localhost",
      "Sec-Fetch-Site": "same-origin",
      "X-Forwarded-For": "203.0.113.10",
      ...headers,
    },
    body,
  });
}

function createValidRequest(headers: Record<string, string> = {}): Request {
  return createRequest(
    JSON.stringify({ sdp: OFFER_SDP, practice: {} }),
    headers,
  );
}

async function readError(response: Response): Promise<string> {
  const body = (await response.json()) as { error?: unknown };
  return typeof body.error === "string" ? body.error : "";
}

describe("POST /api/realtime/session", () => {
  it("returns a sanitized 503 when the server key is missing", async () => {
    const response = await route.POST(createValidRequest());

    expect(response.status).toBe(503);
    expect(await readError(response)).toBe(
      "El servicio de voz no está configurado en el servidor.",
    );
    expect(response.headers.get("X-Realtime-Model")).toBe("gpt-realtime-2.1");
  });

  it("rejects cross-origin and browser-looking requests without an origin signal", async () => {
    const crossOrigin = await route.POST(
      createValidRequest({
        Origin: "https://attacker.example",
        "Sec-Fetch-Site": "cross-site",
      }),
    );
    const missingSignal = await route.POST(
      new Request(ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "Mozilla/5.0",
          "X-Forwarded-For": "203.0.113.11",
        },
        body: JSON.stringify({ sdp: OFFER_SDP, practice: {} }),
      }),
    );

    expect(crossOrigin.status).toBe(403);
    expect(missingSignal.status).toBe(403);
  });

  it("keeps an explicit non-browser path for local curl diagnostics", async () => {
    const request = new Request(ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "curl/8.0",
        "X-Forwarded-For": "127.0.0.1",
      },
      body: JSON.stringify({ sdp: OFFER_SDP, practice: {} }),
    });

    expect((await route.POST(request)).status).toBe(503);
  });

  it("stops oversized bodies and SDP offers with 413", async () => {
    const oversizedBody = createRequest(
      "x".repeat(route.MAX_REQUEST_BODY_BYTES + 1),
      { "X-Forwarded-For": "203.0.113.12" },
    );
    expect(oversizedBody.headers.has("content-length")).toBe(false);

    const bodyResponse = await route.POST(oversizedBody);
    expect(bodyResponse.status).toBe(413);

    const oversizedSdp = `${OFFER_SDP}a=x:${"a".repeat(route.MAX_SDP_BYTES)}`;
    const sdpResponse = await route.POST(
      createRequest(JSON.stringify({ sdp: oversizedSdp, practice: {} }), {
        "X-Forwarded-For": "203.0.113.13",
      }),
    );
    expect(sdpResponse.status).toBe(413);
  });

  it("rate-limits repeated session starts per IP", async () => {
    for (
      let attempt = 0;
      attempt < route.MAX_SESSION_STARTS_PER_MINUTE;
      attempt += 1
    ) {
      const response = await route.POST(
        createValidRequest({ "X-Forwarded-For": "203.0.113.14" }),
      );
      expect(response.status).toBe(503);
    }

    const response = await route.POST(
      createValidRequest({ "X-Forwarded-For": "203.0.113.14" }),
    );
    expect(response.status).toBe(429);
    expect(Number(response.headers.get("Retry-After"))).toBeGreaterThan(0);
  });

  it("limits concurrent upstream session initialization per IP", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-server-key");
    const resolvers: Array<(response: Response) => void> = [];
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolvers.push(resolve);
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const first = route.POST(
      createValidRequest({ "X-Forwarded-For": "203.0.113.15" }),
    );
    const second = route.POST(
      createValidRequest({ "X-Forwarded-For": "203.0.113.15" }),
    );
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    const third = await route.POST(
      createValidRequest({ "X-Forwarded-For": "203.0.113.15" }),
    );
    expect(third.status).toBe(429);

    resolvers[0](new Response(ANSWER_SDP, { status: 200 }));
    resolvers[1](new Response(ANSWER_SDP, { status: 200 }));
    const completed = await Promise.all([first, second]);
    expect(completed.map((response) => response.status)).toEqual([200, 200]);
  });

  it("sanitizes upstream errors instead of forwarding their body", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-server-key");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('{"error":{"message":"sensitive upstream detail"}}', {
        status: 401,
        headers: { "x-request-id": "req_test" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await route.POST(
      createValidRequest({ "X-Forwarded-For": "203.0.113.16" }),
    );
    const error = await readError(response);

    expect(response.status).toBe(502);
    expect(error).toBe("No se pudo iniciar la sesión de voz.");
    expect(error).not.toContain("sensitive upstream detail");
  });

  it("preserves the unified WebRTC multipart and plain-SDP response contract", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-server-key");
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(ANSWER_SDP, {
        status: 200,
        headers: { "Content-Type": "application/sdp" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await route.POST(
      createValidRequest({ "X-Forwarded-For": "203.0.113.17" }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/sdp");
    expect(response.headers.get("X-Realtime-Model")).toBe("gpt-realtime-2.1");
    expect(await response.text()).toBe(ANSWER_SDP);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("https://api.openai.com/v1/realtime/calls");
    expect(new Headers(init.headers).get("Authorization")).toBe(
      "Bearer test-server-key",
    );
    const form = init.body as FormData;
    expect(form.get("sdp")).toBe(OFFER_SDP);
    const session = JSON.parse(String(form.get("session"))) as {
      type?: unknown;
      model?: unknown;
      output_modalities?: unknown;
    };
    expect(session).toMatchObject({
      type: "realtime",
      model: "gpt-realtime-2.1",
      output_modalities: ["audio"],
    });
  });
});
