import type { Practice } from "@/lib/practice";

export type RealtimeStatus =
  | "ready"
  | "connecting"
  | "listening"
  | "speaking"
  | "analyzing"
  | "paused"
  | "error";

export type TranscriptRole = "user" | "assistant";
export type TranscriptSource = "audio" | "text";

export interface RealtimeTranscript {
  id: string;
  itemId?: string;
  responseId?: string;
  role: TranscriptRole;
  source: TranscriptSource;
  text: string;
  isFinal: boolean;
  createdAt: number;
}

export type PronunciationFeedbackStatus = "excellent" | "good" | "retry";

/**
 * A client-safe rendering of the report_pronunciation_feedback tool arguments.
 * The client records this report and acknowledges it to the Realtime model; it
 * does not perform a second pronunciation assessment locally.
 */
export interface PronunciationFeedback {
  source?: "coach-summary";
  id: string;
  callId: string;
  status: PronunciationFeedbackStatus;
  confidence: number;
  focus: string;
  heard: string;
  tip: string;
  segment: string;
  segmentIndex: number | null;
  createdAt: number;
}

export interface RealtimeServerEvent {
  type: string;
  event_id?: string;
  [key: string]: unknown;
}

export interface UseRealtimeSessionOptions {
  practice: Practice;
  onFeedback?: (feedback: PronunciationFeedback) => void;
  onEvent?: (event: RealtimeServerEvent) => void;
  onError?: (message: string) => void;
}

export interface UseRealtimeSessionResult {
  status: RealtimeStatus;
  model: string;
  isConnected: boolean;
  isMuted: boolean;
  isPaused: boolean;
  micLevel: number;
  inputTranscript: string;
  outputTranscript: string;
  transcripts: RealtimeTranscript[];
  feedback: PronunciationFeedback[];
  activeSegment: number | null;
  error: string | null;
  start: () => Promise<boolean>;
  stop: () => void;
  mute: () => boolean;
  unmute: () => boolean;
  toggleMute: () => boolean;
  pause: () => boolean;
  resume: () => boolean;
  sendTextCommand: (command: string) => boolean;
  repeatReference: (segmentIndex?: number) => boolean;
  setActiveSegment: (segmentIndex: number | null) => boolean;
  sendContextCommand: (command: string) => boolean;
  clearTranscripts: () => void;
}
