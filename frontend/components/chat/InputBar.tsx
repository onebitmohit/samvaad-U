"use client";

import React, { useState, useEffect, useRef } from "react";
import {
  Mic,
  SendHorizontal,
  MessageSquare,
  X,
  Play,
  Square,
} from "lucide-react";
import {
  createLocalAudioTrack,
  type LocalAudioTrack,
  Room,
  RoomEvent,
  Track,
} from "livekit-client";
import { ActionTooltip } from "@/components/ui/action-tooltip";
import { StrictModeToggle } from "@/components/chat/StrictModeToggle";
import { PersonaSelector } from "@/components/chat/PersonaSelector";
import { VoiceSettings } from "@/components/chat/VoiceSettings";
import { MobileVoiceControls } from "@/components/chat/MobileVoiceControls";
import { MobileTextControls } from "@/components/chat/MobileTextControls";
import { motion, AnimatePresence } from "framer-motion";
import { ChatMessage, API_BASE_URL, startVoiceMode } from "@/lib/api";

import { Button } from "@/components/ui/button";
import { useUIStore } from "@/lib/stores/useUIStore";
import { useInputBarStore } from "@/lib/stores/useInputBarStore";
import { useConversationStore } from "@/lib/stores/useConversationStore";
import { useSettingsStore } from "@/lib/stores/useSettingsStore";
import { cn } from "@/lib/utils";
import { endVoiceMode } from "@/lib/api";
import { toast } from "sonner";
import { AttachmentButton } from "./AttachmentButton";
import { usePlatform } from "@/hooks/usePlatform";
import { useFileProcessor } from "@/hooks/useFileProcessor";

interface InputBarProps {
  onSendMessage: (message: string, persona?: string, strictMode?: boolean) => void;
  isLoading?: boolean;
  onStop?: () => void;
  defaultMessage?: string | null;
  onMessageConsumed?: () => void;
  onVoiceMessage?: (message: ChatMessage) => void;
  conversationId?: string | null;
}

export function InputBar({ onSendMessage, isLoading, onStop, defaultMessage, onMessageConsumed, onVoiceMessage, conversationId }: InputBarProps) {
	const { pendingConversationId, conversationSettings, updateConversationSettings } = useConversationStore();
	const { settings: globalSettings } = useSettingsStore();
  const USE_MOCK_BACKEND = false; // Toggle this to true for mock backend
  const {
    toggleSourcesPanel,
    consumePendingVoiceCitations,
    setPendingVoiceCitations,
    consumeVoiceTranscript,
    lastVoiceCitations,
  } = useUIStore();

  const {
    mode,
    setMode,
    hasInteracted,
    setHasInteracted,
    strictMode,
    persona,
    setStrictMode,
    setPersona,
    enableTTS,
    isSessionActive,
    setSessionActive,
    isConnecting,
    setConnecting,
    voiceState,
    setVoiceState,
    errorMessage,
    setErrorMessage,
    voiceDuration,
    setVoiceDuration,
    incrementVoiceDuration,
    isPTTActive,
    setIsPTTActive,
    currentRoomUrl,
    setCurrentRoomUrl,
    endSession,
    setError,
  } = useInputBarStore();

  const [message, setMessage] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const currentRoomNameRef = useRef<string | null>(null); // Ref for event handler access
  const livekitRoomRef = useRef<Room | null>(null);
  const localAudioTrackRef = useRef<LocalAudioTrack | null>(null);
  const currentBotResponseRef = useRef<string>(""); // Ref to aggregate bot sentences (filtered, for fallback)
  const currentBotLlmTextRef = useRef<string>(""); // Ref to aggregate raw LLM text (with citation markers)
  const currentUserTranscriptRef = useRef<string>(""); // Ref to aggregate user transcripts
  const assistantMessageSentRef = useRef(false);
  const { processFiles } = useFileProcessor();

  // Sync ref with store value for event handler access
  useEffect(() => {
    currentRoomNameRef.current = currentRoomUrl;
  }, [currentRoomUrl]);

  useEffect(() => {
    if (conversationSettings?.active_strict_mode !== null && conversationSettings?.active_strict_mode !== undefined) {
      setStrictMode(conversationSettings.active_strict_mode);
    }
    if (conversationSettings?.active_persona !== null && conversationSettings?.active_persona !== undefined) {
      setPersona(conversationSettings.active_persona);
    }
  }, [conversationSettings, setStrictMode, setPersona]);

  useEffect(() => {
    if (!conversationId) {
      if (globalSettings) {
        setStrictMode(globalSettings.default_strict_mode);
        setPersona(globalSettings.default_persona);
      }
    } else if (conversationSettings === null) {
      if (globalSettings) {
        setStrictMode(globalSettings.default_strict_mode);
        setPersona(globalSettings.default_persona);
      }
    }
  }, [conversationId, conversationSettings, globalSettings, setStrictMode, setPersona]);

  useEffect(() => {
    if (!conversationId || !conversationSettings) return;

    const strictModeChanged = strictMode !== conversationSettings.active_strict_mode;
    const personaChanged = persona !== conversationSettings.active_persona;

    if (!strictModeChanged && !personaChanged) return;

    const timeoutId = setTimeout(() => {
      updateConversationSettings(conversationId, {
        active_strict_mode: strictMode,
        active_persona: persona,
      }).catch((err) => console.error("Failed to save conversation settings:", err));
    }, 500);

    return () => clearTimeout(timeoutId);
  }, [strictMode, persona, conversationId, conversationSettings, updateConversationSettings]);

  // Handle initial mode selection
  const handleModeSelect = (selectedMode: "text" | "voice") => {
    console.debug("[InputBar] mode selected:", selectedMode);
    setHasInteracted(true);
    setMode(selectedMode);
  };

  // Keyboard Shortcuts (Alt+T, Alt+V, Alt+A)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Voice Mode (Alt + V)
      if (e.altKey && (e.code === 'KeyV')) {
        e.preventDefault();
        handleModeSelect("voice");
      }
      // Text Mode (Alt + T)
      if (e.altKey && (e.code === 'KeyT')) {
        e.preventDefault();
        handleModeSelect("text");

        // Force focus if already in text mode or switching to it
        if (mode === "text") {
          setTimeout(() => textareaRef.current?.focus(), 0);
        }
      }

      // Upload Files (Alt + A) - Allow on initial screen too (e.altKey check matches global)
      if (e.altKey && (e.code === 'KeyA')) {
        e.preventDefault();
        fileInputRef.current?.click();
      }

      // Sources Panel (Alt + S)
      if (e.altKey && (e.code === 'KeyS')) {
        e.preventDefault();
        toggleSourcesPanel();
      }

      // Sources Panel (Alt + S)
      if (e.altKey && (e.code === 'KeyS')) {
        e.preventDefault();
        toggleSourcesPanel();
      }


    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [setMode, mode]);

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      const files = Array.from(e.target.files);
      await processFiles(files);
      // Auto-open panel to show progress? User request implied opening file explorer.
      // Once files are selected, we should probably ensure the panel is open to show headers/progress
      // but InputBar manages SourcesPanel visibility?
      // We can use setSourcesPanelOpen(true) if we want.
      // For now, just process.

      // Reset input
      e.target.value = "";
    }
  };

  const triggerFileInput = () => {
    fileInputRef.current?.click();
  };

  useEffect(() => {
    if (defaultMessage && onMessageConsumed) {
      console.debug("[InputBar] Loading default message for edit:", defaultMessage);
      setMessage(defaultMessage);

      // We must allow the state to update before we tell the parent we consumed it.
      // Although React state updates are batched, sometimes the parent re-render 
      // with null might happen too fast if not synchronized.
      // However, the main issue might be that the textarea height needs to adjust.

      // Defer consuming slightly to ensure UI updates first? 
      // Actually, standard practice is to consume immediately. 
      // But let's check if the state is actually persisting.

      // Let's call onMessageConsumed in the next tick to be safe.
      setTimeout(() => {
        onMessageConsumed();
        // Auto-focus the textarea
        if (textareaRef.current) {
          textareaRef.current.focus();
          // Optional: Move cursor to end
          textareaRef.current.setSelectionRange(
            textareaRef.current.value.length,
            textareaRef.current.value.length
          );
        }
      }, 0);
    }
  }, [defaultMessage, onMessageConsumed]);

  // Auto-resize when message changes programmatically
  useEffect(() => {
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.style.height = "auto";
      textarea.style.height = textarea.scrollHeight + "px";
    }
  }, [message]);

  // Auto-focus when switching to Text Mode
  useEffect(() => {
    if (mode === "text" && textareaRef.current) {
      // Small timeout to ensure the element is painted and ready to receive focus
      // especially if there's an animation
      setTimeout(() => {
        textareaRef.current?.focus();
      }, 50);
    }
  }, [mode, hasInteracted]);

  const updateRoomName = (roomName: string | null) => {
    setCurrentRoomUrl(roomName);
    currentRoomNameRef.current = roomName;
  };

  const disconnectLiveKit = async () => {
    const track = localAudioTrackRef.current;
    localAudioTrackRef.current = null;
    if (track) {
      track.stop();
      track.detach();
    }

    const room = livekitRoomRef.current;
    livekitRoomRef.current = null;
    if (room) {
      room.disconnect();
    }
  };

  const applyLiveKitMessage = (payload: any) => {
    if (payload?.type === "bot_ready") {
      setConnecting(false);
      setVoiceState("listening");
      toast.success("Voice agent ready");
      return;
    }

    if (payload?.type === "user_started_speaking") {
      setVoiceState("listening");
      currentUserTranscriptRef.current = "";
      return;
    }

    if (payload?.type === "user_transcript" && payload.text?.trim()) {
      if (currentUserTranscriptRef.current) {
        currentUserTranscriptRef.current += " ";
      }
      currentUserTranscriptRef.current += payload.text.trim();
      return;
    }

    if (payload?.type === "bot_llm_started") {
      setVoiceState("processing");
      currentBotLlmTextRef.current = "";
      currentBotResponseRef.current = "";
      assistantMessageSentRef.current = false;

      const fullUserMessage = currentUserTranscriptRef.current.trim();
      if (fullUserMessage) {
        onVoiceMessage?.({ role: "user", content: fullUserMessage });
        currentUserTranscriptRef.current = "";
      }
      return;
    }

    if (payload?.type === "bot_llm_text" && payload.text) {
      currentBotLlmTextRef.current += payload.text;
      return;
    }

    if (payload?.type === "bot_started_speaking") {
      setVoiceState("answering");
      return;
    }

    if (payload?.type === "bot_stopped_speaking") {
      setVoiceState("listening");
      const rawLlmText = currentBotLlmTextRef.current.trim();
      const transcriptText = consumeVoiceTranscript();

      if (assistantMessageSentRef.current) {
        currentBotLlmTextRef.current = "";
        currentBotResponseRef.current = "";
        return;
      }

      const pendingCitations = consumePendingVoiceCitations();
      let sources = pendingCitations.length > 0 ? pendingCitations : undefined;
      if (!sources) {
        const hasMarkers = /\[\d+\]/.test(rawLlmText || transcriptText || "");
        if (hasMarkers && lastVoiceCitations.length > 0) {
          sources = lastVoiceCitations;
        }
      }

      const content = rawLlmText || transcriptText || currentBotResponseRef.current.trim();
      if (content) {
        onVoiceMessage?.({ role: "assistant", content, sources });
      }

      assistantMessageSentRef.current = true;
      currentBotLlmTextRef.current = "";
      currentBotResponseRef.current = "";
      return;
    }

    if (payload?.type === "citations" && Array.isArray(payload.sources)) {
      setPendingVoiceCitations(payload.sources);
      const state = useConversationStore.getState();
      const lastAssistant = [...state.messages].reverse().find((m) => m.role === "assistant");
      if (lastAssistant && (!lastAssistant.sources || lastAssistant.sources.length === 0)) {
        state.updateMessage(lastAssistant.id, { sources: payload.sources });
      }
      return;
    }

    if (payload?.type === "transcript" && payload.text && !assistantMessageSentRef.current) {
      const pendingCitations = consumePendingVoiceCitations();
      let sources = pendingCitations.length > 0 ? pendingCitations : undefined;
      if (!sources && /\[\d+\]/.test(payload.text) && lastVoiceCitations.length > 0) {
        sources = lastVoiceCitations;
      }
      onVoiceMessage?.({ role: "assistant", content: payload.text, sources });
      assistantMessageSentRef.current = true;
      currentBotLlmTextRef.current = "";
      currentBotResponseRef.current = "";
    }
  };

  // Handle Spacebar PTT for V2T mode
  useEffect(() => {
    if (mode === "voice" && !enableTTS && isSessionActive) {
      const handleKeyDown = (e: KeyboardEvent) => {
        if (e.code === "Space" && !e.repeat && !isPTTActive) {
          e.preventDefault(); // Prevent scrolling
          setIsPTTActive(true);
          localAudioTrackRef.current?.unmute();
        }
      };

      const handleKeyUp = (e: KeyboardEvent) => {
        if (e.code === "Space" && isPTTActive) {
          e.preventDefault();
          setIsPTTActive(false);
          localAudioTrackRef.current?.mute();
        }
      };

      window.addEventListener("keydown", handleKeyDown);
      window.addEventListener("keyup", handleKeyUp);
      return () => {
        window.removeEventListener("keydown", handleKeyDown);
        window.removeEventListener("keyup", handleKeyUp);
      };
    }
  }, [mode, enableTTS, isSessionActive, isPTTActive]);

  // Initial Logic: If V2T mode, mute mic initially upon connection
  useEffect(() => {
    if (isSessionActive && !isConnecting && localAudioTrackRef.current) {
      if (!enableTTS) {
        // V2T Mode: Start Muted (PTT only)
        localAudioTrackRef.current.mute();
        toast.info("Hold Spacebar to talk");
      } else {
        // V2V Mode: Start Unmuted (VAD)
        localAudioTrackRef.current.unmute();
      }
    }
  }, [isSessionActive, isConnecting, enableTTS]);

  // Handle browser/tab close - cleanup LiveKit room
  useEffect(() => {
    const handleBeforeUnload = () => {
      const roomName = currentRoomNameRef.current;
      if (roomName && isSessionActive) {
        console.debug("[InputBar] beforeunload - cleaning up room:", roomName);
        // Use sendBeacon for reliable delivery during page unload
        navigator.sendBeacon(
          `${API_BASE_URL}/voice-mode/disconnect-beacon`,
          JSON.stringify({ room_name: roomName })
        );
      }
    };

    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [isSessionActive]);

  const handleStartSession = async () => {
    // If mocking
    if (USE_MOCK_BACKEND) {
      setVoiceDuration(0);
      setConnecting(true);
      setTimeout(() => {
        setConnecting(false);
        setSessionActive(true);
        toast.success("Voice agent ready (MOCK)");
      }, 1500);
      return;
    }

    setConnecting(true);
    setVoiceDuration(0);

	const activeConversationId = conversationId || pendingConversationId;
	if (!activeConversationId) {
		toast.error("No conversation ID available");
		setConnecting(false);
		return;
	}

    try {
      // Request mic permission
      if (typeof navigator !== "undefined" && navigator.mediaDevices?.getUserMedia) {
        try {
          await navigator.mediaDevices.getUserMedia({ audio: true });
        } catch (permErr) {
          console.warn("[InputBar] microphone permission denied", permErr);
          toast.error("Microphone permission denied. Please enable the mic to use Voice Mode.");
          setMode("text");
          setConnecting(false);
          return;
        }
      }

      await disconnectLiveKit();
      const session = await startVoiceMode(activeConversationId, "default", enableTTS, persona, strictMode);
      updateRoomName(session.room_name);

      const room = new Room({ adaptiveStream: true, dynacast: true });
      livekitRoomRef.current = room;

      room.on(RoomEvent.TrackSubscribed, (track) => {
        if (track.kind === Track.Kind.Audio) {
          const element = track.attach();
          element.autoplay = true;
          element.style.display = "none";
          document.body.appendChild(element);
        }
      });

      room.on(RoomEvent.TrackUnsubscribed, (track) => {
        track.detach().forEach((element) => element.remove());
      });

      room.on(RoomEvent.DataReceived, (payload) => {
        try {
          const text = new TextDecoder().decode(payload);
          applyLiveKitMessage(JSON.parse(text));
        } catch (err) {
          console.warn("[InputBar] Failed to parse LiveKit data message:", err);
        }
      });

      room.on(RoomEvent.Disconnected, () => {
        const roomName = currentRoomNameRef.current;
        console.debug("[InputBar] LiveKit disconnected, room:", roomName);
        if (roomName) {
          updateRoomName(null);
          endVoiceMode(roomName).then((result) => {
            console.debug("[InputBar] endVoiceMode result (from LiveKit disconnected):", result);
          });
        }

        if (isSessionActive && voiceState !== "error") {
          setErrorMessage("Connection lost");
          setVoiceState("error");
          setConnecting(false);
        } else {
          setSessionActive(false);
          setConnecting(false);
          setVoiceDuration(0);
        }
      });

      await room.connect(session.livekit_url, session.token);
      const audioTrack = await createLocalAudioTrack();
      localAudioTrackRef.current = audioTrack;
      await room.localParticipant.publishTrack(audioTrack);

      if (!enableTTS) {
        audioTrack.mute();
      }

      setSessionActive(true);

      // Safety timeout - if still connecting after 30 seconds, trigger error state
      setTimeout(() => {
        const isStillConnecting = useInputBarStore.getState().isConnecting;
        if (isStillConnecting) {
          setError("Connection timed out");
          setVoiceDuration(0);
        }
      }, 30000);

    } catch (error) {
      console.error("[InputBar] Failed to connect voice mode:", error);
      // Show error in voice capsule if still in voice mode
      setErrorMessage("Failed to connect");
      setVoiceState("error");
      setConnecting(false);
      // Keep isSessionActive true so error UI shows - user can retry from there
    }
  };

  // Handle Enter key for Voice Mode
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (mode === "voice" && !isSessionActive && !isConnecting && e.key === "Enter") {
        e.preventDefault();
        handleStartSession();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [mode, isSessionActive, isConnecting]);

  useEffect(() => {
    if (mode === "text" && (livekitRoomRef.current || isSessionActive)) {
      (async () => {
        try {
          await disconnectLiveKit();
        } catch (err) {
          console.warn(err);
        }
        setSessionActive(false);
        setConnecting(false);
      })();
    }
  }, [mode, isSessionActive, setSessionActive, setConnecting]);

  const handleDisconnect = async () => {
    const roomName = currentRoomNameRef.current;
    if (roomName) {
      updateRoomName(null);
      await endVoiceMode(roomName);
    }
    try {
      await disconnectLiveKit();
    } catch (err) {
      console.warn("[InputBar] disconnect error:", err);
    }
    endSession();
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (message.trim() && !isLoading) {
      onSendMessage(message, persona, strictMode);
      setMessage("");
    }
  };

  // Voice Timer
  useEffect(() => {
    let interval: NodeJS.Timeout;
    if (mode === "voice" && isSessionActive) {
      interval = setInterval(() => {
        incrementVoiceDuration();
      }, 1000);
    }
    return () => clearInterval(interval);
  }, [mode, isSessionActive, incrementVoiceDuration]);

  // Format seconds to MM:SS
  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")} `;
  };







  const { modifier, isMobile } = usePlatform();

  // 1. Main / Initial Bar / Mode Switcher
  if (!hasInteracted) {
    return (
      <div className="w-full max-w-3xl mx-auto p-4 mb-20 md:mb-10 mt-auto pb-safe">
        <div className="flex items-center justify-center gap-3">
          <input
            type="file"
            multiple
            ref={fileInputRef}
            className="hidden"
            onChange={handleFileSelect}
          />

          <div className="h-16 w-full max-w-lg bg-black/40 backdrop-blur-2xl border border-white/10 rounded-full p-1.5 flex items-center justify-center gap-1 shadow-2xl ring-1 ring-white/5">
            {/* Text Mode Option */}
            <button
              onClick={() => handleModeSelect("text")}
              className="relative flex-1 h-full rounded-full flex items-center justify-center gap-2 transition-all duration-300 group hover:bg-white/5 text-white cursor-pointer"
            >
              <MessageSquare className="w-5 h-5 transition-colors text-white" />
              <span className="text-lg font-medium">Text Mode</span>
              <ActionTooltip label="Text Mode" shortcut={`${modifier}+T`} side="top" />
            </button>

            {/* Vertical Divider */}
            <div className="w-px h-6 bg-white/10 mx-1" />

            {/* Voice Mode Option */}
            <button
              onClick={() => handleModeSelect("voice")}
              className="relative flex-1 h-full rounded-full flex items-center justify-center gap-2 transition-all duration-300 group hover:bg-white/5 text-white cursor-pointer"
            >
              <Mic className="w-5 h-5 transition-colors text-white" />
              <span className="text-lg font-medium">Voice Mode</span>
              <ActionTooltip label="Voice Mode" shortcut={`${modifier}+V`} side="top" />
            </button>
          </div>
        </div>
      </div>
    );
  }

  // 2. Text Mode Bar
  if (mode === "text") {
    return (
      <div className="w-full max-w-3xl mx-auto p-4 mb-20 md:mb-10 mt-auto pb-safe">
        <div className="flex items-end gap-3">
          {/* Attachment Button - Hidden on mobile */}
          <div className="hidden md:block">
            <AttachmentButton
              onUploadClick={triggerFileInput}
              onViewFilesClick={toggleSourcesPanel}
            />
          </div>
          <input
            type="file"
            multiple
            ref={fileInputRef}
            className="hidden"
            onChange={handleFileSelect}
          />



          <form
            onSubmit={handleSubmit}
            className="flex-1 bg-surface/80 backdrop-blur-md border border-white/10 rounded-[32px] shadow-lg transition-all focus-within:ring-1 focus-within:ring-white/20 flex flex-row items-end min-h-[3.5rem] md:min-h-[4rem] overflow-hidden md:overflow-visible"
          >
            <textarea
              ref={(el) => {
                // Determine if we need to auto-focus on first mount
                const isMounting = !textareaRef.current && el;
                textareaRef.current = el;
                if (el) {
                  el.style.height = "auto";
                  el.style.height = el.scrollHeight + "px";
                  // If we just mounted and mode is text, we might want to focus
                  // But the useEffect handles that.
                }
              }}
              value={message}
              onChange={(e) => {
                setMessage(e.target.value);
                e.target.style.height = "auto";
                e.target.style.height = e.target.scrollHeight + "px";
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  handleSubmit(e);
                }
              }}
              placeholder={isMobile ? "Ask anything..." : "Find answers to your curiosity"}
              rows={1}
              className="flex-1 bg-transparent border-none py-3 md:py-4 pl-4 md:pl-6 pr-2 text-lg focus:outline-none placeholder:text-text-secondary/50 resize-none overflow-hidden max-h-[200px] overflow-y-auto min-h-[3.5rem] md:min-h-[4rem]"
            />

            <div className="flex items-center gap-0.5 md:gap-1 pr-2 md:pr-3 pb-1 md:pb-2 shrink-0">
              <Button
                type={isLoading ? "button" : "submit"}
                size="icon"
                variant="ghost"
                disabled={!isLoading && !message.trim()}
                onClick={(e) => {
                  if (isLoading && onStop) {
                    e.preventDefault();
                    onStop();
                  }
                }}
                className="rounded-full w-12 h-12 text-text-primary hover:bg-transparent overflow-hidden"
              >
                <AnimatePresence mode="wait">
                  {isLoading ? (
                    <motion.div
                      key="stop"
                      initial={{ scale: 0.5, opacity: 0 }}
                      animate={{ scale: 1, opacity: 1 }}
                      exit={{ scale: 0.5, opacity: 0 }}
                      className="relative w-full h-full flex items-center justify-center group/stop"
                    >
                      {/* Spinning Spinner */}
                      <motion.div
                        animate={{ rotate: 360 }}
                        transition={{ repeat: Infinity, duration: 1, ease: "linear" }}
                        className="absolute inset-2 rounded-full border-2 border-white/10 border-t-white"
                      />

                      {/* Stop Icon - Morph/Hover effect */}
                      <div className="relative w-8 h-8 rounded-full bg-white/10 group-hover/stop:bg-red-500/20 flex items-center justify-center transition-colors duration-300 backdrop-blur-sm">
                        <Square className="w-3 h-3 fill-white text-white group-hover/stop:scale-90 transition-transform" />
                      </div>
                    </motion.div>
                  ) : (
                    <motion.div
                      key="send"
                      initial={{ scale: 0.5, opacity: 0 }}
                      animate={{ scale: 1, opacity: 1 }}
                      exit={{ scale: 0.5, opacity: 0 }}
                      className="w-full h-full flex items-center justify-center hover:bg-white/10 rounded-full transition-colors"
                    >
                      <SendHorizontal className="w-6 h-6" />
                    </motion.div>
                  )}
                </AnimatePresence>
              </Button>

              <div className="w-px h-6 bg-white/10 mx-1" />

              {/* Desktop Controls */}
              <div className="hidden md:flex items-center gap-1">
                <StrictModeToggle />
                <PersonaSelector />
              </div>

              {/* Mobile Controls */}
              <div className="flex md:hidden">
                <MobileTextControls />
              </div>
            </div>
          </form>

          <Button
            type="button"
            size="icon"
            className="relative group h-14 w-14 md:h-16 md:w-16 rounded-full bg-black/40 backdrop-blur-2xl border border-white/10 hover:bg-white/10 text-text-primary shadow-lg shrink-0"
            onClick={() => setMode("voice")}
          >
            <Mic className="w-6 h-6" />
            <ActionTooltip label="Voice Mode" shortcut={`${modifier}+V`} side="top" />
          </Button>
        </div >
      </div >

    );
  }

  // 3. Voice Mode Bar (Listening & Answering)
  return (
    <div className="w-full max-w-3xl mx-auto p-4 mb-20 md:mb-10 mt-auto pb-safe">
      <div className="flex items-center gap-3">
        {/* Attachment Button - Hidden on mobile */}
        <div className="hidden md:block">
          <AttachmentButton
            onUploadClick={triggerFileInput}
            onViewFilesClick={toggleSourcesPanel}
          />
        </div>
        <input
          type="file"
          multiple
          ref={fileInputRef}
          className="hidden"
          onChange={handleFileSelect}
        />

        {/* Main Voice Control Bar */}
        <div className="flex-1 h-14 md:h-16 bg-surface/80 backdrop-blur-md border border-white/10 rounded-full shadow-2xl flex items-center p-1.5 gap-4 relative ring-1 ring-white/5">
          {/* Dynamic Background Glow */}
          <div
            className={cn(
              "absolute inset-0 opacity-10 transition-colors duration-500 pointer-events-none",
              (!isSessionActive || isConnecting) ? "bg-transparent" : voiceState === "listening" ? "bg-accent" : "bg-transparent",
            )}
          />

          {/* Waveform / Status Area OR Start Button */}
          {!isSessionActive && !isConnecting ? (
            <div className="flex-1 flex items-center justify-center relative z-10 w-full h-full">
              <Button
                variant="ghost"
                className="w-full h-full rounded-full bg-transparent hover:bg-white/5 text-white font-medium flex items-center justify-center gap-2 transition-all duration-300"
                onClick={handleStartSession}
              >
                <Play className="w-5 h-5 fill-current" />
                <span>Start Voice Session</span>
              </Button>
            </div>
          ) : (
            <div className="flex-1 flex items-center justify-center">
              <div
                className={cn(
                  "flex items-center justify-center gap-3 px-6 py-2 rounded-full transition-all duration-500 min-w-[360px] relative z-10",
                  isConnecting
                    ? "bg-white/5 text-text-primary border border-white/5"
                    : voiceState === "listening"
                      ? "bg-blue-500/20 border-blue-500/30 text-blue-100"
                      : voiceState === "processing"
                        ? "bg-amber-500/20 border-amber-500/30 text-amber-100"
                        : voiceState === "error"
                          ? "bg-red-500/20 border-red-500/30 text-red-100"
                          : "bg-emerald-500/20 border-emerald-500/30 text-emerald-100"
                )}
              >
                <span className="font-mono text-lg font-medium tracking-wider opacity-90">
                  {formatTime(voiceDuration)}
                </span>

                {/* Status Text */}
                <div className="flex items-center gap-2 ml-1">
                  {isConnecting ? (
                    <>
                      <div className="w-2 h-2 rounded-full bg-white/50 animate-pulse" />
                      <span className="text-sm font-medium">Connecting..</span>
                    </>
                  ) : voiceState === "listening" ? (
                    <>
                      <div className="w-2 h-2 rounded-full bg-blue-300 animate-pulse" />
                      <span className="text-sm font-medium">Listening..</span>
                    </>
                  ) : voiceState === "processing" ? (
                    <>
                      <div className="w-2 h-2 rounded-full bg-amber-400 animate-pulse" />
                      <span className="text-sm font-medium">Processing..</span>
                    </>
                  ) : voiceState === "error" ? (
                    <>
                      <svg className="w-4 h-4 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                      </svg>
                      <span className="text-sm font-medium">{errorMessage}</span>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          // Clean up old room first
                          const roomName = currentRoomNameRef.current;
                          if (roomName) {
                            endVoiceMode(roomName);
                            updateRoomName(null);
                          }
                          // Reset state and retry
                          setVoiceState("listening");
                          setErrorMessage("");
                          setSessionActive(false);
                          // Small delay then restart
                          setTimeout(() => {
                            handleStartSession();
                          }, 100);
                        }}
                        className="ml-2 px-2 py-0.5 text-xs font-medium bg-red-500/30 hover:bg-red-500/50 rounded transition-colors"
                      >
                        Retry
                      </button>
                    </>
                  ) : (
                    <>
                      <div className="w-2 h-2 rounded-full bg-emerald-300 animate-pulse" />
                      <span className="text-sm font-medium">Answering..</span>
                    </>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Spacer - Only show when session active to push controls right. When inactive, let StartButton take full width to center. */}
          {/* Spacer - Removed because flex-1 wrapper on Status handles centering/pushing */}

            {/* Controls */}
            <div className="flex items-center gap-1 md:gap-2 pr-2 relative z-10 max-w-full justify-end">
              <div className="w-px h-4 bg-white/10 mx-1" />

              {/* Desktop Controls */}
              <div className="hidden md:flex items-center gap-2">
                <StrictModeToggle />
                <PersonaSelector />
                <VoiceSettings />
              </div>

            {/* Mobile Controls (Menu) */}
            <div className="flex md:hidden">
              <MobileVoiceControls />
            </div>



            {(isSessionActive || isConnecting) && (
              <Button
                size="icon"
                variant="ghost"
                className="rounded-full w-10 h-10 text-text-secondary hover:bg-red-500/10 hover:text-red-500 transition-colors"
                onClick={handleDisconnect}
                title="End Session"
              >
                <X className="w-5 h-5" />
              </Button>
            )}
          </div>
        </div>

        {/* Switch to Text Button */}
        <Button
          type="button"
          size="icon"
          className="relative group h-14 w-14 md:h-16 md:w-16 rounded-full bg-black/40 backdrop-blur-2xl border border-white/10 hover:bg-white/10 text-text-primary shadow-lg shrink-0"
          onClick={() => setMode("text")}
        >
          <MessageSquare className="w-6 h-6" />
          <ActionTooltip label="Text Mode" shortcut={`${modifier}+T`} side="top" />
        </Button>
      </div>
    </div >
  );
}
