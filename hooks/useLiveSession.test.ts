import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FIRE_MANTRA } from "@/lib/practice";
import { useLiveSession } from "./useLiveSession";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Live session lifecycle and SDP", () => {
  it.each(["application/json"])(
    "preserves the terminal CRLF from a %s answer",
    async (contentType) => {
      const answer = "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=ice-pwd:abcdefghijklmnopqrstuvwxyz123456\r\n";
      const setRemoteDescription = vi.fn(async () => {});
      const stopTrack = vi.fn();
      const dc = { readyState: "open", send: vi.fn(), close: vi.fn(), onmessage: null as null | ((event: { data: string }) => void) };
      const emit = (event: Record<string, unknown>) => act(() => { dc.onmessage?.({ data: JSON.stringify(event) }); });
      const track = { stop: stopTrack, enabled: true };
      vi.stubGlobal("navigator", {
        mediaDevices: {
          getUserMedia: vi.fn(async () => ({
            getTracks: () => [track],
            getAudioTracks: () => [track],
          })),
        },
      });
      vi.stubGlobal("RTCPeerConnection", class {
        iceGatheringState = "complete";
        localDescription = { type: "offer", sdp: "v=0\r\n" };
        addTrack = vi.fn();
        createOffer = vi.fn(async () => this.localDescription);
        setLocalDescription = vi.fn(async () => {});
        setRemoteDescription = setRemoteDescription;
        createDataChannel = vi.fn(() => dc);
        close = vi.fn();
      });
      vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
      vi.stubGlobal("fetch", vi.fn(async () => new Response(
        contentType === "application/json" ? JSON.stringify({ sdp: answer, model: "gpt-live-1", sessionId: "opaque_live_session" }) : answer,
        { headers: { "Content-Type": contentType } },
      )));

      const view = renderHook(() => useLiveSession({ practice: FIRE_MANTRA }));
      try {
        await act(async () => { await view.result.current.start(); });
        expect(view.result.current.error).toBeNull();
        expect(setRemoteDescription).toHaveBeenCalledWith({ type: "answer", sdp: answer });
        expect(view.result.current.isConnected).toBe(false);
        expect(dc.send).not.toHaveBeenCalled();
        emit({ type: "session.started" });
        expect(view.result.current.isConnected).toBe(true);
        const greeting = JSON.parse(dc.send.mock.calls[0][0]);
        emit({ type: "session.instructions.appended", client_event_id: greeting.event_id });
        expect(JSON.parse(dc.send.mock.calls[1][0]).type).toBe("session.commentary.append");
        emit({ type: "session.input_transcript.delta", delta: "The ", start_ms: 0, end_ms: 200 });
        emit({ type: "session.output_transcript.delta", delta: "Bien", start_ms: 0, end_ms: 200 });
        emit({ type: "session.input_transcript.delta", delta: "sun", start_ms: 200, end_ms: 400 });
        expect(view.result.current.inputTranscript).toBe("The sun");
        expect(view.result.current.outputTranscript).toBe("Bien");
        expect(view.result.current.transcripts.every(t => !t.isFinal)).toBe(true);
        act(() => view.result.current.clearTranscripts());
        emit({ type: "session.input_transcript.delta", delta: "New", start_ms: 400, end_ms: 600 });
        expect(view.result.current.inputTranscript).toBe("New");
        const call = { type: "response.event", delegation_id: "delegation", event: { type: "response.output_item.done", item: { type: "function_call", call_id: "call1", name: "report_pronunciation_feedback", arguments: JSON.stringify({ status: "good", confidence: 0.9, focus: "rhythm", heard: "clear", tip: "slow down", segment: "The sun" }) } } };
        emit(call); emit(call);
        expect(view.result.current.feedback).toHaveLength(1);
        emit({ type: "response.event", delegation_id: "delegation", event: { type: "response.completed", response: { output: [] } } });
        expect(dc.send.mock.calls.map(c => JSON.parse(c[0]).type).slice(-2)).toEqual(["response.item.create", "response.create"]);
        act(() => { view.result.current.mute(); view.result.current.pause(); view.result.current.resume(); });
        expect(track.enabled).toBe(false);
        act(() => view.result.current.unmute());
        expect(track.enabled).toBe(true);
        act(() => view.result.current.stop());
        expect(JSON.parse(dc.send.mock.calls.at(-1)![0]).type).toBe("session.close");
        expect(dc.close).not.toHaveBeenCalled();
        emit({ type: "session.closed" });
        expect(dc.close).toHaveBeenCalled();
      } finally {
        view.unmount();
      }
      expect(stopTrack).toHaveBeenCalled();
    },
  );
});
