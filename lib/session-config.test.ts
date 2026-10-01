import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_REALTIME_MODEL,
  DEFAULT_REALTIME_VOICE,
  DEFAULT_TRANSCRIPTION_MODEL,
  PRONUNCIATION_FEEDBACK_TOOL,
  buildRealtimeSessionConfig,
  getRealtimeModel,
  getRealtimeVoice,
  getTranscriptionModel,
} from "@/lib/session-config";

const practice = {
  kind: "language",
  title: "Práctica breve",
  text: "bonjour tout le monde\nrouge",
  language: "Francés",
  languageCode: "fr-FR",
  variant: "Francia",
  tradition: "",
  mode: "line",
  coachInterruption: "line",
  allowBargeIn: true,
  pace: 0.8,
} as const;

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("buildRealtimeSessionConfig", () => {
  it("builds an audio-first pronunciation coaching session", () => {
    const session = buildRealtimeSessionConfig(practice, "gpt-realtime-2.1");

    expect(session).toMatchObject({
      type: "realtime",
      model: "gpt-realtime-2.1",
      output_modalities: ["audio"],
      reasoning: { effort: "low" },
      audio: {
        input: {
          transcription: {
            model: "gpt-live-transcribe",
            languages: ["fr"],
          },
          turn_detection: {
            type: "semantic_vad",
            eagerness: "auto",
            interrupt_response: true,
          },
        },
        output: { voice: "marin", speed: 0.8 },
      },
    });
    expect(session.audio.input.transcription.keywords).toContain("rouge");
    expect(session.instructions).toContain('1. "bonjour tout le monde"');
  });

  it.each([
    ["never", "low"],
    ["line", "auto"],
    ["immediate", "high"],
  ] as const)(
    "maps %s coaching to %s semantic VAD",
    (interruption, eagerness) => {
      const session = buildRealtimeSessionConfig({
        ...practice,
        coachInterruption: interruption,
        allowBargeIn: false,
      });

      expect(session.audio.input.turn_detection).toMatchObject({
        eagerness,
        interrupt_response: false,
      });
    },
  );

  it("exposes a strict feedback tool contract", () => {
    const [tool] = buildRealtimeSessionConfig(practice).tools;

    expect(tool.name).toBe(PRONUNCIATION_FEEDBACK_TOOL);
    expect(tool.parameters.additionalProperties).toBe(false);
    expect(tool.parameters.required).toEqual([
      "status",
      "confidence",
      "focus",
      "heard",
      "tip",
      "segment",
    ]);
    expect(tool.parameters.properties.status).toMatchObject({
      enum: ["excellent", "good", "retry"],
    });
  });

  it("omits unsupported transcription language codes", () => {
    const session = buildRealtimeSessionConfig({
      ...practice,
      languageCode: "not-a-language",
    });

    expect(session.audio.input.transcription).not.toHaveProperty("languages");
  });
});

describe("getRealtimeModel", () => {
  it("uses a safe configured model id", () => {
    expect(getRealtimeModel("  gpt-realtime-custom  ")).toBe(
      "gpt-realtime-custom",
    );
  });

  it("falls back when the configured id is unsafe", () => {
    expect(getRealtimeModel("gpt-realtime\r\nX-Leak: value")).toBe(
      DEFAULT_REALTIME_MODEL,
    );
  });
});

describe("server-side audio model settings", () => {
  it("applies transcription model and voice environment overrides", () => {
    vi.stubEnv("OPENAI_TRANSCRIPTION_MODEL", "gpt-transcribe");
    vi.stubEnv("OPENAI_REALTIME_VOICE", "cedar");

    const session = buildRealtimeSessionConfig(practice);

    expect(session.audio.input.transcription.model).toBe("gpt-transcribe");
    expect(session.audio.output.voice).toBe("cedar");
  });

  it("accepts safe transcription model ids and rejects header injection", () => {
    expect(getTranscriptionModel("gpt-live-transcribe-next")).toBe(
      "gpt-live-transcribe-next",
    );
    expect(getTranscriptionModel("bad\r\nX-Leak: value")).toBe(
      DEFAULT_TRANSCRIPTION_MODEL,
    );
  });

  it("accepts only documented built-in voices", () => {
    expect(getRealtimeVoice(" CEDAR ")).toBe("cedar");
    expect(getRealtimeVoice("unknown-voice")).toBe(DEFAULT_REALTIME_VOICE);
  });
});
