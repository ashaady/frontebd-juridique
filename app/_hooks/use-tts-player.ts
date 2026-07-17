"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { synthesizeSpeechApi } from "../_lib/workspace-api";

type TtsRequest = {
  key: string;
  text: string;
  voiceSlot?: number;
};

type TtsPlayer = {
  activeKey: string | null;
  loadingKey: string | null;
  stop: () => void;
  toggle: (request: TtsRequest) => Promise<void>;
};

export function useTtsPlayer(onError?: (message: string) => void): TtsPlayer {
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [loadingKey, setLoadingKey] = useState<string | null>(null);
  const activeKeyRef = useRef<string | null>(null);
  const loadingKeyRef = useRef<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const requestSequenceRef = useRef(0);

  const releaseAudio = useCallback(() => {
    const audio = audioRef.current;
    audioRef.current = null;
    if (audio) {
      audio.onended = null;
      audio.onerror = null;
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
    }
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    }
    activeKeyRef.current = null;
    setActiveKey(null);
  }, []);

  const stop = useCallback(() => {
    requestSequenceRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    loadingKeyRef.current = null;
    setLoadingKey(null);
    releaseAudio();
  }, [releaseAudio]);

  const toggle = useCallback(async ({ key, text, voiceSlot = 0 }: TtsRequest) => {
    if (activeKeyRef.current === key || loadingKeyRef.current === key) {
      stop();
      return;
    }

    stop();
    const readableText = text.trim();
    if (!readableText) return;

    const sequence = requestSequenceRef.current + 1;
    requestSequenceRef.current = sequence;
    const controller = new AbortController();
    abortRef.current = controller;
    loadingKeyRef.current = key;
    setLoadingKey(key);

    try {
      const blob = await synthesizeSpeechApi(readableText, voiceSlot, controller.signal);
      if (requestSequenceRef.current !== sequence || controller.signal.aborted) return;

      const objectUrl = URL.createObjectURL(blob);
      const audio = new Audio(objectUrl);
      objectUrlRef.current = objectUrl;
      audioRef.current = audio;
      activeKeyRef.current = key;
      loadingKeyRef.current = null;
      setLoadingKey(null);
      setActiveKey(key);

      const finish = () => {
        if (audioRef.current === audio) releaseAudio();
      };
      audio.onended = finish;
      audio.onerror = finish;
      await audio.play();
    } catch (error) {
      if (controller.signal.aborted || (error instanceof DOMException && error.name === "AbortError")) {
        return;
      }
      releaseAudio();
      onError?.(error instanceof Error ? error.message : "Lecture audio impossible.");
    } finally {
      if (requestSequenceRef.current === sequence) {
        abortRef.current = null;
        loadingKeyRef.current = null;
        setLoadingKey(null);
      }
    }
  }, [onError, releaseAudio, stop]);

  useEffect(() => stop, [stop]);

  return { activeKey, loadingKey, stop, toggle };
}
