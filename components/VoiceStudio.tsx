"use client";

import { AnimatePresence, motion } from "motion/react";
import {
  Flame,
  Languages,
  Menu,
  Mic,
  MicOff,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Settings2,
  Square,
  Volume2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLiveSession as useRealtimeSession } from "@/hooks/useLiveSession";
import {
  createLanguagePractice,
  FIRE_MANTRA,
  LANGUAGE_OPTIONS,
  splitPracticeLines,
  type CoachInterruption,
  type Practice,
  type PracticeKind,
  type PracticeMode,
} from "@/lib/practice";
import type {
  PronunciationFeedback,
  RealtimeStatus,
  RealtimeTranscript,
} from "@/lib/realtime-types";
import { VoiceOrb } from "./VoiceOrb";

const STATUS_COPY: Record<
  RealtimeStatus,
  { label: string; detail: string; header: string }
> = {
  ready: {
    label: "Preparado",
    detail: "Tu voz no se está enviando",
    header: "Sin conectar",
  },
  connecting: {
    label: "Conectando",
    detail: "Abriendo un canal WebRTC seguro",
    header: "Conectando",
  },
  listening: {
    label: "Escuchando",
    detail: "Habla con naturalidad",
    header: "Sesión activa",
  },
  speaking: {
    label: "Coach hablando",
    detail: "Puedes hablar para interrumpir",
    header: "Coach hablando",
  },
  analyzing: {
    label: "Analizando",
    detail: "Sonido, ritmo y acento",
    header: "Analizando intento",
  },
  paused: {
    label: "En pausa",
    detail: "El micrófono está detenido",
    header: "Sesión en pausa",
  },
  error: {
    label: "Sin conexión",
    detail: "Revisa la configuración del servidor",
    header: "Atención necesaria",
  },
};

const MODE_LABELS: Record<PracticeMode, string> = {
  listen: "Solo escuchar",
  line: "Frase por frase",
  complete: "Texto completo",
};

const INTERRUPTION_LABELS: Record<CoachInterruption, string> = {
  never: "Nunca",
  line: "Al final del verso",
  immediate: "En la primera pausa",
};

const DEMO_FEEDBACK: PronunciationFeedback = {
  id: "demo-feedback",
  callId: "demo-call",
  status: "good",
  confidence: 0.86,
  focus: "Duración de la vocal",
  heard: "La vocal central quedó un poco breve.",
  tip: "Sostén ‘hriem’ un pulso más sin añadir otra sílaba.",
  segment: "hriem",
  segmentIndex: 0,
  createdAt: Date.now(),
};

const DEMO_TRANSCRIPTS: RealtimeTranscript[] = [
  {
    id: "demo-assistant",
    role: "assistant",
    source: "audio",
    text: "Escucha primero el verso completo. Después lo repetimos juntos, sin prisa.",
    isFinal: true,
    createdAt: Date.now(),
  },
  {
    id: "demo-user",
    role: "user",
    source: "audio",
    text: "om hriem hesraim hriem",
    isFinal: true,
    createdAt: Date.now() + 1,
  },
];

type DemoStatus = RealtimeStatus | null;

interface PracticeDraft {
  kind: PracticeKind;
  title: string;
  text: string;
  languageCode: string;
  variant: string;
  tradition: string;
}

export function VoiceStudio({ voiceConfigured = true }: { voiceConfigured?: boolean }) {
  const [startupError, setStartupError] = useState<string | null>(null);
  const [practice, setPractice] = useState<Practice>(FIRE_MANTRA);
  const [activeSegment, setActiveSegmentState] = useState(0);
  const [subtitles, setSubtitles] = useState(true);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [composerOpen, setComposerOpen] = useState(false);
  const [draft, setDraft] = useState<PracticeDraft>(() => toDraft(FIRE_MANTRA));
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [demoStatus, setDemoStatus] = useState<DemoStatus>(null);
  const [demoFeedback, setDemoFeedback] = useState<PronunciationFeedback | null>(
    null,
  );
  const demoTimers = useRef<number[]>([]);
  const composerRef = useRef<HTMLElement | null>(null);
  const composerTriggerRef = useRef<HTMLElement | null>(null);

  const realtime = useRealtimeSession({ practice });
  const stopSessionRef = useRef(realtime.stop);
  useEffect(() => { stopSessionRef.current = realtime.stop; }, [realtime.stop]);
  useEffect(() => {
    if (realtime.status !== "connecting") return;
    const timer = window.setTimeout(() => {
      stopSessionRef.current();
      setStartupError("No se pudo conectar en 15 segundos. Revisa el permiso del micrófono y tu conexión, y vuelve a intentarlo.");
    }, 15_000);
    return () => window.clearTimeout(timer);
  }, [realtime.status]);
  const visibleError = startupError ?? realtime.error;
  const lines = useMemo(() => splitPracticeLines(practice.text), [practice.text]);
  const isDemo = demoStatus !== null;
  const effectiveStatus = demoStatus ?? (visibleError && !realtime.isConnected ? "error" : realtime.status);
  const isLive = realtime.isConnected || isDemo;
  const statusCopy =
    effectiveStatus === "speaking" && !practice.allowBargeIn
      ? {
          ...STATUS_COPY.speaking,
          detail: "El coach intentará terminar su referencia breve",
        }
      : STATUS_COPY[effectiveStatus];
  const primaryActionLabel = isLive
    ? "Finalizar"
    : effectiveStatus === "connecting"
      ? "Cancelar"
      : "Comenzar práctica";
  const compactPrimaryActionLabel =
    primaryActionLabel === "Comenzar práctica" ? "Comenzar" : primaryActionLabel;
  const latestFeedback = demoFeedback ?? realtime.feedback.at(-1) ?? null;
  const transcriptItems = isDemo ? DEMO_TRANSCRIPTS : realtime.transcripts;
  const latestCaption = getLatestCaption(
    effectiveStatus,
    realtime.inputTranscript,
    realtime.outputTranscript,
    transcriptItems,
    isDemo,
    practice.allowBargeIn,
  );

  const clearDemoTimers = useCallback(() => {
    demoTimers.current.forEach((timer) => window.clearTimeout(timer));
    demoTimers.current = [];
  }, []);

  const stopPractice = useCallback(() => {
    clearDemoTimers();
    setDemoStatus(null);
    setDemoFeedback(null);
    realtime.stop();
    setElapsedSeconds(0);
  }, [clearDemoTimers, realtime]);

  useEffect(() => {
    if (!isLive) return;
    const timer = window.setInterval(
      () => setElapsedSeconds((seconds) => seconds + 1),
      1_000,
    );
    return () => window.clearInterval(timer);
  }, [isLive]);

  useEffect(() => {
    return () => clearDemoTimers();
  }, [clearDemoTimers]);

  useEffect(() => {
    if (!composerOpen) return;

    const dialog = composerRef.current;
    const previousFocus = composerTriggerRef.current;
    const focusableSelector =
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setComposerOpen(false);
        return;
      }

      if (event.key !== "Tab" || !dialog) return;
      const focusable = Array.from(
        dialog.querySelectorAll<HTMLElement>(focusableSelector),
      ).filter((element) => !element.hidden);
      if (!focusable.length) {
        event.preventDefault();
        dialog.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable.at(-1) ?? first;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, [composerOpen]);

  async function handlePrimaryAction() {
    if (isLive || realtime.status === "connecting") {
      stopPractice();
      return;
    }

    if (!voiceConfigured) {
      setStartupError("La voz no está habilitada: falta configurar OpenAI en el servidor. Puedes explorar la demo visual, sin audio ni micrófono.");
      return;
    }
    setStartupError(null);
    setElapsedSeconds(0);
    try {
      await realtime.start();
    } catch {
      realtime.stop();
      setStartupError("No se pudo iniciar la conexión. Vuelve a intentarlo.");
    }
  }

  function startVisualDemo() {
    setStartupError(null);
    realtime.stop();
    clearDemoTimers();
    setElapsedSeconds(0);
    setDemoFeedback(null);
    setDemoStatus("connecting");

    const schedule = (delay: number, action: () => void) => {
      demoTimers.current.push(window.setTimeout(action, delay));
    };

    schedule(700, () => setDemoStatus("speaking"));
    schedule(2_800, () => setDemoStatus("listening"));
    schedule(5_600, () => setDemoStatus("analyzing"));
    schedule(6_800, () => {
      setDemoFeedback({ ...DEMO_FEEDBACK, createdAt: Date.now() });
      setDemoStatus("listening");
    });
  }

  function chooseSegment(index: number) {
    setActiveSegmentState(index);
    realtime.setActiveSegment(index);
  }

  function updatePractice<K extends keyof Practice>(key: K, value: Practice[K]) {
    setPractice((current) => ({ ...current, [key]: value }));
  }

  function openComposer(kind: PracticeKind = practice.kind) {
    const source = kind === practice.kind ? practice : kind === "mantra" ? FIRE_MANTRA : createLanguagePractice("");
    composerTriggerRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setDraft(toDraft(source));
    setComposerOpen(true);
    setLibraryOpen(false);
  }

  function applyDraft() {
    const languageOption =
      LANGUAGE_OPTIONS.find((option) => option.code === draft.languageCode) ??
      LANGUAGE_OPTIONS[0];
    const next =
      draft.kind === "language"
        ? {
            ...createLanguagePractice(draft.text, languageOption),
            title: draft.title.trim() || `Práctica de ${languageOption.label}`,
            variant: draft.variant.trim() || languageOption.variant,
          }
        : {
            ...FIRE_MANTRA,
            title: draft.title.trim() || FIRE_MANTRA.title,
            text: draft.text.trim() || FIRE_MANTRA.text,
            variant: draft.variant.trim() || FIRE_MANTRA.variant,
            tradition: draft.tradition.trim() || FIRE_MANTRA.tradition,
          };

    setPractice(next);
    setActiveSegmentState(0);
    realtime.setActiveSegment(0);
    setComposerOpen(false);
  }

  function repeatActiveSegment() {
    if (isDemo) {
      setDemoStatus("speaking");
      demoTimers.current.push(
        window.setTimeout(() => setDemoStatus("listening"), 1_800),
      );
      return;
    }
    realtime.repeatReference(activeSegment);
  }

  function sendQuickCommand(command: string) {
    if (isDemo) {
      setDemoStatus("analyzing");
      demoTimers.current.push(
        window.setTimeout(() => setDemoStatus("listening"), 900),
      );
      return;
    }
    realtime.sendTextCommand(command);
  }

  const selectedLine = lines[activeSegment] ?? lines[0] ?? practice.text;
  const feedbackPresentation = getFeedbackPresentation(latestFeedback);

  return (
    <main className="studio" data-status={effectiveStatus}>
      <header className="topbar">
        <button
          className="brand"
          type="button"
          aria-label="Abrir biblioteca de prácticas"
          aria-controls="practice-library"
          aria-expanded={libraryOpen}
          onClick={() => setLibraryOpen((open) => { setInspectorOpen(false); return !open; })}
        >
          <span className="brand__mark" />
          <span className="brand__name">Voz Clara</span>
        </button>

        <div className="session-state" role="status" aria-live="polite">
          <span className="session-state__dot" />
          <span>{statusCopy.header}</span>
          {isLive ? <span>· {formatElapsed(elapsedSeconds)}</span> : null}
        </div>

        <div className="topbar__actions">
          <div className="model-tag" aria-label={`Modelo de voz: ${realtime.model}`}>
            <span>Modelo de voz</span>
            <strong>{realtime.model}</strong>
          </div>
          <button
            className="icon-button mobile-only"
            type="button"
            aria-label={latestFeedback ? "Abrir ajustes y último feedback" : "Abrir ajustes"}
            aria-controls="practice-inspector"
            aria-expanded={inspectorOpen}
            onClick={() => setInspectorOpen((open) => { setLibraryOpen(false); return !open; })}
          >
            <Settings2 size={19} />
          </button>
        </div>
      </header>

      <div className="workspace">
        {libraryOpen || inspectorOpen ? (
          <button className="panel-scrim" aria-label="Cerrar paneles" onClick={() => { setLibraryOpen(false); setInspectorOpen(false); }} />
        ) : null}
        <aside id="practice-library" className="practice-rail" data-open={libraryOpen} aria-label="Biblioteca">
          <p className="panel-kicker">Prácticas</p>
          <nav className="practice-list" aria-label="Tipo de práctica">
            <button
              className="practice-item"
              type="button"
              aria-current={practice.kind === "mantra"}
              disabled={isLive}
              onClick={() => {
                setPractice(FIRE_MANTRA);
                setActiveSegmentState(0);
                realtime.setActiveSegment(0);
                setLibraryOpen(false);
              }}
            >
              <span className="practice-item__glyph"><Flame size={13} /></span>
              <span>
                <strong>Elemento fuego</strong>
                <small>Mantra · 4 versos</small>
              </span>
            </button>
            <button
              className="practice-item"
              type="button"
              aria-current={practice.kind === "language"}
              disabled={isLive}
              onClick={() => openComposer("language")}
            >
              <span className="practice-item__glyph"><Languages size={13} /></span>
              <span>
                <strong>Pronunciación libre</strong>
                <small>Idiomas · tu propio texto</small>
              </span>
            </button>
          </nav>

          <button
            className="text-button"
            type="button"
            disabled={isLive}
            onClick={() => openComposer(practice.kind)}
          >
            <Plus size={15} /> Editar práctica
          </button>

          <div className="rail-note">
            <strong>Referencia responsable</strong>
            La transliteración puede variar entre tradiciones. Indica maestro o linaje; si una grabación experta es esencial, úsala como referencia fuera de esta versión.
          </div>
        </aside>

        <section className="stage" aria-label="Estudio de voz">
          <div className="stage__meta">
            <span>{practice.language} · {practice.variant}</span>
            <span>{String(activeSegment + 1).padStart(2, "0")} / {String(Math.max(lines.length, 1)).padStart(2, "0")}</span>
          </div>

          <div className="practice-canvas">
            <motion.div
              className="mantra-block"
              key={`${practice.kind}-${practice.title}`}
              initial={{ opacity: 0, x: -16 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
            >
              <p className="mantra-block__eyebrow">
                {practice.kind === "mantra" ? "Práctica elemental" : "Práctica de idioma"}
              </p>
              <h1>{practice.title}</h1>
              <p className="practice-instruction">Selecciona una frase y comienza a practicar.</p>
              <div className="segments" aria-label="Segmentos de práctica">
                {lines.map((line, index) => (
                  <button
                    className="segment"
                    type="button"
                    key={`${index}-${line}`}
                    aria-current={activeSegment === index}
                    onClick={() => chooseSegment(index)}
                  >
                    <span className="segment__index">{String(index + 1).padStart(2, "0")}</span>
                    <span className="segment__text">{line}</span>
                  </button>
                ))}
              </div>
            </motion.div>

            <div className="voice-field">
              <VoiceOrb
                status={effectiveStatus}
                micLevel={isDemo ? 0.56 : realtime.micLevel}
                label={statusCopy.label}
                detail={statusCopy.detail}
              />
              {subtitles ? (
                <div className="voice-caption" aria-live="polite">
                  <span className="voice-caption__speaker">{latestCaption.speaker}</span>
                  <span className="voice-caption__text">{latestCaption.text}</span>
                </div>
              ) : null}
            </div>
          </div>

          <div className="quick-commands" aria-label="Comandos rápidos">
            <button
              className="quick-command"
              type="button"
              disabled={!isLive}
              onClick={() => sendQuickCommand("Más lento, por favor.")}
            >
              Más lento
            </button>
            <button
              className="quick-command"
              type="button"
              disabled={!isLive}
              onClick={repeatActiveSegment}
            >
              Otra vez
            </button>
            <button
              className="quick-command"
              type="button"
              disabled={!isLive}
              onClick={() => sendQuickCommand("Corrígeme al final de la línea.")}
            >
              Al final
            </button>
            <button
              className="quick-command"
              type="button"
              disabled={!isLive}
              onClick={() => sendQuickCommand("Terminé este intento.")}
            >
              Terminé
            </button>
          </div>

          {latestFeedback && feedbackPresentation ? (
            <button
              className="feedback-peek"
              type="button"
              aria-live="polite"
              onClick={() => setInspectorOpen(true)}
            >
              <span>Último ajuste</span>
              <strong>{feedbackPresentation.label}</strong>
              <small>{latestFeedback.tip}</small>
            </button>
          ) : null}
        </section>

        <aside id="practice-inspector" className="inspector" data-open={inspectorOpen} aria-label="Ajustes y feedback">
          <section className="inspector-section">
            <div className="inspector-title">
              <h2>Sesión</h2>
              
            </div>

            <div className="setting">
              <div className="setting__row">
                <label htmlFor="practice-mode">Modo</label>
              </div>
              <select
                id="practice-mode"
                value={practice.mode}
                disabled={isLive}
                onChange={(event) => updatePractice("mode", event.target.value as PracticeMode)}
              >
                {Object.entries(MODE_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>{label}</option>
                ))}
              </select>
            </div>

            <div className="setting">
              <div className="setting__row">
                <label htmlFor="coach-interruption">El coach interviene</label>
              </div>
              <select
                id="coach-interruption"
                value={practice.coachInterruption}
                disabled={isLive}
                onChange={(event) =>
                  updatePractice("coachInterruption", event.target.value as CoachInterruption)
                }
              >
                {Object.entries(INTERRUPTION_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>{label}</option>
                ))}
              </select>
              <p className="setting-note">GPT-Live puede escuchar mientras habla. Esta opción guía cuándo ofrecer correcciones.</p>
            </div>

            <div className="setting">
              <div className="setting__row">
                <label htmlFor="pace">Ritmo orientativo</label>
                <span className="setting__value">{practice.pace.toFixed(2)}×</span>
              </div>
              <input
                id="pace"
                type="range"
                min="0.55"
                max="1.2"
                step="0.05"
                value={practice.pace}
                disabled={isLive}
                onChange={(event) => updatePractice("pace", Number(event.target.value))}
              />
            </div>

            <div className="setting">
              <div className="setting__row">
                <label id="barge-in-label">Preferir cederme la palabra</label>
                <button
                  className="toggle"
                  type="button"
                  role="switch"
                  aria-labelledby="barge-in-label"
                  aria-checked={practice.allowBargeIn}
                  disabled={isLive}
                  onClick={() => updatePractice("allowBargeIn", !practice.allowBargeIn)}
                />
              </div>
            </div>

            <div className="setting">
              <div className="setting__row">
                <label id="subtitles-label">Subtítulos</label>
                <button
                  className="toggle"
                  type="button"
                  role="switch"
                  aria-labelledby="subtitles-label"
                  aria-checked={subtitles}
                  onClick={() => setSubtitles((visible) => !visible)}
                />
              </div>
            </div>
          </section>

          <section className="inspector-section" aria-live="polite">
            <div className="inspector-title">
              <h2>Último intento</h2>
              <span>{latestFeedback ? "Resumen del coach" : "Esperando"}</span>
            </div>
            {latestFeedback && feedbackPresentation ? (
              <motion.div
                key={latestFeedback.id}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
              >
                <div className="feedback-status" data-tone={feedbackPresentation.tone}>
                  {feedbackPresentation.label}
                </div>
                <dl className="feedback-grid">
                  <div className="feedback-field">
                    <dt>Objetivo</dt>
                    <dd><strong>{latestFeedback.segment}</strong></dd>
                  </div>
                  <div className="feedback-field">
                    <dt>Escuché</dt>
                    <dd>{latestFeedback.heard}</dd>
                  </div>
                  <div className="feedback-field">
                    <dt>Enfoca</dt>
                    <dd>{latestFeedback.focus}</dd>
                  </div>
                  <div className="feedback-field">
                    <dt>Prueba</dt>
                    <dd>{latestFeedback.tip}</dd>
                  </div>
                </dl>
              </motion.div>
            ) : (
              <p className="feedback-empty">
                El coach escucha tu pronunciación. Aquí se resume su consejo cuando termina de registrarlo.
              </p>
            )}
          </section>

          <section className="inspector-section">
            <div className="inspector-title">
              <h2>Transcripción</h2>
              <button className="text-button" type="button" onClick={realtime.clearTranscripts}>Borrar</button>
            </div>
            <div className="transcript-log">
              {transcriptItems.length ? (
                transcriptItems.slice(-4).map((item) => (
                  <div className="transcript-line" data-speaker={item.role} key={item.id}>
                    <strong>{item.role === "assistant" ? "Coach" : "Tú"}</strong>
                    {item.text}
                  </div>
                ))
              ) : (
                <div className="transcript-line">
                  <strong>Privacidad</strong>
                  El audio no se guarda en esta app. La transcripción solo vive durante la sesión.
                </div>
              )}
            </div>
          </section>

        </aside>
      </div>

      <div className="session-notice" aria-live="polite">
        {visibleError ? (
          <div className="session-notice__error" role="alert">
            <strong>No se pudo iniciar la voz</strong>
            <span>{visibleError}</span>
            <button className="text-button" type="button" onClick={startVisualDemo}>Explorar demo visual</button>
          </div>
        ) : effectiveStatus === "connecting" && !isDemo ? (
          <p>Conectando… Si el navegador lo solicita, permite el acceso al micrófono. Puedes cancelar con el botón de abajo.</p>
        ) : isDemo ? (
          <p><strong>Demo visual</strong> · Simulación sin audio ni micrófono.</p>
        ) : !isLive ? (
          <button className="text-button" type="button" onClick={startVisualDemo}>Probar interfaz sin micrófono · Demo visual</button>
        ) : null}
      </div>

      <footer className="transport">
        <div className="transport__context">
          <strong>{selectedLine}</strong>
          <span>{practice.tradition || `${practice.language} · ${practice.variant}`}</span>
        </div>

        <div className="transport__controls">
          <button
            className="transport-button mobile-only"
            type="button"
            aria-label="Abrir biblioteca"
            aria-controls="practice-library"
            aria-expanded={libraryOpen}
            onClick={() => setLibraryOpen((open) => { setInspectorOpen(false); return !open; })}
          >
            <Menu size={18} />
          </button>
          <button
            className="transport-button"
            type="button"
            aria-label={realtime.isMuted ? "Activar micrófono" : "Silenciar micrófono"}
            disabled={!realtime.isConnected || isDemo}
            onClick={realtime.toggleMute}
          >
            {realtime.isMuted ? <MicOff size={18} /> : <Mic size={18} />}
          </button>
          <button
            className="transport-button transport-button--main"
            type="button"
            aria-label={primaryActionLabel}
            data-live={isLive || effectiveStatus === "connecting"}
            onClick={handlePrimaryAction}
          >
            {isLive || effectiveStatus === "connecting" ? <Square size={15} fill="currentColor" /> : <Play size={16} fill="currentColor" />}
            <span className="transport-button__main-label" aria-hidden="true">
              {primaryActionLabel}
            </span>
            <span className="transport-button__main-label--compact" aria-hidden="true">
              {compactPrimaryActionLabel}
            </span>
          </button>
          <button
            className="transport-button"
            type="button"
            aria-label={realtime.isPaused ? "Reanudar sesión" : "Pausar sesión"}
            disabled={!realtime.isConnected || isDemo}
            onClick={realtime.isPaused ? realtime.resume : realtime.pause}
          >
            {realtime.isPaused ? <Play size={18} /> : <Pause size={18} />}
          </button>
          <button
            className="transport-button"
            type="button"
            aria-label="Repetir referencia"
            disabled={!isLive}
            onClick={repeatActiveSegment}
          >
            <RotateCcw size={18} />
          </button>
        </div>

        <div className="transport__aux">
          <span className="transport__aux-copy">Auriculares recomendados<br />para evitar eco</span>
          <button
            className="transport-button"
            type="button"
            aria-label="Escuchar referencia"
            disabled={!isLive}
            onClick={repeatActiveSegment}
          >
            <Volume2 size={18} />
            <span className="transport-button__label--optional">Referencia</span>
          </button>
        </div>
      </footer>

      <AnimatePresence>
        {composerOpen ? (
          <motion.div
            className="composer-backdrop"
            role="presentation"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onMouseDown={(event) => {
              if (event.currentTarget === event.target) setComposerOpen(false);
            }}
          >
            <motion.section
              ref={composerRef}
              className="composer"
              role="dialog"
              aria-modal="true"
              aria-labelledby="composer-title"
              tabIndex={-1}
              initial={{ opacity: 0, y: 24, scale: 0.985 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 16, scale: 0.99 }}
              transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
            >
              <header className="composer__header">
                <div>
                  <h2 id="composer-title">Nueva práctica</h2>
                  <p>Pega un texto, define la referencia y trabaja una línea cada vez.</p>
                </div>
                <button className="icon-button" type="button" aria-label="Cerrar" onClick={() => setComposerOpen(false)}>
                  <X size={19} />
                </button>
              </header>

              <div className="composer__body">
                <div className="composer__switch" aria-label="Tipo de práctica">
                  <button type="button" aria-pressed={draft.kind === "mantra"} onClick={() => setDraft((current) => ({ ...current, kind: "mantra" }))}>
                    Mantra o canto
                  </button>
                  <button type="button" aria-pressed={draft.kind === "language"} onClick={() => setDraft((current) => ({ ...current, kind: "language" }))}>
                    Idioma
                  </button>
                </div>

                <div className="composer__grid">
                  <label>
                    Título
                    <input autoFocus value={draft.title} onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))} />
                  </label>
                  {draft.kind === "language" ? (
                    <label>
                      Idioma
                      <select value={draft.languageCode} onChange={(event) => {
                        const option = LANGUAGE_OPTIONS.find((item) => item.code === event.target.value) ?? LANGUAGE_OPTIONS[0];
                        setDraft((current) => ({ ...current, languageCode: option.code, variant: option.variant }));
                      }}>
                        {LANGUAGE_OPTIONS.map((option) => <option key={option.code} value={option.code}>{option.label}</option>)}
                      </select>
                    </label>
                  ) : (
                    <label>
                      Tradición o maestro
                      <input value={draft.tradition} placeholder="Opcional, pero recomendado" onChange={(event) => setDraft((current) => ({ ...current, tradition: event.target.value }))} />
                    </label>
                  )}
                </div>

                <label>
                  {draft.kind === "language" ? "Variante o acento objetivo" : "Variante de transliteración"}
                  <input value={draft.variant} onChange={(event) => setDraft((current) => ({ ...current, variant: event.target.value }))} />
                </label>

                <label>
                  Texto de práctica
                  <textarea value={draft.text} maxLength={4_000} onChange={(event) => setDraft((current) => ({ ...current, text: event.target.value }))} />
                </label>
              </div>

              <footer className="composer__footer">
                <span className="composer__hint">Cada salto de línea se convierte en un segmento. No se guarda audio por defecto.</span>
                <div className="button-row">
                  <button className="button" type="button" onClick={() => setComposerOpen(false)}>Cancelar</button>
                  <button className="button button--primary" type="button" disabled={!draft.text.trim()} onClick={applyDraft}>Usar esta práctica</button>
                </div>
              </footer>
            </motion.section>
          </motion.div>
        ) : null}
      </AnimatePresence>

      <div className="sr-only" aria-live="assertive">
        {effectiveStatus === "speaking"
          ? practice.allowBargeIn
            ? "El coach está hablando. Puedes interrumpir hablando."
            : "El coach está hablando e intentará terminar su referencia breve."
          : `${statusCopy.label}. ${statusCopy.detail}`}
      </div>
    </main>
  );
}

function toDraft(practice: Practice): PracticeDraft {
  return {
    kind: practice.kind,
    title: practice.title,
    text: practice.text,
    languageCode: practice.languageCode ?? "en",
    variant: practice.variant,
    tradition: practice.tradition,
  };
}

function formatElapsed(seconds: number): string {
  const minutes = Math.floor(seconds / 60).toString().padStart(2, "0");
  const remaining = (seconds % 60).toString().padStart(2, "0");
  return `${minutes}:${remaining}`;
}

function getLatestCaption(
  status: RealtimeStatus,
  input: string,
  output: string,
  transcripts: RealtimeTranscript[],
  isDemo: boolean,
  allowBargeIn: boolean,
): { speaker: string; text: string } {
  if (isDemo) {
    if (status === "speaking") return { speaker: "Coach", text: DEMO_TRANSCRIPTS[0].text };
    if (status === "analyzing") return { speaker: "Sistema", text: "Comparando duración, ritmo y claridad…" };
    return { speaker: "Tú", text: DEMO_TRANSCRIPTS[1].text };
  }

  if (status === "speaking" && output.trim()) return { speaker: "Coach", text: output };
  if ((status === "listening" || status === "analyzing") && input.trim()) return { speaker: "Tú", text: input };

  const latest = transcripts.at(-1);
  if (latest) return { speaker: latest.role === "assistant" ? "Coach" : "Tú", text: latest.text };

  return {
    speaker: "Guía",
    text: allowBargeIn
      ? "Comienza cuando estés listo. Puedes interrumpir al coach hablando."
      : "Comienza cuando estés listo. El coach intentará terminar su referencia breve.",
  };
}

function getFeedbackPresentation(feedback: PronunciationFeedback | null) {
  if (!feedback) return null;
  if (feedback.source === "coach-summary") {
    return { label: "Consejo del coach", tone: feedback.status === "retry" ? "practice" : "ready" };
  }
  if (feedback.confidence < 0.6) {
    return { label: "No pude evaluarlo con confianza", tone: "uncertain" };
  }
  if (feedback.status === "retry") {
    return { label: "Practiquemos este sonido", tone: "practice" };
  }
  if (feedback.status === "excellent") {
    return feedback.confidence >= 0.8
      ? { label: "Muy cerca · listo para avanzar", tone: "ready" }
      : { label: "Muy cerca · confirmemos una vez más", tone: "practice" };
  }
  return { label: "Muy cerca · un ajuste", tone: "ready" };
}
