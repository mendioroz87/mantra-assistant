import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FIRE_MANTRA } from "@/lib/practice";
import { useRealtimeSession } from "./useRealtimeSession";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Realtime SDP response", () => {
  it.each(["application/sdp", "application/json"])(
    "preserves the terminal CRLF from a %s answer",
    async (contentType) => {
      const answer = "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=ice-pwd:abcdefghijklmnopqrstuvwxyz123456\r\n";
      const setRemoteDescription = vi.fn(async () => {});
      const stopTrack = vi.fn();
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
        localDescription = { type: "offer", sdp: "v=0\r\n" };
        addTrack = vi.fn();
        createOffer = vi.fn(async () => this.localDescription);
        setLocalDescription = vi.fn(async () => {});
        setRemoteDescription = setRemoteDescription;
        createDataChannel = vi.fn(() => ({ readyState: "connecting", close: vi.fn() }));
        close = vi.fn();
      });
      vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
      vi.stubGlobal("fetch", vi.fn(async () => new Response(
        contentType === "application/json" ? JSON.stringify({ sdp: answer }) : answer,
        { headers: { "Content-Type": contentType } },
      )));

      const view = renderHook(() => useRealtimeSession({ practice: FIRE_MANTRA }));
      try {
        await act(async () => { await view.result.current.start(); });
        expect(view.result.current.error).toBeNull();
        expect(setRemoteDescription).toHaveBeenCalledWith({ type: "answer", sdp: answer });
      } finally {
        view.unmount();
      }
      expect(stopTrack).toHaveBeenCalled();
    },
  );
});
