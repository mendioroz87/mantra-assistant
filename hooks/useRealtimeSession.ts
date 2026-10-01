"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import { splitPracticeLines } from "@/lib/practice";
import type {
  PronunciationFeedback,
  PronunciationFeedbackStatus,
  RealtimeServerEvent,
  RealtimeStatus,
  RealtimeTranscript,
  UseRealtimeSessionOptions,
  UseRealtimeSessionResult,
} from "@/lib/realtime-types";

const DEFAULT_MODEL = "gpt-realtime-2.1";
const SESSION_ENDPOINT = "/api/realtime/session";
const MAX_COMMAND_LENGTH = 2_000;
const STARTUP_TIMEOUT_MS = 30_000;
const DISCONNECT_GRACE_MS = 5_000;
const RESPONSE_TOKEN_KEY = "client_response_token";

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(value: UnknownRecord, key: string): string | undefined {
  const field = value[key];
  return typeof field === "string" ? field : undefined;
}

function numberField(value: UnknownRecord, key: string): number | undefined {
  const field = value[key];
  return typeof field === "number" && Number.isFinite(field) ? field : undefined;
}

function createEventId(prefix = "client"): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `${prefix}_${crypto.randomUUID()}`;
  }

  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

function cleanCommand(command: string): string {
  return command
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
    .trim()
    .slice(0, MAX_COMMAND_LENGTH);
}

function normalizeFeedback(
  value: unknown,
  callId: string,
  segmentIndex: number | null,
): PronunciationFeedback {
  const report = isRecord(value) ? value : {};
  const rawStatus = stringField(report, "status");
  const status: PronunciationFeedbackStatus =
    rawStatus === "excellent" || rawStatus === "good" || rawStatus === "retry"
      ? rawStatus
      : "retry";

  return {
    id: createEventId("feedback"),
    callId,
    status,
    confidence: Math.min(1, Math.max(0, numberField(report, "confidence") ?? 0)),
    focus: stringField(report, "focus")?.trim() ?? "",
    heard: stringField(report, "heard")?.trim() ?? "",
    tip: stringField(report, "tip")?.trim() ?? "",
    segment: stringField(report, "segment")?.trim() ?? "",
    segmentIndex,
    createdAt: Date.now(),
  };
}

function errorMessage(error: unknown): string {
  if (error instanceof DOMException) {
    if (error.name === "NotAllowedError" || error.name === "SecurityError") {
      return "No se concedió acceso al micrófono. Revisa el permiso del navegador e inténtalo de nuevo.";
    }
    if (error.name === "NotFoundError" || error.name === "DevicesNotFoundError") {
      return "No se encontró un micrófono disponible.";
    }
    if (error.name === "NotReadableError" || error.name === "TrackStartError") {
      return "El micrófono está siendo usado por otra aplicación o no está disponible.";
    }
    if (error.name === "AbortError") {
      return "Se canceló la conexión de voz.";
    }
  }

  if (error instanceof Error && error.message.trim()) return error.message;
  return "No se pudo iniciar la sesión de voz.";
}

function readApiError(body: string, status: number): string {
  try {
    const parsed: unknown = JSON.parse(body);
    if (isRecord(parsed) && typeof parsed.error === "string") {
      return parsed.error;
    }
  } catch {
    // The API can return plain text for gateway and proxy errors.
  }

  const safeBody = body.trim().slice(0, 300);
  return safeBody || `No se pudo crear la sesión de voz (HTTP ${status}).`;
}

function serverResponseId(event: RealtimeServerEvent): string | undefined {
  const direct = stringField(event, "response_id");
  if (direct) return direct;
  return isRecord(event.response) ? stringField(event.response, "id") : undefined;
}

function serverResponseToken(event: RealtimeServerEvent): string | undefined {
  if (!isRecord(event.response) || !isRecord(event.response.metadata)) {
    return undefined;
  }
  return stringField(event.response.metadata, RESPONSE_TOKEN_KEY);
}

function upsertTranscript(
  transcripts: RealtimeTranscript[],
  incoming: RealtimeTranscript,
  append: boolean,
): RealtimeTranscript[] {
  const index = transcripts.findIndex((entry) => entry.id === incoming.id);
  if (index === -1) return [...transcripts, incoming];

  const current = transcripts[index];
  const next = [...transcripts];
  next[index] = {
    ...current,
    ...incoming,
    text: append ? current.text + incoming.text : incoming.text || current.text,
  };
  return next;
}

export function useRealtimeSession({
  practice,
  onFeedback,
  onEvent,
  onError,
}: UseRealtimeSessionOptions): UseRealtimeSessionResult {
  const initialSegment = splitPracticeLines(practice.text).length > 0 ? 0 : null;
  const [status, setStatus] = useState<RealtimeStatus>("ready");
  const [model, setModel] = useState(DEFAULT_MODEL);
  const [isConnected, setIsConnected] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [micLevel, setMicLevel] = useState(0);
  const [inputTranscript, setInputTranscript] = useState("");
  const [outputTranscript, setOutputTranscript] = useState("");
  const [transcripts, setTranscripts] = useState<RealtimeTranscript[]>([]);
  const [feedback, setFeedback] = useState<PronunciationFeedback[]>([]);
  const [activeSegment, setActiveSegmentState] = useState<number | null>(
    initialSegment,
  );
  const [error, setError] = useState<string | null>(null);

  const mountedRef = useRef(false);
  const generationRef = useRef(0);
  const startingRef = useRef(false);
  const intentionalCloseRef = useRef(false);
  const statusRef = useRef<RealtimeStatus>("ready");
  const connectedRef = useRef(false);
  const mutedRef = useRef(false);
  const pausedRef = useRef(false);
  const activeSegmentRef = useRef<number | null>(initialSegment);
  const practiceRef = useRef(practice);
  const practiceIdentityRef = useRef(
    JSON.stringify([
      practice.kind,
      practice.language,
      practice.languageCode,
      practice.text,
      practice.title,
      practice.tradition,
      practice.variant,
    ]),
  );
  const onFeedbackRef = useRef(onFeedback);
  const onEventRef = useRef(onEvent);
  const onErrorRef = useRef(onError);

  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const dataChannelRef = useRef<RTCDataChannel | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioElementRef = useRef<HTMLAudioElement | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const analyserSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const meterFrameRef = useRef<number | null>(null);
  const meterValueRef = useRef(0);
  const fetchAbortRef = useRef<AbortController | null>(null);
  const startupTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const disconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const responseActiveRef = useRef(false);
  const activeResponseIdRef = useRef<string | null>(null);
  const desiredResponseTokenRef = useRef<string | null>(null);
  const responseTokensRef = useRef(new Map<string, string>());
  const audioPlayingRef = useRef(false);
  const processedCallIdsRef = useRef(new Set<string>());

  const changeStatus = useCallback((next: RealtimeStatus) => {
    statusRef.current = next;
    if (mountedRef.current) setStatus(next);
  }, []);

  const changeConnected = useCallback((next: boolean) => {
    connectedRef.current = next;
    if (mountedRef.current) setIsConnected(next);
  }, []);

  const publishError = useCallback(
    (message: string, fatal = true) => {
      if (mountedRef.current) setError(message);
      if (fatal) changeStatus("error");
      try {
        onErrorRef.current?.(message);
      } catch {
        // A consumer callback must not break the media loop.
      }
    },
    [changeStatus],
  );

  const releaseResources = useCallback(() => {
    if (startupTimerRef.current !== null) {
      clearTimeout(startupTimerRef.current);
      startupTimerRef.current = null;
    }

    if (disconnectTimerRef.current !== null) {
      clearTimeout(disconnectTimerRef.current);
      disconnectTimerRef.current = null;
    }

    fetchAbortRef.current?.abort();
    fetchAbortRef.current = null;

    if (meterFrameRef.current !== null) {
      cancelAnimationFrame(meterFrameRef.current);
      meterFrameRef.current = null;
    }
    meterValueRef.current = 0;
    if (mountedRef.current) setMicLevel(0);

    try {
      analyserSourceRef.current?.disconnect();
      analyserRef.current?.disconnect();
    } catch {
      // Nodes may already be disconnected during browser/device teardown.
    }
    analyserSourceRef.current = null;
    analyserRef.current = null;

    const audioContext = audioContextRef.current;
    audioContextRef.current = null;
    if (audioContext && audioContext.state !== "closed") {
      void audioContext.close().catch(() => undefined);
    }

    mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
    mediaStreamRef.current = null;

    const dataChannel = dataChannelRef.current;
    dataChannelRef.current = null;
    if (dataChannel) {
      dataChannel.onopen = null;
      dataChannel.onclose = null;
      dataChannel.onerror = null;
      dataChannel.onmessage = null;
      if (dataChannel.readyState !== "closed") dataChannel.close();
    }

    const peerConnection = peerConnectionRef.current;
    peerConnectionRef.current = null;
    if (peerConnection) {
      peerConnection.ontrack = null;
      peerConnection.onconnectionstatechange = null;
      peerConnection.oniceconnectionstatechange = null;
      peerConnection.close();
    }

    const audioElement = audioElementRef.current;
    audioElementRef.current = null;
    if (audioElement) {
      audioElement.pause();
      audioElement.srcObject = null;
      audioElement.removeAttribute("src");
    }

    responseActiveRef.current = false;
    activeResponseIdRef.current = null;
    desiredResponseTokenRef.current = null;
    responseTokensRef.current.clear();
    audioPlayingRef.current = false;
    processedCallIdsRef.current.clear();
  }, []);

  const closeWithError = useCallback(
    (message: string) => {
      intentionalCloseRef.current = true;
      generationRef.current += 1;
      startingRef.current = false;
      releaseResources();
      mutedRef.current = false;
      pausedRef.current = false;
      changeConnected(false);
      if (mountedRef.current) {
        setIsMuted(false);
        setIsPaused(false);
      }
      publishError(message);
    },
    [changeConnected, publishError, releaseResources],
  );

  const emitEvent = useCallback(
    (event: UnknownRecord, reportDisconnected = false): boolean => {
      const dataChannel = dataChannelRef.current;
      if (!dataChannel || dataChannel.readyState !== "open") {
        if (reportDisconnected) {
          publishError(
            "La sesión de voz no está conectada. Iníciala antes de enviar un comando.",
            false,
          );
        }
        return false;
      }

      try {
        dataChannel.send(JSON.stringify(event));
        return true;
      } catch (sendError) {
        publishError(errorMessage(sendError));
        return false;
      }
    },
    [publishError],
  );

  const requestResponse = useCallback(
    (response: UnknownRecord = {}): boolean => {
      const token = createEventId("turn");
      const metadata = isRecord(response.metadata) ? response.metadata : {};
      const sent = emitEvent({
        event_id: createEventId("response"),
        type: "response.create",
        response: {
          ...response,
          metadata: { ...metadata, [RESPONSE_TOKEN_KEY]: token },
        },
      });

      if (sent) {
        desiredResponseTokenRef.current = token;
        activeResponseIdRef.current = null;
        responseActiveRef.current = true;
      }
      return sent;
    },
    [emitEvent],
  );

  const recordTranscript = useCallback(
    (entry: RealtimeTranscript, append: boolean) => {
      if (!mountedRef.current) return;
      setTranscripts((current) => upsertTranscript(current, entry, append));
    },
    [],
  );

  const handleFeedbackCalls = useCallback(
    (event: RealtimeServerEvent, continueConversation: boolean): boolean => {
      const response = isRecord(event.response) ? event.response : null;
      const output = response && Array.isArray(response.output) ? response.output : [];
      let handledCall = false;
      let acknowledgedCall = false;

      for (const candidate of output) {
        if (!isRecord(candidate)) continue;
        if (
          candidate.type !== "function_call" ||
          candidate.name !== "report_pronunciation_feedback"
        ) {
          continue;
        }

        const callId = stringField(candidate, "call_id");
        if (!callId || processedCallIdsRef.current.has(callId)) continue;
        processedCallIdsRef.current.add(callId);
        handledCall = true;

        let outputPayload: UnknownRecord;
        try {
          const rawArguments = stringField(candidate, "arguments") ?? "{}";
          const parsedArguments: unknown = JSON.parse(rawArguments);
          const report = normalizeFeedback(
            parsedArguments,
            callId,
            activeSegmentRef.current,
          );

          if (mountedRef.current) {
            setFeedback((current) => [...current, report]);
          }
          try {
            onFeedbackRef.current?.(report);
          } catch {
            // A consumer callback must not prevent the tool acknowledgement.
          }
          outputPayload = { ok: true, feedback_id: report.id };
        } catch {
          outputPayload = {
            ok: false,
            error: "Los argumentos del reporte no eran JSON válido.",
          };
        }

        acknowledgedCall =
          emitEvent({
            event_id: createEventId("tool_output"),
            type: "conversation.item.create",
            item: {
              type: "function_call_output",
              call_id: callId,
              output: JSON.stringify(outputPayload),
            },
          }) || acknowledgedCall;
      }

      if (acknowledgedCall && continueConversation) requestResponse();

      return handledCall;
    },
    [emitEvent, requestResponse],
  );

  const handleServerEvent = useCallback(
    (event: RealtimeServerEvent) => {
      try {
        onEventRef.current?.(event);
      } catch {
        // Event observers are optional and cannot be allowed to stop handling.
      }

      const itemId = stringField(event, "item_id");
      const responseId = serverResponseId(event);
      const responseToken = serverResponseToken(event);
      const contentIndex = numberField(event, "content_index") ?? 0;
      if (responseId && responseToken) {
        responseTokensRef.current.set(responseId, responseToken);
      }

      const belongsToCurrentResponse = () => {
        if (!responseId) return true;
        if (activeResponseIdRef.current) {
          return activeResponseIdRef.current === responseId;
        }
        const knownToken =
          responseToken ?? responseTokensRef.current.get(responseId);
        return Boolean(
          knownToken && knownToken === desiredResponseTokenRef.current,
        );
      };

      switch (event.type) {
        case "session.created":
        case "session.updated":
          if (!pausedRef.current) changeStatus("listening");
          break;

        case "input_audio_buffer.speech_started":
          if (!pausedRef.current) {
            setInputTranscript("");
            if (
              !audioPlayingRef.current &&
              statusRef.current !== "speaking"
            ) {
              changeStatus("listening");
            }
          }
          break;

        case "input_audio_buffer.speech_stopped":
        case "input_audio_buffer.committed":
          if (!pausedRef.current) {
            changeStatus(audioPlayingRef.current ? "speaking" : "analyzing");
          }
          break;

        case "conversation.item.input_audio_transcription.delta": {
          const delta = stringField(event, "delta") ?? "";
          const id = `input:${itemId ?? "current"}`;
          if (delta) {
            setInputTranscript((current) => current + delta);
            recordTranscript(
              {
                id,
                itemId,
                role: "user",
                source: "audio",
                text: delta,
                isFinal: false,
                createdAt: Date.now(),
              },
              true,
            );
          }
          break;
        }

        case "conversation.item.input_audio_transcription.completed":
        case "conversation.item.input_audio_transcription.done": {
          const completed =
            stringField(event, "transcript") ?? stringField(event, "text") ?? "";
          const id = `input:${itemId ?? "current"}`;
          if (completed) setInputTranscript(completed);
          recordTranscript(
            {
              id,
              itemId,
              role: "user",
              source: "audio",
              text: completed,
              isFinal: true,
              createdAt: Date.now(),
            },
            false,
          );
          break;
        }

        case "response.created": {
          const createdToken =
            responseToken ?? (responseId ? `server_${responseId}` : null);
          const isExpected =
            !responseToken ||
            !desiredResponseTokenRef.current ||
            responseToken === desiredResponseTokenRef.current;
          if (!isExpected) break;

          if (responseId && createdToken) {
            responseTokensRef.current.set(responseId, createdToken);
          }
          desiredResponseTokenRef.current = createdToken;
          activeResponseIdRef.current = responseId ?? null;
          responseActiveRef.current = true;
          setOutputTranscript("");
          if (!pausedRef.current && !audioPlayingRef.current) {
            changeStatus("analyzing");
          }
          break;
        }

        case "response.output_audio.delta":
          if (belongsToCurrentResponse()) {
            audioPlayingRef.current = true;
            if (!pausedRef.current) changeStatus("speaking");
          }
          break;

        case "output_audio_buffer.started":
          audioPlayingRef.current = true;
          if (!pausedRef.current) changeStatus("speaking");
          break;

        case "response.output_audio_transcript.delta": {
          const delta = stringField(event, "delta") ?? "";
          const id = `output:${responseId ?? "current"}:${itemId ?? "item"}:${contentIndex}`;
          if (delta) {
            recordTranscript(
              {
                id,
                itemId,
                responseId,
                role: "assistant",
                source: "audio",
                text: delta,
                isFinal: false,
                createdAt: Date.now(),
              },
              true,
            );
            if (belongsToCurrentResponse()) {
              setOutputTranscript((current) => current + delta);
              audioPlayingRef.current = true;
              if (!pausedRef.current) changeStatus("speaking");
            }
          }
          break;
        }

        case "response.output_audio_transcript.done": {
          const completed =
            stringField(event, "transcript") ?? stringField(event, "text") ?? "";
          const id = `output:${responseId ?? "current"}:${itemId ?? "item"}:${contentIndex}`;
          recordTranscript(
            {
              id,
              itemId,
              responseId,
              role: "assistant",
              source: "audio",
              text: completed,
              isFinal: true,
              createdAt: Date.now(),
            },
            false,
          );
          if (completed && belongsToCurrentResponse()) {
            setOutputTranscript(completed);
          }
          break;
        }

        case "response.output_text.delta": {
          const delta = stringField(event, "delta") ?? "";
          const id = `output-text:${responseId ?? "current"}:${itemId ?? "item"}:${contentIndex}`;
          if (delta) {
            recordTranscript(
              {
                id,
                itemId,
                responseId,
                role: "assistant",
                source: "text",
                text: delta,
                isFinal: false,
                createdAt: Date.now(),
              },
              true,
            );
            if (belongsToCurrentResponse()) {
              setOutputTranscript((current) => current + delta);
            }
          }
          break;
        }

        case "response.output_text.done": {
          const completed =
            stringField(event, "text") ?? stringField(event, "transcript") ?? "";
          const id = `output-text:${responseId ?? "current"}:${itemId ?? "item"}:${contentIndex}`;
          recordTranscript(
            {
              id,
              itemId,
              responseId,
              role: "assistant",
              source: "text",
              text: completed,
              isFinal: true,
              createdAt: Date.now(),
            },
            false,
          );
          if (completed && belongsToCurrentResponse()) {
            setOutputTranscript(completed);
          }
          break;
        }

        case "response.output_audio.done":
          // Generation is complete, but WebRTC may still be playing buffered audio.
          break;

        case "output_audio_buffer.stopped":
        case "output_audio_buffer.cleared":
          audioPlayingRef.current = false;
          if (!pausedRef.current) {
            changeStatus(responseActiveRef.current ? "analyzing" : "listening");
          }
          break;

        case "response.cancelled": {
          if (!belongsToCurrentResponse()) break;
          activeResponseIdRef.current = null;
          desiredResponseTokenRef.current = null;
          responseActiveRef.current = false;
          if (!pausedRef.current) {
            changeStatus(audioPlayingRef.current ? "speaking" : "listening");
          }
          break;
        }

        case "response.done": {
          const isCurrent = belongsToCurrentResponse();
          if (isCurrent) {
            activeResponseIdRef.current = null;
            desiredResponseTokenRef.current = null;
            responseActiveRef.current = false;
          }

          const handledFeedback = handleFeedbackCalls(event, isCurrent);
          if (responseId) responseTokensRef.current.delete(responseId);

          if (isCurrent && !pausedRef.current) {
            if (handledFeedback || responseActiveRef.current) {
              changeStatus("analyzing");
            } else {
              changeStatus(audioPlayingRef.current ? "speaking" : "listening");
            }
          }
          break;
        }

        case "error": {
          const nestedError = isRecord(event.error) ? event.error : null;
          const message =
            (nestedError && stringField(nestedError, "message")) ||
            stringField(event, "message") ||
            "La sesión Realtime informó de un error.";
          publishError(message);
          break;
        }
      }
    },
    [changeStatus, handleFeedbackCalls, publishError, recordTranscript],
  );

  const startMeter = useCallback((stream: MediaStream, generation: number) => {
    if (typeof window === "undefined" || !window.AudioContext) return;

    try {
      const audioContext = new window.AudioContext();
      const source = audioContext.createMediaStreamSource(stream);
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.75;
      source.connect(analyser);

      audioContextRef.current = audioContext;
      analyserSourceRef.current = source;
      analyserRef.current = analyser;
      void audioContext.resume().catch(() => undefined);

      const samples = new Uint8Array(analyser.fftSize);
      const measure = () => {
        if (generationRef.current !== generation || !analyserRef.current) return;

        let level = 0;
        if (!mutedRef.current && !pausedRef.current) {
          analyser.getByteTimeDomainData(samples);
          let sumSquares = 0;
          for (const sample of samples) {
            const normalized = (sample - 128) / 128;
            sumSquares += normalized * normalized;
          }
          const rms = Math.sqrt(sumSquares / samples.length);
          level = Math.min(1, rms * 4.5);
        }

        const smoothed = meterValueRef.current * 0.7 + level * 0.3;
        if (Math.abs(smoothed - meterValueRef.current) > 0.003) {
          meterValueRef.current = smoothed;
          if (mountedRef.current) setMicLevel(smoothed);
        }
        meterFrameRef.current = requestAnimationFrame(measure);
      };

      meterFrameRef.current = requestAnimationFrame(measure);
    } catch {
      // Metering is progressive enhancement; voice can continue without it.
    }
  }, []);

  const start = useCallback(async (): Promise<boolean> => {
    if (startingRef.current) return false;
    if (connectedRef.current) return true;

    if (
      typeof window === "undefined" ||
      typeof RTCPeerConnection === "undefined" ||
      !navigator.mediaDevices?.getUserMedia
    ) {
      publishError("Este navegador no admite sesiones de voz WebRTC.");
      return false;
    }

    startingRef.current = true;
    intentionalCloseRef.current = true;
    releaseResources();
    const generation = ++generationRef.current;
    intentionalCloseRef.current = false;
    mutedRef.current = false;
    pausedRef.current = false;
    responseActiveRef.current = false;
    if (mountedRef.current) {
      setError(null);
      setModel(DEFAULT_MODEL);
      setIsMuted(false);
      setIsPaused(false);
      setInputTranscript("");
      setOutputTranscript("");
      setTranscripts([]);
      setFeedback([]);
    }
    changeConnected(false);
    changeStatus("connecting");
    startupTimerRef.current = setTimeout(() => {
      if (generationRef.current === generation && !connectedRef.current) {
        closeWithError(
          "La conexión de voz tardó demasiado. Vuelve a iniciar la sesión.",
        );
      }
    }, STARTUP_TIMEOUT_MS);

    let localStream: MediaStream | null = null;
    try {
      localStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });

      if (generationRef.current !== generation) {
        localStream.getTracks().forEach((track) => track.stop());
        return false;
      }

      mediaStreamRef.current = localStream;
      startMeter(localStream, generation);

      const peerConnection = new RTCPeerConnection();
      peerConnectionRef.current = peerConnection;

      const remoteAudio = document.createElement("audio");
      remoteAudio.autoplay = true;
      remoteAudio.setAttribute("playsinline", "true");
      remoteAudio.setAttribute("aria-hidden", "true");
      audioElementRef.current = remoteAudio;

      peerConnection.ontrack = (trackEvent) => {
        if (generationRef.current !== generation) return;
        const remoteStream =
          trackEvent.streams[0] ?? new MediaStream([trackEvent.track]);
        remoteAudio.srcObject = remoteStream;
        void remoteAudio.play().catch(() => {
          publishError(
            "El navegador bloqueó el audio del coach. Interactúa con la página y vuelve a intentarlo.",
            false,
          );
        });
      };

      for (const track of localStream.getAudioTracks()) {
        peerConnection.addTrack(track, localStream);
      }

      const dataChannel = peerConnection.createDataChannel("oai-events");
      dataChannelRef.current = dataChannel;

      dataChannel.onopen = () => {
        if (generationRef.current !== generation) return;
        if (startupTimerRef.current !== null) {
          clearTimeout(startupTimerRef.current);
          startupTimerRef.current = null;
        }
        changeConnected(true);
        if (!pausedRef.current) changeStatus("listening");

        const segmentIndex = activeSegmentRef.current;
        const lines = splitPracticeLines(practiceRef.current.text);
        const activeLine =
          segmentIndex !== null && lines[segmentIndex]
            ? lines[segmentIndex]
            : lines[0] ?? practiceRef.current.text.trim();
        if (segmentIndex !== null && activeLine) {
          emitEvent({
            event_id: createEventId("context"),
            type: "conversation.item.create",
            item: {
              type: "message",
              role: "user",
              content: [
                {
                  type: "input_text",
                  text: `[Contexto de la interfaz — no respondas todavía] El fragmento activo es el ${segmentIndex + 1}: "${activeLine}". Úsalo como objetivo del próximo intento.`,
                },
              ],
            },
          });
        }

        const started = requestResponse({
          instructions: activeLine
            ? `Empieza ahora la práctica. Saluda en una sola oración muy breve, demuestra exactamente una vez el fragmento "${activeLine}" al ritmo configurado (${practiceRef.current.pace.toFixed(2)}x) e invita a la persona a repetirlo. No añadas explicaciones todavía.`
            : "Empieza ahora la práctica con un saludo de una sola oración breve e invita a la persona a decir qué desea practicar.",
        });
        if (started) {
          changeStatus("analyzing");
        }
      };

      dataChannel.onmessage = (message) => {
        const parseMessage = (raw: string) => {
          if (generationRef.current !== generation) return;
          try {
            const parsed: unknown = JSON.parse(raw);
            if (isRecord(parsed) && typeof parsed.type === "string") {
              handleServerEvent(parsed as RealtimeServerEvent);
            }
          } catch {
            // Ignore malformed/non-event messages without interrupting audio.
          }
        };

        if (typeof message.data === "string") {
          parseMessage(message.data);
        } else if (message.data instanceof Blob) {
          void message.data.text().then(parseMessage).catch(() => undefined);
        } else if (message.data instanceof ArrayBuffer) {
          parseMessage(new TextDecoder().decode(message.data));
        }
      };

      dataChannel.onerror = () => {
        if (generationRef.current === generation && !intentionalCloseRef.current) {
          closeWithError("Falló el canal de eventos de la sesión de voz.");
        }
      };

      dataChannel.onclose = () => {
        if (generationRef.current !== generation) return;
        changeConnected(false);
        if (!intentionalCloseRef.current) {
          closeWithError("La sesión de voz se desconectó.");
        }
      };

      peerConnection.onconnectionstatechange = () => {
        if (
          generationRef.current !== generation ||
          peerConnectionRef.current !== peerConnection
        ) {
          return;
        }

        if (peerConnection.connectionState === "connected") {
          if (disconnectTimerRef.current !== null) {
            clearTimeout(disconnectTimerRef.current);
            disconnectTimerRef.current = null;
          }
          return;
        }

        if (peerConnection.connectionState === "disconnected") {
          if (disconnectTimerRef.current !== null) {
            clearTimeout(disconnectTimerRef.current);
          }
          disconnectTimerRef.current = setTimeout(() => {
            if (
              generationRef.current === generation &&
              peerConnection?.connectionState === "disconnected"
            ) {
              closeWithError(
                "La conexión de voz se perdió. Vuelve a iniciar la sesión.",
              );
            }
          }, DISCONNECT_GRACE_MS);
          return;
        }

        if (
          peerConnection.connectionState === "failed" ||
          (peerConnection.connectionState === "closed" &&
            !intentionalCloseRef.current)
        ) {
          closeWithError("No se pudo mantener la conexión de voz WebRTC.");
        }
      };

      const offer = await peerConnection.createOffer();
      await peerConnection.setLocalDescription(offer);
      const sdp = peerConnection.localDescription?.sdp ?? offer.sdp;
      if (!sdp) throw new Error("El navegador no pudo crear una oferta de audio.");

      const abortController = new AbortController();
      fetchAbortRef.current = abortController;
      const sessionResponse = await fetch(SESSION_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sdp, practice: practiceRef.current }),
        signal: abortController.signal,
      });
      fetchAbortRef.current = null;
      const responseBody = await sessionResponse.text();

      if (generationRef.current !== generation) return false;
      if (!sessionResponse.ok) {
        throw new Error(readApiError(responseBody, sessionResponse.status));
      }

      // SDP is line-oriented: removing its final CRLF can make libwebrtc reject
      // the last attribute (e.g. a=ice-pwd) as an invalid SDP line.
      let answerSdp = responseBody;
      let responseModel = sessionResponse.headers.get("X-Realtime-Model");
      const contentType = sessionResponse.headers.get("Content-Type") ?? "";
      if (contentType.includes("application/json") || answerSdp.trimStart().startsWith("{")) {
        const parsed: unknown = JSON.parse(answerSdp);
        if (!isRecord(parsed) || typeof parsed.sdp !== "string") {
          throw new Error("El servidor no devolvió una respuesta SDP válida.");
        }
        answerSdp = parsed.sdp;
        if (typeof parsed.model === "string") responseModel = parsed.model;
      }
      if (!answerSdp.trim()) {
        throw new Error("El servidor devolvió una respuesta SDP vacía.");
      }

      if (mountedRef.current) setModel(responseModel?.trim() || DEFAULT_MODEL);
      await peerConnection.setRemoteDescription({
        type: "answer",
        sdp: answerSdp,
      });

      return generationRef.current === generation;
    } catch (startError) {
      if (generationRef.current !== generation) {
        localStream?.getTracks().forEach((track) => track.stop());
        return false;
      }

      intentionalCloseRef.current = true;
      releaseResources();
      changeConnected(false);
      publishError(errorMessage(startError));
      return false;
    } finally {
      if (generationRef.current === generation) startingRef.current = false;
    }
  }, [
    changeConnected,
    changeStatus,
    closeWithError,
    emitEvent,
    handleServerEvent,
    publishError,
    releaseResources,
    requestResponse,
    startMeter,
  ]);

  const stop = useCallback(() => {
    intentionalCloseRef.current = true;
    generationRef.current += 1;
    startingRef.current = false;
    releaseResources();
    connectedRef.current = false;
    mutedRef.current = false;
    pausedRef.current = false;
    if (mountedRef.current) {
      setIsConnected(false);
      setIsMuted(false);
      setIsPaused(false);
      setInputTranscript("");
      setOutputTranscript("");
      setTranscripts([]);
      setFeedback([]);
      setError(null);
    }
    changeStatus("ready");
  }, [changeStatus, releaseResources]);

  const applyTrackState = useCallback(() => {
    const enabled = !mutedRef.current && !pausedRef.current;
    mediaStreamRef.current?.getAudioTracks().forEach((track) => {
      track.enabled = enabled;
    });
    if (!enabled && mountedRef.current) setMicLevel(0);
  }, []);

  const mute = useCallback((): boolean => {
    if (!mediaStreamRef.current) return false;
    mutedRef.current = true;
    if (mountedRef.current) setIsMuted(true);
    applyTrackState();
    return true;
  }, [applyTrackState]);

  const unmute = useCallback((): boolean => {
    if (!mediaStreamRef.current) return false;
    mutedRef.current = false;
    if (mountedRef.current) setIsMuted(false);
    applyTrackState();
    return true;
  }, [applyTrackState]);

  const toggleMute = useCallback((): boolean => {
    return mutedRef.current ? unmute() : mute();
  }, [mute, unmute]);

  const pause = useCallback((): boolean => {
    if (!connectedRef.current || pausedRef.current) return false;
    const wasSpeaking = statusRef.current === "speaking";
    pausedRef.current = true;
    if (mountedRef.current) setIsPaused(true);
    applyTrackState();

    if (responseActiveRef.current) {
      emitEvent({ type: "response.cancel" });
      activeResponseIdRef.current = null;
      desiredResponseTokenRef.current = null;
      responseActiveRef.current = false;
    }
    if (wasSpeaking) emitEvent({ type: "output_audio_buffer.clear" });
    audioElementRef.current?.pause();
    changeStatus("paused");
    return true;
  }, [applyTrackState, changeStatus, emitEvent]);

  const resume = useCallback((): boolean => {
    if (!connectedRef.current || !pausedRef.current) return false;
    pausedRef.current = false;
    if (mountedRef.current) setIsPaused(false);
    applyTrackState();
    const audioElement = audioElementRef.current;
    if (audioElement?.srcObject) {
      void audioElement.play().catch(() => undefined);
    }
    changeStatus(audioPlayingRef.current ? "speaking" : "listening");
    return true;
  }, [applyTrackState, changeStatus]);

  const sendTextCommand = useCallback(
    (command: string): boolean => {
      const cleaned = cleanCommand(command);
      if (!cleaned) return false;
      if (!connectedRef.current || pausedRef.current) {
        publishError(
          pausedRef.current
            ? "La sesión está pausada. Reanúdala antes de enviar un comando."
            : "La sesión de voz no está conectada. Iníciala antes de enviar un comando.",
          false,
        );
        return false;
      }

      if (mountedRef.current) setError(null);
      const wasSpeaking = statusRef.current === "speaking";
      if (responseActiveRef.current) {
        emitEvent({ type: "response.cancel" });
        activeResponseIdRef.current = null;
        desiredResponseTokenRef.current = null;
        responseActiveRef.current = false;
      }
      if (wasSpeaking) emitEvent({ type: "output_audio_buffer.clear" });

      const eventId = createEventId("command");
      const sentMessage = emitEvent(
        {
          event_id: eventId,
          type: "conversation.item.create",
          item: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: cleaned }],
          },
        },
        true,
      );
      if (!sentMessage) return false;

      const requestedResponse = requestResponse();
      if (!requestedResponse) return false;

      recordTranscript(
        {
          id: `input-text:${eventId}`,
          role: "user",
          source: "text",
          text: cleaned,
          isFinal: true,
          createdAt: Date.now(),
        },
        false,
      );
      setInputTranscript(cleaned);
      setOutputTranscript("");
      changeStatus(audioPlayingRef.current ? "speaking" : "analyzing");
      return true;
    },
    [
      changeStatus,
      emitEvent,
      publishError,
      recordTranscript,
      requestResponse,
    ],
  );

  const sendContextCommand = useCallback(
    (command: string): boolean => {
      const cleaned = cleanCommand(command);
      if (!cleaned) return false;
      return emitEvent(
        {
          event_id: createEventId("context"),
          type: "conversation.item.create",
          item: {
            type: "message",
            role: "user",
            content: [
              {
                type: "input_text",
                text: `[Contexto de la interfaz — no respondas todavía] ${cleaned}`,
              },
            ],
          },
        },
        true,
      );
    },
    [emitEvent],
  );

  const setActiveSegment = useCallback(
    (segmentIndex: number | null): boolean => {
      const lines = splitPracticeLines(practiceRef.current.text);
      if (
        segmentIndex !== null &&
        (!Number.isInteger(segmentIndex) ||
          segmentIndex < 0 ||
          segmentIndex >= lines.length)
      ) {
        return false;
      }

      activeSegmentRef.current = segmentIndex;
      if (mountedRef.current) setActiveSegmentState(segmentIndex);

      if (!connectedRef.current || segmentIndex === null) return true;
      return emitEvent({
        event_id: createEventId("context"),
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text: `[Contexto de la interfaz — no respondas todavía] El fragmento activo es el ${segmentIndex + 1}: "${lines[segmentIndex]}". Evalúa el próximo intento contra este fragmento.`,
            },
          ],
        },
      });
    },
    [emitEvent],
  );

  const repeatReference = useCallback(
    (segmentIndex?: number): boolean => {
      const lines = splitPracticeLines(practiceRef.current.text);
      const requestedIndex = segmentIndex ?? activeSegmentRef.current;
      const target =
        requestedIndex !== null &&
        requestedIndex !== undefined &&
        Number.isInteger(requestedIndex) &&
        lines[requestedIndex]
          ? lines[requestedIndex]
          : practiceRef.current.text.trim();
      if (!target) return false;

      return sendTextCommand(
        `Repite como referencia solamente este fragmento, primero al ritmo configurado y después lentamente: "${target}".`,
      );
    },
    [sendTextCommand],
  );

  const clearTranscripts = useCallback(() => {
    if (!mountedRef.current) return;
    setInputTranscript("");
    setOutputTranscript("");
    setTranscripts([]);
  }, []);

  useEffect(() => {
    practiceRef.current = practice;
    onFeedbackRef.current = onFeedback;
    onEventRef.current = onEvent;
    onErrorRef.current = onError;
  }, [onError, onEvent, onFeedback, practice]);

  useEffect(() => {
    const nextIdentity = JSON.stringify([
      practice.kind,
      practice.language,
      practice.languageCode,
      practice.text,
      practice.title,
      practice.tradition,
      practice.variant,
    ]);
    if (practiceIdentityRef.current === nextIdentity) return;
    practiceIdentityRef.current = nextIdentity;

    const lineCount = splitPracticeLines(practice.text).length;
    const nextSegment = lineCount > 0 ? 0 : null;
    activeSegmentRef.current = nextSegment;
    setActiveSegmentState(nextSegment);
    setInputTranscript("");
    setOutputTranscript("");
    setTranscripts([]);
    setFeedback([]);
  }, [
    practice.kind,
    practice.language,
    practice.languageCode,
    practice.text,
    practice.title,
    practice.tradition,
    practice.variant,
  ]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      intentionalCloseRef.current = true;
      generationRef.current += 1;
      startingRef.current = false;
      releaseResources();
    };
  }, [releaseResources]);

  return {
    status,
    model,
    isConnected,
    isMuted,
    isPaused,
    micLevel,
    inputTranscript,
    outputTranscript,
    transcripts,
    feedback,
    activeSegment,
    error,
    start,
    stop,
    mute,
    unmute,
    toggleMute,
    pause,
    resume,
    sendTextCommand,
    repeatReference,
    setActiveSegment,
    sendContextCommand,
    clearTranscripts,
  };
}
