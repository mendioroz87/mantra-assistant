import { buildLiveSessionConfig, LIVE_MODEL } from "@/lib/live-config";
import { isIP } from "node:net";

export const runtime = "nodejs";

const OPENAI_LIVE_SESSIONS_URL = "https://api.openai.com/v1/live/sessions";
export const MAX_SDP_BYTES = 64 * 1024;
export const MAX_REQUEST_BODY_BYTES = MAX_SDP_BYTES + 32 * 1024;
export const MAX_SESSION_STARTS_PER_MINUTE = 8;
export const MAX_CONCURRENT_SESSION_STARTS = 2;
const UPSTREAM_TIMEOUT_MS = 25_000;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_BUCKET_TTL_MS = RATE_LIMIT_WINDOW_MS * 2;
const MAX_TRACKED_CLIENTS = 10_000;
const OVERFLOW_CLIENT_KEY = "overflow";

interface AdmissionBucket {
  attempts: number;
  inFlight: number;
  lastSeenAt: number;
  windowStartedAt: number;
}

type AdmissionDecision =
  | { ok: true; release: () => void }
  | { ok: false; retryAfterSeconds: number };

const admissionBuckets = new Map<string, AdmissionBucket>();
let nextAdmissionSweepAt = 0;

class RequestBodyTooLargeError extends Error {}

type RequestPayload = {
  sdp?: unknown;
  practice?: unknown;
};

export async function POST(request: Request): Promise<Response> {
  const model = LIVE_MODEL;

  if (!isBestEffortSameOrigin(request)) {
    return jsonError("Solicitud de origen no permitido.", 403, model);
  }

  if (!isJsonRequest(request)) {
    return jsonError("El cuerpo debe usar application/json.", 415, model);
  }

  const admission = acquireAdmission(request);
  if (!admission.ok) {
    const response = jsonError(
      "Demasiados intentos de iniciar una sesión. Espera un momento.",
      429,
      model,
    );
    response.headers.set("Retry-After", String(admission.retryAfterSeconds));
    return response;
  }

  try {
    return await handleAdmittedRequest(request, model);
  } finally {
    admission.release();
  }
}

async function handleAdmittedRequest(
  request: Request,
  model: string,
): Promise<Response> {
  const declaredLength = Number(request.headers.get("content-length"));
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > MAX_REQUEST_BODY_BYTES
  ) {
    return jsonError("La solicitud es demasiado grande.", 413, model);
  }

  let rawBody: string;
  try {
    rawBody = await readRequestBody(request, MAX_REQUEST_BODY_BYTES);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return jsonError("La solicitud es demasiado grande.", 413, model);
    }
    return jsonError("No se pudo leer la solicitud.", 400, model);
  }

  let payload: RequestPayload;
  try {
    const parsed: unknown = JSON.parse(rawBody);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return jsonError("El cuerpo JSON no es válido.", 400, model);
    }
    payload = parsed as RequestPayload;
  } catch {
    return jsonError("El cuerpo JSON no es válido.", 400, model);
  }

  const sdpValidation = validateSdp(payload.sdp);
  if (!sdpValidation.ok) {
    return jsonError(sdpValidation.error, sdpValidation.status, model);
  }

  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    return jsonError(
      "El servicio de voz no está configurado en el servidor.",
      503,
      model,
    );
  }

  const session = buildLiveSessionConfig(payload.practice);
  const body = JSON.stringify({ session, transport: { type: "webrtc", sdp: sdpValidation.sdp } });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);

  try {
    const upstream = await fetch(OPENAI_LIVE_SESSIONS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body,
      cache: "no-store",
      signal: controller.signal,
    });

    const answerSdp = await upstream.text();

    if (!upstream.ok) {
      console.error("[live/session] OpenAI rechazó la sesión", {
        status: upstream.status,
        requestId: upstream.headers.get("x-request-id") ?? undefined,
      });

      const status = upstream.status === 429 ? 429 : upstream.status === 403 ? 403 : 502;
      const response = jsonError(
        status === 403
          ? "El proyecto de OpenAI no tiene acceso a GPT-Live-1."
          : status === 429
          ? "El servicio de voz está ocupado. Inténtalo de nuevo en un momento."
          : "No se pudo iniciar la sesión de voz.",
        status,
        session.model,
      );
      const retryAfter = upstream.headers.get("retry-after");
      if (status === 429 && retryAfter) {
        response.headers.set("Retry-After", retryAfter);
      }
      return response;
    }

    let result: { session?: { id?: string }; transport?: { sdp?: string } };
    try { result = JSON.parse(answerSdp); } catch { result = {}; }
    const sdp = result.transport?.sdp;
    if (typeof sdp !== "string" || !sdp.startsWith("v=0") || typeof result.session?.id !== "string") {
      return jsonError("OpenAI devolvi\u00f3 una respuesta Live inv\u00e1lida.", 502, model);
    }
    // Only client-safe fields; preserve SDP and the opaque session ID exactly.
    return Response.json({ sdp, sessionId: result.session.id, model }, {
      status: 201,
      headers: responseHeaders(model, "application/json; charset=utf-8"),
    });
  } catch (error) {
    const timedOut = controller.signal.aborted;
    console.error(
      `[live/session] Falló la conexión con OpenAI (${timedOut ? "timeout" : error instanceof Error ? error.name : "unknown"})`,
    );
    return jsonError(
      timedOut
        ? "La sesión de voz tardó demasiado en responder."
        : "No se pudo conectar con el servicio de voz.",
      timedOut ? 504 : 502,
      session.model,
    );
  } finally {
    clearTimeout(timeout);
  }
}

function isJsonRequest(request: Request): boolean {
  return (
    request.headers
      .get("content-type")
      ?.split(";", 1)[0]
      ?.trim()
      .toLowerCase() === "application/json"
  );
}

function validateSdp(
  input: unknown,
): { ok: true; sdp: string } | { ok: false; error: string; status: 400 | 413 } {
  if (typeof input !== "string" || input.length === 0) {
    return { ok: false, error: "Falta una oferta SDP válida.", status: 400 };
  }

  if (byteLength(input) > MAX_SDP_BYTES) {
    return {
      ok: false,
      error: "La oferta SDP es demasiado grande.",
      status: 413,
    };
  }

  if (
    !/^v=0(?:\r?\n)/.test(input) ||
    !/(?:^|\r?\n)m=audio(?:\s|$)/m.test(input) ||
    /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(input)
  ) {
    return { ok: false, error: "La oferta SDP no es válida.", status: 400 };
  }

  return { ok: true, sdp: input };
}

function isBestEffortSameOrigin(request: Request): boolean {
  const fetchSite = request.headers.get("sec-fetch-site")?.toLowerCase();
  const suppliedOrigin = request.headers.get("origin");
  const referer = request.headers.get("referer");

  if (fetchSite) {
    if (fetchSite !== "same-origin") return false;
    const suppliedLocation = suppliedOrigin || referer;
    return !suppliedLocation || originMatchesRequest(suppliedLocation, request);
  }

  if (suppliedOrigin) return originMatchesRequest(suppliedOrigin, request);
  if (referer) return originMatchesRequest(referer, request);

  // Modern browsers send Origin and/or Sec-Fetch-* for a JSON POST. Reject a
  // browser-looking request that omits both signals, while retaining a clear
  // no-browser path for local curl/Postman diagnostics.
  return !hasBrowserRequestSignal(request);
}

function hasBrowserRequestSignal(request: Request): boolean {
  return Boolean(
    request.headers.get("sec-fetch-mode") ||
      request.headers.get("sec-fetch-dest") ||
      request.headers.get("sec-ch-ua") ||
      /\bMozilla\//i.test(request.headers.get("user-agent") ?? ""),
  );
}

function originMatchesRequest(value: string, request: Request): boolean {
  let supplied: string;
  try {
    supplied = new URL(value).origin;
  } catch {
    return false;
  }

  const allowed = new Set<string>();
  const requestUrl = new URL(request.url);
  allowed.add(requestUrl.origin);

  const forwardedHost = firstHeaderValue(
    request.headers.get("x-forwarded-host"),
  );
  const host = forwardedHost || firstHeaderValue(request.headers.get("host"));
  const forwardedProtocol = firstHeaderValue(
    request.headers.get("x-forwarded-proto"),
  )?.toLowerCase();
  const protocol =
    forwardedProtocol === "http" || forwardedProtocol === "https"
      ? `${forwardedProtocol}:`
      : requestUrl.protocol;

  if (host) {
    try {
      allowed.add(new URL(`${protocol}//${host}`).origin);
    } catch {
      // The URL-derived origin above remains the safe fallback.
    }
  }

  return supplied !== "null" && allowed.has(supplied);
}

function firstHeaderValue(value: string | null): string | undefined {
  return value?.split(",", 1)[0]?.trim() || undefined;
}

function acquireAdmission(
  request: Request,
  now = Date.now(),
): AdmissionDecision {
  sweepAdmissionBuckets(now);

  let clientKey = getClientKey(request);
  if (
    !admissionBuckets.has(clientKey) &&
    admissionBuckets.size >= MAX_TRACKED_CLIENTS
  ) {
    clientKey = OVERFLOW_CLIENT_KEY;
  }

  let bucket = admissionBuckets.get(clientKey);
  if (!bucket) {
    bucket = {
      attempts: 0,
      inFlight: 0,
      lastSeenAt: now,
      windowStartedAt: now,
    };
    admissionBuckets.set(clientKey, bucket);
  }

  if (now - bucket.windowStartedAt >= RATE_LIMIT_WINDOW_MS) {
    bucket.attempts = 0;
    bucket.windowStartedAt = now;
  }

  bucket.lastSeenAt = now;
  if (bucket.attempts >= MAX_SESSION_STARTS_PER_MINUTE) {
    return {
      ok: false,
      retryAfterSeconds: Math.max(
        1,
        Math.ceil(
          (bucket.windowStartedAt + RATE_LIMIT_WINDOW_MS - now) / 1_000,
        ),
      ),
    };
  }

  bucket.attempts += 1;
  if (bucket.inFlight >= MAX_CONCURRENT_SESSION_STARTS) {
    return { ok: false, retryAfterSeconds: 1 };
  }

  bucket.inFlight += 1;
  let released = false;

  return {
    ok: true,
    release: () => {
      if (released) return;
      released = true;
      bucket.inFlight = Math.max(0, bucket.inFlight - 1);
      bucket.lastSeenAt = Date.now();
    },
  };
}

function sweepAdmissionBuckets(now: number): void {
  if (now < nextAdmissionSweepAt) return;
  nextAdmissionSweepAt = now + RATE_LIMIT_WINDOW_MS;

  for (const [clientKey, bucket] of admissionBuckets) {
    if (
      bucket.inFlight === 0 &&
      now - bucket.lastSeenAt >= RATE_LIMIT_BUCKET_TTL_MS
    ) {
      admissionBuckets.delete(clientKey);
    }
  }
}

function getClientKey(request: Request): string {
  const candidates = [
    request.headers.get("cf-connecting-ip"),
    request.headers.get("x-real-ip"),
    request.headers.get("x-forwarded-for"),
  ];

  for (const rawCandidate of candidates) {
    const candidate = normalizeIp(firstHeaderValue(rawCandidate));
    if (candidate) return candidate;
  }

  return "unknown";
}

function normalizeIp(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (isIP(value)) return value;

  const bracketedIpv6 = value.match(/^\[([^\]]+)\](?::\d{1,5})?$/);
  if (bracketedIpv6 && isIP(bracketedIpv6[1]) === 6) {
    return bracketedIpv6[1];
  }

  const ipv4WithPort = value.match(/^(\d{1,3}(?:\.\d{1,3}){3}):\d{1,5}$/);
  return ipv4WithPort && isIP(ipv4WithPort[1]) === 4
    ? ipv4WithPort[1]
    : undefined;
}

async function readRequestBody(
  request: Request,
  limit: number,
): Promise<string> {
  if (!request.body) return "";

  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      totalBytes += value.byteLength;
      if (totalBytes > limit) {
        try {
          await reader.cancel();
        } catch {
          // The hard byte limit has already been enforced.
        }
        throw new RequestBodyTooLargeError();
      }

      chunks.push(decoder.decode(value, { stream: true }));
    }

    chunks.push(decoder.decode());
    return chunks.join("");
  } finally {
    reader.releaseLock();
  }
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function jsonError(message: string, status: number, model: string): Response {
  return Response.json(
    { error: message },
    {
      status,
      headers: responseHeaders(model, "application/json; charset=utf-8"),
    },
  );
}

function responseHeaders(model: string, contentType: string): HeadersInit {
  return {
    "Cache-Control": "no-store",
    "Content-Type": contentType,
    "X-Content-Type-Options": "nosniff",
    "X-Live-Model": model,
  };
}
