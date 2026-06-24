import { useEffect, useRef, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { PhoneIncoming, PhoneOutgoing, NotebookPen, Loader2, Check } from "lucide-react";
import { getCallNote, saveCallNote } from "@/hooks/useCallNotes";
import { useToast } from "@/hooks/use-toast";

export interface CallNoteSession {
  /** Stable client-side id for the call this note belongs to. */
  callRef: string;
  phoneNumber?: string;
  contactName?: string;
  direction?: "inbound" | "outbound";
}

interface CallNoteDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  userId?: string;
  session: CallNoteSession | null;
  /** Live call duration (seconds) captured when the note is saved. */
  duration?: number;
}

export const CallNoteDialog = ({ open, onOpenChange, userId, session, duration }: CallNoteDialogProps) => {
  const [note, setNote] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const { toast } = useToast();
  const loadedRefFor = useRef<string | null>(null);

  // Load the existing note whenever the dialog opens for a call.
  useEffect(() => {
    if (!open || !userId || !session) return;
    let cancelled = false;
    setLoading(true);
    loadedRefFor.current = null;
    getCallNote(userId, session.callRef).then((existing) => {
      if (cancelled) return;
      setNote(existing?.note ?? "");
      loadedRefFor.current = session.callRef;
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, userId, session?.callRef]);

  const persist = async (showToast: boolean) => {
    if (!userId || !session) return;
    setSaving(true);
    await saveCallNote({
      userId,
      callRef: session.callRef,
      note,
      phoneNumber: session.phoneNumber,
      contactName: session.contactName,
      direction: session.direction,
      duration,
    });
    setSaving(false);
    if (showToast) toast({ title: "Note saved" });
  };

  const handleClose = async () => {
    // Autosave on close so an in-progress note is never lost.
    if (loadedRefFor.current === session?.callRef) await persist(false);
    onOpenChange(false);
  };

  const title = session?.contactName || session?.phoneNumber || "Current call";

  return (
    <Dialog open={open} onOpenChange={(o) => (o ? onOpenChange(true) : handleClose())}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <NotebookPen className="w-4 h-4 text-primary" />
            Call Notes
          </DialogTitle>
        </DialogHeader>

        <div className="flex items-center gap-2 text-sm">
          {session?.direction && (
            <Badge variant="outline" className="gap-1 font-normal">
              {session.direction === "outbound" ? (
                <PhoneOutgoing className="w-3 h-3 text-success" />
              ) : (
                <PhoneIncoming className="w-3 h-3 text-primary" />
              )}
              {session.direction === "outbound" ? "Outbound" : "Inbound"}
            </Badge>
          )}
          <span className="font-medium truncate">{title}</span>
        </div>

        <Textarea
          autoFocus
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Write notes about this call…"
          className="min-h-[170px] resize-none"
          disabled={loading}
        />

        <DialogFooter className="gap-2 sm:gap-2">
          <Button variant="ghost" onClick={handleClose}>
            Close
          </Button>
          <Button onClick={() => persist(true)} disabled={saving || loading} className="gap-1.5">
            {saving ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Check className="w-4 h-4" />
            )}
            Save note
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
