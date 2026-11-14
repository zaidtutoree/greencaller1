import { useEffect, useRef } from "react";
import { getCallNote, saveCallNote } from "@/hooks/useCallNotes";
import type { CallNoteSession } from "@/components/CallNoteDialog";

/**
 * Drives the native (Electron) picture-in-picture call card.
 *
 * This is a UI-only bridge: it mirrors the current call state into the floating
 * window and forwards the window's button presses back to the existing call
 * handlers. It never touches the WebRTC session directly, so call functionality
 * is unchanged. On the web build (no `window.electronAPI`) every effect is inert.
 */
interface CallStateLike {
  isActive: boolean;
  callerName?: string;
  phoneNumber: string;
  duration: number;
  isMuted: boolean;
  isOnHold: boolean;
  isRecording?: boolean;
  isPaused?: boolean;
}

interface UseCallPipArgs {
  /**
   * Set false on a shell that is NOT the one rendering the call UI. Dashboard
   * delegates to EnterprisePlatform for enterprise accounts; with both mounted
   * the second registration wins the `pip-action` channel and the losing shell's
   * inert call state also drives `hideCallPip()`, fighting the live one.
   */
  enabled?: boolean;
  /** Whether the user has popped the call out into the floating card. */
  pipActive: boolean;
  callState: CallStateLike;
  /** Whether to show the note action on the floating card (premium/enterprise). */
  canNote?: boolean;
  /** Whether to show Transfer (enterprise only, matching the in-app card). */
  canTransfer?: boolean;
  /** Whether to show Record (premium/enterprise). */
  canRecord?: boolean;
  onMute: () => void;
  onHold: () => void;
  onEnd: () => void;
  /** Restore the in-app call screen (close pip, bring window forward). */
  onMaximize: () => void;
  /**
   * The note session for the call in progress. When supplied, the card's notes
   * drawer reads and writes the note here instead of restoring the whole app.
   */
  noteSession?: CallNoteSession | null;
  /** The signed-in user — notes are keyed by (user_id, call_ref). */
  userId?: string;
  /** Toggle recording — same handler the in-app card uses. */
  onRecord?: () => void;
  /** Restore the app and open the transfer picker (it needs real UI). */
  onTransfer?: () => void;
  /** Send a DTMF digit from the card's keypad. */
  onDtmf?: (digit: string) => void;
}

export function useCallPip({
  enabled = true,
  pipActive,
  callState,
  canNote,
  canTransfer,
  canRecord,
  onMute,
  onHold,
  onEnd,
  onMaximize,
  onRecord,
  onTransfer,
  onDtmf,
  noteSession,
  userId,
}: UseCallPipArgs) {
  const api = typeof window !== "undefined" ? window.electronAPI : undefined;

  // Keep the latest callbacks in a ref so the listener is registered only once.
  const handlers = useRef({ onMute, onHold, onEnd, onMaximize, onRecord, onTransfer, onDtmf });
  handlers.current = { onMute, onHold, onEnd, onMaximize, onRecord, onTransfer, onDtmf };

  // Note context, likewise read fresh from the listener.
  const noteCtx = useRef({ noteSession, userId, duration: callState.duration });
  noteCtx.current = { noteSession, userId, duration: callState.duration };

  useEffect(() => {
    // No cleanup is returned when disabled — tearing listeners down here would
    // clobber the shell that legitimately owns them.
    if (!api?.onPipAction || !enabled) return;

    api.onPipAction((action: string) => {
      const h = handlers.current;
      if (action === "mute") h.onMute();
      else if (action === "hold") h.onHold();
      else if (action === "end") h.onEnd();
      else if (action === "maximize") h.onMaximize();
      else if (action === "record") h.onRecord?.();
      else if (action === "transfer") h.onTransfer?.();
      else if (action.startsWith("dtmf:")) h.onDtmf?.(action.slice(5));
      else if (action === "note-load") {
        // The card opened its notes drawer and wants the existing note.
        const { userId: uid, noteSession: s } = noteCtx.current;
        if (!uid || !s) {
          api.sendPipNote("");
          return;
        }
        getCallNote(uid, s.callRef).then((existing) => api.sendPipNote(existing?.note ?? ""));
      }
    });

    // Persist edits made in the card. Writes are already debounced card-side.
    api.onPipNoteChange?.((text: string) => {
      const { userId: uid, noteSession: s, duration: d } = noteCtx.current;
      if (!uid || !s) return;
      saveCallNote({
        userId: uid,
        callRef: s.callRef,
        note: text,
        phoneNumber: s.phoneNumber,
        contactName: s.contactName,
        direction: s.direction,
        duration: d,
      });
    });

    return () => api.removePipActionListeners?.();
  }, [api, enabled]);

  const shouldShow = Boolean(api && enabled && pipActive && callState.isActive);

  // Build the payload the floating card understands.
  const payload = {
    callerName: callState.callerName,
    callerNumber: callState.phoneNumber,
    duration: callState.duration,
    isMuted: callState.isMuted,
    isOnHold: callState.isOnHold,
    isRecording: !!callState.isRecording,
    isPaused: !!callState.isPaused,
    canNote: !!canNote,
    canTransfer: !!canTransfer,
    canRecord: !!canRecord,
  };

  // Show / hide the floating card.
  useEffect(() => {
    if (!api || !enabled) return;
    if (shouldShow) api.showCallPip(payload);
    else api.hideCallPip();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, shouldShow]);

  // Stream live state into the card while it's open.
  useEffect(() => {
    if (!api || !shouldShow) return;
    api.updateCallPip(payload);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    api,
    shouldShow,
    callState.callerName,
    callState.phoneNumber,
    callState.duration,
    callState.isMuted,
    callState.isOnHold,
    callState.isRecording,
    callState.isPaused,
    canNote,
    canTransfer,
    canRecord,
  ]);
}
