import { useEffect, useRef, useState } from "react";
import { Check, Loader2, PhoneIncoming, PhoneOutgoing } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { getCallNote, saveCallNote } from "@/hooks/useCallNotes";
import type { SidebarState } from "./types";

interface SidebarCallNotesProps {
  userId?: string;
  session: NonNullable<SidebarState["noteSession"]>;
  /** Live call duration, stored alongside the note. */
  duration?: number;
}

/**
 * Call notes inside the docked strip.
 *
 * Reads and writes the same `call_notes` row the in-app dialog does — keyed by
 * (user_id, call_ref) — so a note started here is the same note everywhere.
 * Autosaves while typing and once more on unmount, so collapsing the panel or
 * the call ending never loses an in-progress note.
 */
export const SidebarCallNotes = ({ userId, session, duration }: SidebarCallNotesProps) => {
  const [note, setNote] = useState("");
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");

  const saveTimer = useRef<number | null>(null);
  // Persisted values read at unmount, when props are already stale.
  const latest = useRef({ note: "", userId, session, duration, loaded: false });
  latest.current = { ...latest.current, userId, session, duration };

  // Load the existing note for this call.
  useEffect(() => {
    if (!userId) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    latest.current.loaded = false;
    getCallNote(userId, session.callRef).then((existing) => {
      if (cancelled) return;
      const text = existing?.note ?? "";
      setNote(text);
      latest.current.note = text;
      latest.current.loaded = true;
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [userId, session.callRef]);

  /** Returns false when a non-empty note failed to reach the database. */
  const persist = async (text: string): Promise<boolean> => {
    const { userId: uid, session: s, duration: d } = latest.current;
    if (!uid || !s) return false;
    const saved = await saveCallNote({
      userId: uid,
      callRef: s.callRef,
      note: text,
      phoneNumber: s.phoneNumber,
      contactName: s.contactName,
      direction: s.direction,
      duration: d,
    });
    // An empty note legitimately returns null (the row is deleted).
    return !!saved || !text.trim();
  };

  const handleChange = (text: string) => {
    setNote(text);
    latest.current.note = text;
    setStatus("saving");
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(async () => {
      setStatus((await persist(text)) ? "saved" : "error");
    }, 600);
  };

  // Flush on unmount — the panel can collapse mid-sentence.
  useEffect(() => {
    return () => {
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
      if (latest.current.loaded) void persist(latest.current.note);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const title = session.contactName || session.phoneNumber || "Current call";

  return (
    <div className="flex h-full flex-col p-3">
      <div className="flex items-center gap-2 mb-2 min-w-0">
        {session.direction && (
          <Badge variant="outline" className="gap-1 font-normal text-[10px] shrink-0">
            {session.direction === "outbound" ? (
              <PhoneOutgoing className="w-3 h-3 text-success" />
            ) : (
              <PhoneIncoming className="w-3 h-3 text-primary" />
            )}
            {session.direction === "outbound" ? "Outbound" : "Inbound"}
          </Badge>
        )}
        <span className="text-xs font-medium truncate">{title}</span>
      </div>

      <Textarea
        autoFocus
        value={note}
        onChange={(e) => handleChange(e.target.value)}
        placeholder="Write notes about this call…"
        disabled={loading}
        className="flex-1 min-h-0 resize-none text-xs leading-relaxed"
      />

      <div className="mt-2 flex items-center justify-between">
        <span
          className={
            status === "error" ? "text-[10px] text-destructive" : "text-[10px] text-muted-foreground"
          }
        >
          {loading
            ? "Loading…"
            : status === "saving"
              ? "Saving…"
              : status === "saved"
                ? "Saved"
                : status === "error"
                  ? "Not saved — try again"
                  : "Saves automatically"}
        </span>
        <Button
          size="sm"
          className="h-7 gap-1.5 text-xs"
          disabled={loading || status === "saving"}
          onClick={async () => {
            if (saveTimer.current) window.clearTimeout(saveTimer.current);
            setStatus("saving");
            setStatus((await persist(note)) ? "saved" : "error");
          }}
        >
          {status === "saving" ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <Check className="w-3.5 h-3.5" />
          )}
          Save
        </Button>
      </div>
    </div>
  );
};
