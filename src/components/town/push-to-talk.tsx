"use client";

/**
 * Hold to interrupt the room, release to send.
 *
 * Deliberately push-to-talk rather than always-listening: no VAD, no
 * WebSocket, no mid-line barge-in to coordinate with the pacing in
 * `/api/negotiate`. Pressing pauses the round loop between turns; releasing
 * posts the clip, and the server's own reply is what's shown back — if a
 * number got scrubbed by the leak guard, this is where that becomes visible
 * rather than silent.
 *
 * Mounted by `TownControls` via its `talk` prop with the live participant's id.
 * In this demo that's always Maya, but the prop keeps the door open for more
 * than one live viewer later.
 */

import { useCallback, useRef, useState } from "react";
import type { ParticipantId } from "@/lib/types";

type Status = "idle" | "recording" | "sending" | "error";

interface PushToTalkProps {
  sessionId: string;
  participantId: ParticipantId;
}

export function PushToTalk({ sessionId, participantId }: PushToTalkProps) {
  const [status, setStatus] = useState<Status>("idle");
  const [lastSaid, setLastSaid] = useState<string | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);

  const setPaused = useCallback(
    async (paused: boolean) => {
      try {
        await fetch("/api/negotiate/pause", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId, paused }),
        });
      } catch {
        // A failed pause call should not block recording — the room keeps
        // moving in the worst case, which is the safer failure than a stuck
        // demo.
      }
    },
    [sessionId],
  );

  const start = useCallback(async () => {
    if (status === "recording") return;
    setStatus("recording");
    await setPaused(true);

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      chunksRef.current = [];

      const recorder = new MediaRecorder(stream, { mimeType: "audio/webm" });
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorder.start();
      recorderRef.current = recorder;
    } catch (error) {
      console.warn("[push-to-talk] mic access failed:", error);
      setStatus("error");
      await setPaused(false);
    }
  }, [status, setPaused]);

  const stop = useCallback(async () => {
    const recorder = recorderRef.current;
    if (!recorder || status !== "recording") return;

    setStatus("sending");

    const blob: Blob = await new Promise((resolve) => {
      recorder.addEventListener(
        "stop",
        () => resolve(new Blob(chunksRef.current, { type: "audio/webm" })),
        { once: true },
      );
      recorder.stop();
    });

    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    recorderRef.current = null;

    try {
      const params = new URLSearchParams({ sessionId, participantId });
      const response = await fetch(`/api/negotiate/interject?${params.toString()}`, {
        method: "POST",
        headers: { "Content-Type": "audio/webm" },
        body: blob,
      });
      const data = (await response.json()) as { text?: string };
      setLastSaid(data.text?.trim() || null);
      setStatus("idle");
    } catch (error) {
      console.warn("[push-to-talk] send failed:", error);
      // The route unpauses on every failure path server-side, but a network
      // error means that response never arrived — make sure the room isn't
      // left waiting on us regardless.
      await setPaused(false);
      setStatus("error");
    }
  }, [status, sessionId, participantId]);

  return (
    <div className="relative">
      <button
        type="button"
        className="disp h-12 cursor-pointer touch-none select-none border-[3px] border-ink bg-card px-4 text-[10px] text-ink disabled:opacity-45"
        aria-pressed={status === "recording"}
        // Pointer events cover mouse, touch and pen in one stream, so there are
        // no duplicate synthetic mouse events and no preventDefault needed.
        // Capture keeps the release coming here even if the finger slides off.
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
          void start();
        }}
        onPointerUp={() => void stop()}
        onPointerCancel={() => void stop()}
        onContextMenu={(event) => event.preventDefault()}
        disabled={status === "sending"}
      >
        {status === "recording"
          ? "Release to send…"
          : status === "sending"
            ? "Sending…"
            : "Hold to talk"}
      </button>
      {status === "error" && (
        <p role="alert" className="absolute bottom-full right-0 mb-2 whitespace-nowrap">
          Couldn't send that — try again.
        </p>
      )}
      {lastSaid && (
        <p className="absolute bottom-full right-0 mb-2 whitespace-nowrap">
          You said: “{lastSaid}”
        </p>
      )}
    </div>
  );
}