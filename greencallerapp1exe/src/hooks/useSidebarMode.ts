import { useCallback, useEffect, useRef, useState } from "react";
import { useToast } from "@/hooks/use-toast";
import type { SidebarAction, SidebarState } from "@/components/sidebar-mode/types";

/**
 * Main-window half of Sidebar Mode.
 *
 * Like `useCallPip`, this is a UI-only bridge. The window that mounts this hook
 * keeps the single WebRTC/SIP session; when the user docks, that window is
 * merely *hidden* by the main process, so nothing re-registers and no media is
 * dropped. The hook mirrors call state into the docked strip and routes the
 * strip's button presses back into the existing call handlers.
 *
 * On the web build (no `window.electronAPI`) every effect is inert.
 */

interface CallStateLike {
  isActive: boolean;
  callerName?: string;
  callerCompany?: string;
  phoneNumber: string;
  duration: number;
  isMuted: boolean;
  isOnHold: boolean;
  isRecording: boolean;
  isPaused: boolean;
}

interface IncomingCallLike {
  isIncoming: boolean;
  phoneNumber: string;
  callerName?: string;
}

interface UseSidebarModeArgs {
  /**
   * Set false on a shell that is NOT the one rendering the call UI. Dashboard
   * delegates to EnterprisePlatform for enterprise accounts, and only one of
   * the two may own the sidebar IPC listeners.
   */
  enabled?: boolean;
  userId?: string;
  accountType?: string;
  assignedNumber?: string | null;
  callState: CallStateLike;
  incomingCall: IncomingCallLike;
  isRegistrationStale?: boolean;
  /** True while the call is in the native floating card. */
  isPipActive?: boolean;
  /** Note session for the call in progress, so the strip can edit it in place. */
  noteSession?: SidebarState["noteSession"];
  /** Existing call handlers — reused verbatim, never re-implemented. */
  onAnswer: () => void;
  onDecline: () => void;
  onSendToVoicemail: () => void;
  onEnd: () => void;
  onMute: () => void;
  onHold: () => void;
  onRecord: () => void;
  onSendDtmf: (digit: string) => void;
  onTransfer: (targetId: string, targetType: "user" | "department") => void;
  onMakeCall: (phoneNumber: string, record?: boolean) => void;
  /** Open the per-call notes editor (premium/enterprise). */
  onOpenNotes?: () => void;
  /** Pop the call out into the native floating card, leaving the strip docked. */
  onPopOut?: () => void;
}

export function useSidebarMode({
  enabled = true,
  userId,
  accountType,
  assignedNumber,
  callState,
  incomingCall,
  isRegistrationStale,
  isPipActive,
  noteSession,
  onAnswer,
  onDecline,
  onSendToVoicemail,
  onEnd,
  onMute,
  onHold,
  onRecord,
  onSendDtmf,
  onTransfer,
  onMakeCall,
  onOpenNotes,
  onPopOut,
}: UseSidebarModeArgs) {
  const api = typeof window !== "undefined" ? window.electronAPI?.sidebar : undefined;
  const [sidebarMode, setSidebarMode] = useState(false);

  // Keep the latest handlers in a ref so the IPC listener registers once.
  const handlers = useRef({
    onAnswer,
    onDecline,
    onSendToVoicemail,
    onEnd,
    onMute,
    onHold,
    onRecord,
    onSendDtmf,
    onTransfer,
    onMakeCall,
    onOpenNotes,
    onPopOut,
  });
  handlers.current = {
    onAnswer,
    onDecline,
    onSendToVoicemail,
    onEnd,
    onMute,
    onHold,
    onRecord,
    onSendDtmf,
    onTransfer,
    onMakeCall,
    onOpenNotes,
    onPopOut,
  };

  // Latest snapshot, so `sidebar:request-state` can answer immediately.
  const snapshot = useRef<SidebarState | null>(null);
  snapshot.current = {
    call: {
      isActive: callState.isActive,
      callerName: callState.callerName,
      callerCompany: callState.callerCompany,
      phoneNumber: callState.phoneNumber,
      duration: callState.duration,
      isMuted: callState.isMuted,
      isOnHold: callState.isOnHold,
      isRecording: callState.isRecording,
      isPaused: callState.isPaused,
    },
    incoming: {
      isIncoming: incomingCall.isIncoming,
      phoneNumber: incomingCall.phoneNumber,
      callerName: incomingCall.callerName,
    },
    assignedNumber: assignedNumber ?? null,
    userId,
    accountType,
    isRegistrationStale: !!isRegistrationStale,
    isPipActive: !!isPipActive,
    noteSession: noteSession ?? null,
  };

  // ── Receive actions from the strip ──────────────────────────────────────
  useEffect(() => {
    // No cleanup is returned when disabled — tearing listeners down here would
    // clobber the shell that legitimately owns them.
    if (!api || !enabled) return;

    api.onModeChange((enabled) => setSidebarMode(enabled));
    api.onRequestState(() => {
      if (snapshot.current) api.pushState(snapshot.current);
    });
    api.onAction((action: SidebarAction) => {
      const h = handlers.current;
      const payload = action.payload as Record<string, unknown> | string | undefined;

      switch (action.type) {
        case "answer":
          h.onAnswer();
          break;
        case "decline":
          h.onDecline();
          break;
        case "voicemail":
          h.onSendToVoicemail();
          break;
        case "end":
          h.onEnd();
          break;
        case "mute":
          h.onMute();
          break;
        case "hold":
          h.onHold();
          break;
        case "record":
          h.onRecord();
          break;
        case "dtmf":
          if (typeof payload === "string") h.onSendDtmf(payload);
          break;
        case "transfer": {
          const p = payload as { targetId?: string; targetType?: "user" | "department" };
          if (p?.targetId && p?.targetType) h.onTransfer(p.targetId, p.targetType);
          break;
        }
        case "dial": {
          const p = payload as { number?: string; record?: boolean };
          if (p?.number) h.onMakeCall(p.number, !!p.record);
          break;
        }
        case "notes":
          // Notes editing needs the full window.
          api.exit();
          h.onOpenNotes?.();
          break;
        case "pip":
          // Hand the call to the native floating card. The strip deliberately
          // stays docked — the user gets both surfaces at once.
          h.onPopOut?.();
          break;
        case "open-full-app":
          api.exit();
          break;
        default:
          break;
      }
    });

    // Restore whichever mode the app was launched into. The main process waits
    // for this signal before re-docking, so it never hides the sign-in screen.
    api.getMode().then((enabled) => setSidebarMode(!!enabled)).catch(() => {});
    api.shellReady();

    return () => api.removeAllListeners();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, enabled]);

  // ── Mirror state into the strip ─────────────────────────────────────────
  // Only while docked — there is nothing listening otherwise.
  useEffect(() => {
    if (!api || !enabled || !sidebarMode || !snapshot.current) return;
    api.pushState(snapshot.current);
  }, [
    api,
    enabled,
    sidebarMode,
    callState.isActive,
    callState.callerName,
    callState.callerCompany,
    callState.phoneNumber,
    callState.duration,
    callState.isMuted,
    callState.isOnHold,
    callState.isRecording,
    callState.isPaused,
    incomingCall.isIncoming,
    incomingCall.phoneNumber,
    incomingCall.callerName,
    assignedNumber,
    userId,
    accountType,
    isRegistrationStale,
    isPipActive,
    noteSession?.callRef,
  ]);

  // ── Relay toasts into the strip ─────────────────────────────────────────
  // This window is hidden while docked, so anything it toasts would otherwise
  // be invisible — including the entire success/failure story for recording.
  const { toasts } = useToast();
  const lastToastId = useRef<string | null>(null);

  // Toasts linger in the store long after they were shown (e.g. the login
  // "Welcome back!"), so on docking, mark whatever is already there as seen —
  // only toasts raised AFTER entering Sidebar Mode are relayed.
  useEffect(() => {
    if (sidebarMode) lastToastId.current = toasts[0]?.id ?? null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sidebarMode]);

  useEffect(() => {
    if (!api || !enabled || !sidebarMode) return;
    const newest = toasts[0];
    if (!newest || newest.id === lastToastId.current) return;
    lastToastId.current = newest.id;

    // Only plain-text toasts survive the IPC hop; React nodes are skipped.
    const asText = (v: unknown) => (typeof v === "string" ? v : undefined);
    const title = asText(newest.title);
    const description = asText(newest.description);
    if (!title && !description) return;

    api.pushToast({
      title,
      description,
      variant: newest.variant === "destructive" ? "destructive" : "default",
    });
  }, [api, enabled, sidebarMode, toasts]);

  const enterSidebarMode = useCallback(() => api?.enter(), [api]);
  const exitSidebarMode = useCallback(() => api?.exit(), [api]);

  return {
    /** True while the app is docked as a strip (this window is hidden). */
    sidebarMode,
    /** Whether Sidebar Mode is available at all (Electron build only). */
    isAvailable: !!api && enabled,
    enterSidebarMode,
    exitSidebarMode,
  };
}
