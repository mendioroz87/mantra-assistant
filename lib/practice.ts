export type PracticeKind = "mantra" | "language";
export type PracticeMode = "listen" | "line" | "complete";
export type CoachInterruption = "never" | "line" | "immediate";

export interface Practice {
  kind: PracticeKind;
  title: string;
  text: string;
  language: string;
  languageCode?: string;
  variant: string;
  tradition: string;
  mode: PracticeMode;
  coachInterruption: CoachInterruption;
  allowBargeIn: boolean;
  pace: number;
}

export const FIRE_MANTRA: Practice = {
  kind: "mantra",
  title: "Mantra del elemento fuego",
  text: [
    "om hriem hesraim hriem",
    "dhiem dhiem — kliem kliem",
    "saum saum",
    "mahaa agní swaruupa njeena namaha",
  ].join("\n"),
  language: "Mantra transliterado",
  variant: "Referencia por confirmar",
  tradition: "Sin tradición o maestro especificado",
  mode: "line",
  coachInterruption: "line",
  allowBargeIn: true,
  pace: 0.82,
};

export const LANGUAGE_OPTIONS = [
  { label: "Inglés", code: "en", variant: "General" },
  { label: "Español", code: "es", variant: "Internacional" },
  { label: "Francés", code: "fr", variant: "Francia" },
  { label: "Portugués", code: "pt", variant: "Brasil" },
  { label: "Alemán", code: "de", variant: "Estándar" },
  { label: "Italiano", code: "it", variant: "Estándar" },
  { label: "Japonés", code: "ja", variant: "Estándar" },
  { label: "Hindi", code: "hi", variant: "Estándar" },
] as const;

export function splitPracticeLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export function createLanguagePractice(
  text: string,
  language: { label: string; code: string; variant: string } = LANGUAGE_OPTIONS[0],
): Practice {
  return {
    kind: "language",
    title: `Práctica de ${language.label}`,
    text: text.trim() || "The rhythm of a language lives between its sounds.",
    language: language.label,
    languageCode: language.code,
    variant: language.variant,
    tradition: "",
    mode: "line",
    coachInterruption: "line",
    allowBargeIn: true,
    pace: 0.9,
  };
}

const MAX_TEXT_LENGTH = 4_000;

export function normalizePractice(input: unknown): Practice {
  const value = typeof input === "object" && input !== null ? input : {};
  const source = value as Partial<Practice>;
  const fallback = FIRE_MANTRA;
  const text = typeof source.text === "string" ? source.text.trim() : fallback.text;
  const pace = typeof source.pace === "number" ? source.pace : fallback.pace;

  return {
    kind: source.kind === "language" ? "language" : "mantra",
    title: cleanText(source.title, fallback.title, 120),
    text: (text || fallback.text).slice(0, MAX_TEXT_LENGTH),
    language: cleanText(source.language, fallback.language, 80),
    languageCode: cleanLanguageCode(source.languageCode),
    variant: cleanText(source.variant, fallback.variant, 100),
    tradition: cleanText(source.tradition, fallback.tradition, 160),
    mode:
      source.mode === "listen" || source.mode === "complete"
        ? source.mode
        : "line",
    coachInterruption:
      source.coachInterruption === "never" ||
      source.coachInterruption === "immediate"
        ? source.coachInterruption
        : "line",
    allowBargeIn: source.allowBargeIn !== false,
    pace: Math.min(1.2, Math.max(0.55, pace)),
  };
}

function cleanText(value: unknown, fallback: string, maxLength: number): string {
  if (typeof value !== "string") return fallback;
  const cleaned = value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "").trim();
  return (cleaned || fallback).slice(0, maxLength);
}

function cleanLanguageCode(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return /^[a-z]{2,3}(?:-[a-z]{2})?$/i.test(value) ? value.toLowerCase() : undefined;
}
