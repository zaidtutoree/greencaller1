import { format } from "date-fns";
import { Clock, NotebookPen, PhoneIncoming, PhoneOutgoing } from "lucide-react";
import { useCallNotes } from "@/hooks/useCallNotes";
import { cn } from "@/lib/utils";

interface NotesListProps {
  userId?: string;
}

const fmtDuration = (seconds?: number | null) => {
  const total = seconds || 0;
  return `${Math.floor(total / 60)}:${(total % 60).toString().padStart(2, "0")}`;
};

/** Read-only view of a teammate's call notes (Control dashboard). */
export const NotesList = ({ userId }: NotesListProps) => {
  const { notes, loading } = useCallNotes(userId);

  if (loading) {
    return <p className="py-8 text-center text-sm text-muted-foreground">Loading notes…</p>;
  }

  if (notes.length === 0) {
    return (
      <div className="py-10 text-center text-muted-foreground">
        <NotebookPen className="mx-auto mb-2 h-8 w-8 opacity-40" />
        <p className="text-sm">No call notes yet</p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {notes.map((n) => {
        const outbound = n.direction === "outbound";
        return (
          <div key={n.id} className="rounded-lg border bg-card p-3">
            <div className="flex items-center gap-2.5">
              <div
                className={cn(
                  "flex h-8 w-8 shrink-0 items-center justify-center rounded-full",
                  outbound ? "bg-success/10 text-success" : "bg-primary/10 text-primary",
                )}
              >
                {outbound ? <PhoneOutgoing className="h-3.5 w-3.5" /> : <PhoneIncoming className="h-3.5 w-3.5" />}
              </div>
              <div className="min-w-0">
                <div className="truncate text-sm font-medium">{n.contact_name || n.phone_number || "Unknown"}</div>
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span>{format(new Date(n.created_at), "d MMM yyyy · HH:mm")}</span>
                  {n.duration ? (
                    <span className="flex items-center gap-1">
                      <Clock className="h-3 w-3" />
                      {fmtDuration(n.duration)}
                    </span>
                  ) : null}
                </div>
              </div>
            </div>
            <p className="mt-2 whitespace-pre-wrap break-words text-sm text-foreground/90">{n.note}</p>
          </div>
        );
      })}
    </div>
  );
};

export default NotesList;
