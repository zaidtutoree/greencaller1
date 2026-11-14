import { useEffect, useRef, useState } from "react";
import type { CallNoteSession } from "@/components/CallNoteDialog";

interface CallStateLike {
  isActive: boolean;
  phoneNumber: string;
  callerName?: string;
}

function genCallRef(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `call_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  }
}

/**
 * Owns the per-call note state for a page (Dashboard / EnterprisePlatform).
 *
 * - Generates a STABLE client-side `callRef` for the current active call so a call
 *   always maps to a single note row (independent of the backend's call_sid churn).
 * - Tracks direction via markOutbound()/markInbound() called from the page's
 *   make-call / answer handlers (keeps the call hooks untouched).
 * - Exposes openNotes() which snapshots the live caller info into a note session.
 */
export function useCallNoteController(callState: CallStateLike) {
  const callRef = useRef<string | null>(null);
  const directionRef = useRef<"inbound" | "outbound" | null>(null);
  const [notesOpen, setNotesOpen] = useState(false);
  const [session, setSession] = useState<CallNoteSession | null>(null);

  // Lazily mint a ref the first time a call goes active (safe render-time init).
  if (callState.isActive && !callRef.current) {
    callRef.current = genCallRef();
  }

  // Reset everything once the call ends.
  useEffect(() => {
    if (!callState.isActive) {
      callRef.current = null;
      directionRef.current = null;
      setNotesOpen(false);
      setSession(null);
    }
  }, [callState.isActive]);

  const markOutbound = () => {
    directionRef.current = "outbound";
  };
  const markInbound = () => {
    directionRef.current = "inbound";
  };

  const openNotes = () => {
    if (!callRef.current) return;
    setSession({
      callRef: callRef.current,
      phoneNumber: callState.phoneNumber,
      contactName: callState.callerName,
      direction: directionRef.current ?? undefined,
    });
    setNotesOpen(true);
  };

  return { notesOpen, setNotesOpen, session, openNotes, markOutbound, markInbound };
}
