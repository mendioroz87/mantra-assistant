import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { VoiceStudio } from "./VoiceStudio";

describe("VoiceStudio", () => {
  it("exits connecting when the microphone permission never resolves", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("RTCPeerConnection", class {});
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: () => new Promise(() => {}) } });
    const view = render(<VoiceStudio />);
    try {
      fireEvent.click(screen.getByRole("button", { name: "Comenzar práctica" }));
      expect(screen.getByRole("button", { name: "Cancelar" })).toBeEnabled();
      await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
      expect(screen.getByRole("alert")).toHaveTextContent("15 segundos");
      expect(screen.getByRole("button", { name: "Comenzar práctica" })).toBeEnabled();
    } finally {
      view.unmount();
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });
  it("reports missing server configuration immediately instead of connecting", () => {
    render(<VoiceStudio voiceConfigured={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Comenzar práctica" }));
    expect(screen.getByRole("alert")).toHaveTextContent("falta configurar OpenAI");
    expect(screen.queryByText("Conectando")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Explorar demo visual" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByText(/Simulación sin audio ni micrófono/)).toBeInTheDocument();
  });
  it("shows startup errors outside the settings drawer and offers a labeled demo", async () => {
    render(<VoiceStudio />);
    fireEvent.click(screen.getByRole("button", { name: "Comenzar práctica" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("No se pudo iniciar la voz");
    expect(alert.closest("aside")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Explorar demo visual" }));
    expect(screen.getByText(/Simulación sin audio ni micrófono/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Finalizar" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Finalizar" }));
    expect(screen.getByRole("button", { name: "Comenzar práctica" })).toBeEnabled();
  });

  it("opens with the fire mantra and identifies the real API model", () => {
    render(<VoiceStudio />);

    expect(
      screen.getByRole("heading", { name: "Mantra del elemento fuego" }),
    ).toBeInTheDocument();
    expect(screen.getAllByText("om hriem hesraim hriem").length).toBeGreaterThan(0);
    expect(screen.getByText("gpt-live-1")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Comenzar práctica" }),
    ).toBeEnabled();
  });

  it("lets the user create a pronunciation practice for another language", () => {
    render(<VoiceStudio />);

    fireEvent.click(
      screen.getByRole("button", { name: /pronunciación libre/i }),
    );

    expect(screen.getByRole("dialog", { name: "Nueva práctica" })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Título"), {
      target: { value: "Voyelles françaises" },
    });
    fireEvent.change(screen.getByLabelText("Idioma"), {
      target: { value: "fr" },
    });
    fireEvent.change(screen.getByLabelText("Texto de práctica"), {
      target: { value: "Je voudrais une tasse de thé." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Usar esta práctica" }));

    expect(
      screen.getByRole("heading", { name: "Voyelles françaises" }),
    ).toBeInTheDocument();
    expect(screen.getAllByText("Je voudrais une tasse de thé.").length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Francés · Francia/).length).toBeGreaterThan(0);
  });
});
