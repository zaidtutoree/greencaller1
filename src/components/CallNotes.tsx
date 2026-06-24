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

interface CallNotesProps {
  userId?: string;
}

const formatDuration = (seconds?: number | null) => {
  const total = seconds || 0;
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${mins}:${secs.toString().padStart(2, "0")}`;
};

export const CallNotes = ({ userId }: CallNotesProps) => {
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

  return (
    <Card className="max-w-4xl mx-auto">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <NotebookPen className="w-5 h-5" />
          Call Notes
        </CardTitle>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="text-center py-8 text-muted-foreground">Loading notes…</div>
        ) : notes.length === 0 ? (
          <div className="text-center py-12 text-muted-foreground">
            <NotebookPen className="w-10 h-10 mx-auto mb-3 opacity-40" />
            <p className="font-medium">No call notes yet</p>
            <p className="text-sm mt-1">
              Tap the <span className="font-medium">Notes</span> button during a call to jot
              something down.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {notes.map((n) => {
              const outbound = n.direction === "outbound";
              const isEditing = editingId === n.id;
              const label = n.contact_name || n.phone_number || "Unknown";
              return (
                <div
                  key={n.id}
                  className="rounded-lg border bg-card p-4 transition-colors hover:bg-accent/5"
                >
                  {/* Header row: who + when + actions */}
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-center gap-3 min-w-0">
                      <div
                        className={`w-9 h-9 rounded-full flex items-center justify-center shrink-0 ${
                          outbound
                            ? "bg-success/10 text-success"
                            : "bg-primary/10 text-primary"
                        }`}
                      >
                        {outbound ? (
                          <PhoneOutgoing className="w-4 h-4" />
                        ) : (
                          <PhoneIncoming className="w-4 h-4" />
                        )}
                      </div>
                      <div className="min-w-0">
                        <div className="font-semibold truncate">{label}</div>
                        <div className="flex items-center gap-2 text-xs text-muted-foreground mt-0.5">
                          <Badge variant="outline" className="font-normal py-0">
                            {outbound ? "Outbound" : "Inbound"}
                          </Badge>
                          <span>{format(new Date(n.created_at), "MMM d, yyyy · h:mm a")}</span>
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
                      <div className="flex items-center gap-1 shrink-0">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8"
                          onClick={() => startEdit(n.id, n.note)}
                          title="Edit note"
                        >
                          <Pencil className="w-4 h-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 text-destructive hover:text-destructive"
                          onClick={() => deleteNote(n.id)}
                          title="Delete note"
                        >
                          <Trash2 className="w-4 h-4" />
                        </Button>
                      </div>
                    )}
                  </div>

                  {/* Note body */}
                  {isEditing ? (
                    <div className="mt-3 space-y-2">
                      <Textarea
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        className="min-h-[100px] resize-none"
                        autoFocus
                      />
                      <div className="flex justify-end gap-2">
                        <Button variant="ghost" size="sm" onClick={() => setEditingId(null)}>
                          <X className="w-4 h-4 mr-1" />
                          Cancel
                        </Button>
                        <Button size="sm" onClick={() => saveEdit(n.id)}>
                          <Check className="w-4 h-4 mr-1" />
                          Save
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <p className="mt-3 text-sm whitespace-pre-wrap break-words text-foreground/90">
                      {n.note}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
};

export default CallNotes;
