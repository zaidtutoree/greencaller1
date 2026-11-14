import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  PhoneIncoming,
  PhoneOutgoing,
  NotebookPen,
  Pencil,
  Trash2,
  Check,
  X,
  Clock,
} from "lucide-react";
import { format } from "date-fns";
import { useCallNotes } from "@/hooks/useCallNotes";
import { cn } from "@/lib/utils";

interface CallNotesProps {
  userId?: string;
  /**
   * Tighter, card-less layout for narrow containers (Sidebar Mode's panel).
   * The panel supplies the title, so the header is dropped too.
   */
  compact?: boolean;
}

const formatDuration = (seconds?: number | null) => {
  const total = seconds || 0;
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${mins}:${secs.toString().padStart(2, "0")}`;
};

export const CallNotes = ({ userId, compact = false }: CallNotesProps) => {
  const { notes, loading, updateNote, deleteNote } = useCallNotes(userId);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  const startEdit = (id: string, current: string) => {
    setEditingId(id);
    setDraft(current);
  };

  const saveEdit = async (id: string) => {
    await updateNote(id, draft);
    setEditingId(null);
  };

  const body = loading ? (
    <div className={cn("text-center text-muted-foreground", compact ? "py-6 text-xs" : "py-8")}>Loading notes…</div>
  ) : notes.length === 0 ? (
    <div className={cn("text-center text-muted-foreground", compact ? "py-8" : "py-12")}>
      <NotebookPen className={cn("mx-auto opacity-40", compact ? "mb-2 h-7 w-7" : "mb-3 h-10 w-10")} />
      <p className={cn("font-medium", compact && "text-xs")}>No call notes yet</p>
      <p className={cn("mt-1", compact ? "text-[11px]" : "text-sm")}>
        Tap the <span className="font-medium">Notes</span> button during a call to jot
        something down.
      </p>
    </div>
  ) : (
    <div className={compact ? "space-y-2" : "space-y-3"}>
      {notes.map((n) => {
        const outbound = n.direction === "outbound";
        const isEditing = editingId === n.id;
        const label = n.contact_name || n.phone_number || "Unknown";
        return (
          <div
            key={n.id}
            className={cn(
              "rounded-lg border bg-card transition-colors hover:bg-accent/5",
              compact ? "p-2.5" : "p-4",
            )}
          >
            {/* Header row: who + when + actions */}
            <div className="flex items-start justify-between gap-2">
              <div className={cn("flex items-center min-w-0", compact ? "gap-2" : "gap-3")}>
                <div
                  className={cn(
                    "rounded-full flex items-center justify-center shrink-0",
                    compact ? "h-7 w-7" : "h-9 w-9",
                    outbound ? "bg-success/10 text-success" : "bg-primary/10 text-primary",
                  )}
                >
                  {outbound ? (
                    <PhoneOutgoing className={compact ? "h-3.5 w-3.5" : "h-4 w-4"} />
                  ) : (
                    <PhoneIncoming className={compact ? "h-3.5 w-3.5" : "h-4 w-4"} />
                  )}
                </div>
                <div className="min-w-0">
                  <div className={cn("font-semibold truncate", compact && "text-xs")}>{label}</div>
                  <div
                    className={cn(
                      "flex items-center gap-2 text-muted-foreground mt-0.5",
                      compact ? "text-[10px]" : "text-xs",
                    )}
                  >
                    {!compact && (
                      <Badge variant="outline" className="font-normal py-0">
                        {outbound ? "Outbound" : "Inbound"}
                      </Badge>
                    )}
                    <span>{format(new Date(n.created_at), compact ? "d MMM · HH:mm" : "MMM d, yyyy · h:mm a")}</span>
                    {n.duration ? (
                      <span className="flex items-center gap-1">
                        <Clock className="w-3 h-3" />
                        {formatDuration(n.duration)}
                      </span>
                    ) : null}
                  </div>
                </div>
              </div>

              {!isEditing && (
                <div className="flex items-center gap-0.5 shrink-0">
                  <Button
                    variant="ghost"
                    size="icon"
                    className={compact ? "h-7 w-7" : "h-8 w-8"}
                    onClick={() => startEdit(n.id, n.note)}
                    title="Edit note"
                  >
                    <Pencil className={compact ? "h-3.5 w-3.5" : "h-4 w-4"} />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className={cn("text-destructive hover:text-destructive", compact ? "h-7 w-7" : "h-8 w-8")}
                    onClick={() => deleteNote(n.id)}
                    title="Delete note"
                  >
                    <Trash2 className={compact ? "h-3.5 w-3.5" : "h-4 w-4"} />
                  </Button>
                </div>
              )}
            </div>

            {/* Note body */}
            {isEditing ? (
              <div className={cn("space-y-2", compact ? "mt-2" : "mt-3")}>
                <Textarea
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  className={cn("resize-none", compact ? "min-h-[72px] text-xs" : "min-h-[100px]")}
                  autoFocus
                />
                <div className="flex justify-end gap-2">
                  <Button variant="ghost" size="sm" className={compact ? "h-7 text-xs" : undefined} onClick={() => setEditingId(null)}>
                    <X className="w-4 h-4 mr-1" />
                    Cancel
                  </Button>
                  <Button size="sm" className={compact ? "h-7 text-xs" : undefined} onClick={() => saveEdit(n.id)}>
                    <Check className="w-4 h-4 mr-1" />
                    Save
                  </Button>
                </div>
              </div>
            ) : (
              <p
                className={cn(
                  "whitespace-pre-wrap break-words text-foreground/90",
                  compact ? "mt-2 text-xs leading-relaxed" : "mt-3 text-sm",
                )}
              >
                {n.note}
              </p>
            )}
          </div>
        );
      })}
    </div>
  );

  if (compact) {
    return <div className="p-3">{body}</div>;
  }

  return (
    <Card className="max-w-4xl mx-auto">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <NotebookPen className="w-5 h-5" />
          Call Notes
        </CardTitle>
      </CardHeader>
      <CardContent>{body}</CardContent>
    </Card>
  );
};

export default CallNotes;
