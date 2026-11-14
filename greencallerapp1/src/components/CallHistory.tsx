import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Phone, PhoneIncoming, PhoneOutgoing, Clock, Sparkles, NotebookPen } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { format } from "date-fns";
import { CallSummaryDialog, CallSummaryTarget } from "@/components/CallSummaryDialog";
import { CallNoteDialog, type CallNoteSession } from "@/components/CallNoteDialog";
import { findNoteForHistoryCall, useCallNotes } from "@/hooks/useCallNotes";
import { cn } from "@/lib/utils";

interface Call {
  id: string;
  call_sid: string | null;
  from_number: string;
  to_number: string;
  direction: string;
  duration: number;
  status: string;
  created_at: string;
  /** Surface that handled the call: web | desktop | mobile | deskphone. */
  device?: string | null;
}

interface RecordingLite {
  id: string;
  call_sid: string;
  from_number: string;
  to_number: string;
  direction: string;
  created_at: string;
  ai_summary: string | null;
}

interface CallHistoryProps {
  userId?: string;
  filterMissed?: boolean;
  accountType?: string;
}

const CallHistory = ({ userId, filterMissed, accountType }: CallHistoryProps) => {
  const [calls, setCalls] = useState<Call[]>([]);
  const [recordings, setRecordings] = useState<RecordingLite[]>([]);
  const [summaryTarget, setSummaryTarget] = useState<CallSummaryTarget | null>(null);
  const [summaryOpen, setSummaryOpen] = useState(false);

  const canUseSummary = accountType === "premium" || accountType === "enterprise";
  // Notes share the premium/enterprise gate used for the in-call note button.
  const canUseNotes = canUseSummary;

  // Existing notes (live via realtime) so each row can show whether it already
  // has one, and so re-opening a call edits that same note instead of a second.
  const { notes } = useCallNotes(canUseNotes ? userId : undefined);
  const [noteSession, setNoteSession] = useState<CallNoteSession | null>(null);
  const [noteDuration, setNoteDuration] = useState<number>(0);
  const [noteOpen, setNoteOpen] = useState(false);

  const openNote = (call: Call) => {
    const existing = findNoteForHistoryCall(notes, call);
    const other = call.direction === "outbound" ? call.to_number : call.from_number;
    setNoteSession({
      // Reuse the in-call note's ref when there is one; otherwise key the note
      // to the history row so repeated edits always land on the same note.
      callRef: existing?.call_ref ?? `hist:${call.id}`,
      phoneNumber: other,
      contactName: existing?.contact_name ?? undefined,
      direction: call.direction === "outbound" ? "outbound" : "inbound",
      callHistoryId: call.id,
      whenLabel: format(new Date(call.created_at), "MMM d, h:mm a"),
    });
    setNoteDuration(existing?.duration ?? call.duration ?? 0);
    setNoteOpen(true);
  };

  useEffect(() => {
    fetchCalls();
    if (canUseSummary) fetchRecordings();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, filterMissed, canUseSummary]);

  const fetchCalls = async () => {
    if (!userId) return;

    let query = supabase
      .from("call_history")
      .select("*")
      .eq("user_id", userId);

    if (filterMissed) {
      // Only show actual missed calls: inbound calls that weren't answered
      query = query
        .eq("direction", "inbound")
        .in("status", ["no-answer", "busy", "failed", "missed", "ringing"]);
    }

    const { data, error } = await query.order("created_at", { ascending: false });

    if (error) {
      console.error("Error fetching calls:", error);
    } else {
      setCalls(data || []);
    }
  };

  const fetchRecordings = async () => {
    if (!userId) return;
    const { data, error } = await supabase
      .from("call_recordings")
      .select("id, call_sid, from_number, to_number, direction, created_at, ai_summary")
      .eq("user_id", userId);
    if (error) {
      console.error("Error fetching recordings:", error);
    } else {
      setRecordings(data || []);
    }
  };

  // Find the recording backing a call: match on call_sid first (most reliable),
  // then fall back to same numbers within a few minutes.
  const findRecording = (call: Call): RecordingLite | undefined => {
    if (call.call_sid) {
      const bySid = recordings.find((r) => r.call_sid === call.call_sid);
      if (bySid) return bySid;
    }
    const callTime = new Date(call.created_at).getTime();
    return recordings.find((r) => {
      const sameParties =
        r.from_number === call.from_number && r.to_number === call.to_number;
      if (!sameParties) return false;
      const diff = Math.abs(new Date(r.created_at).getTime() - callTime);
      return diff < 5 * 60 * 1000;
    });
  };

  const openSummary = (recording: RecordingLite) => {
    setSummaryTarget({
      recordingId: recording.id,
      phoneNumber: recording.direction === "outbound" ? recording.to_number : recording.from_number,
      direction: recording.direction,
      hasSummary: !!recording.ai_summary,
    });
    setSummaryOpen(true);
  };

  const formatDuration = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, "0")}`;
  };

  const getStatusLabel = (status: string, direction: string, duration: number) => {
    // For inbound calls that weren't answered, show as "Missed"
    if (direction === "inbound" && ["ringing", "missed", "no-answer", "busy", "failed"].includes(status)) {
      return "Missed";
    }
    // For inbound calls that were answered
    if (direction === "inbound" && (status === "answered" || status === "completed")) {
      return "Answered";
    }
    // For outbound calls that weren't answered (not completed/answered), show as "Ringing"
    if (direction === "outbound" && !["completed", "answered"].includes(status)) {
      return "Ringing";
    }
    // For outbound calls that were answered/completed
    if (direction === "outbound" && ["completed", "answered"].includes(status)) {
      return "Completed";
    }
    // Fallback
    return status.charAt(0).toUpperCase() + status.slice(1);
  };

  const isMissedCall = (call: Call) => {
    // A call is missed if:
    // - It's inbound AND (status is missed/no-answer/busy/failed OR status is ringing with 0 duration)
    return call.direction === "inbound" && (
      ["no-answer", "busy", "failed", "missed"].includes(call.status) ||
      (call.status === "ringing" && call.duration === 0)
    );
  };

  return (
    <Card className="max-w-4xl mx-auto">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Clock className="w-5 h-5" />
          {filterMissed ? "Missed Calls" : "Call History"}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {calls.length === 0 ? (
          <div className="text-center py-8 text-muted-foreground">
            No call history yet. Make your first call from the Dial tab!
          </div>
        ) : (
          <div className="space-y-3">
            {calls.map((call) => {
              const recording = canUseSummary ? findRecording(call) : undefined;
              return (
                <div
                  key={call.id}
                  className="flex items-center justify-between p-4 rounded-lg border bg-card hover:bg-accent/5 transition-colors"
                >
                  <div className="flex items-center gap-4">
                    <div
                      className={`w-10 h-10 rounded-full flex items-center justify-center ${
                        isMissedCall(call)
                          ? "bg-destructive/10 text-destructive"
                          : call.direction === "outbound"
                          ? "bg-success/10 text-success"
                          : "bg-primary/10 text-primary"
                      }`}
                    >
                      {call.direction === "outbound" ? (
                        <PhoneOutgoing className="w-5 h-5" />
                      ) : (
                        <PhoneIncoming className="w-5 h-5" />
                      )}
                    </div>
                    <div>
                      <div className="font-semibold flex items-center gap-2">
                        {call.direction === "outbound" ? call.to_number : call.from_number}
                        {call.device === "deskphone" && (
                          <span
                            className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground"
                            title="Handled on the desk phone"
                          >
                            <Phone className="w-3 h-3" />
                            Desk phone
                          </span>
                        )}
                      </div>
                      <div className="text-sm text-muted-foreground">
                        {format(new Date(call.created_at), "MMM d, yyyy - h:mm a")}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    {canUseNotes && (() => {
                      const hasNote = !!findNoteForHistoryCall(notes, call);
                      return (
                        <Button
                          variant="outline"
                          size="sm"
                          className={cn("gap-1.5", hasNote && "border-primary/40 text-primary")}
                          onClick={() => openNote(call)}
                          title={hasNote ? "View or edit the note for this call" : "Add a note about this call"}
                        >
                          <NotebookPen className="w-4 h-4" />
                          <span className="hidden sm:inline">{hasNote ? "Note" : "Add note"}</span>
                        </Button>
                      );
                    })()}
                    {recording && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="gap-1.5"
                        onClick={() => openSummary(recording)}
                        title="AI summary of this call"
                      >
                        <Sparkles className="w-4 h-4 text-primary" />
                        <span className="hidden sm:inline">AI Summary</span>
                      </Button>
                    )}
                    <div className="text-right">
                      <Badge
                        variant={isMissedCall(call) ? "destructive" : "outline"}
                        className="mb-1"
                      >
                        {getStatusLabel(call.status, call.direction, call.duration)}
                      </Badge>
                      <div className="text-sm text-muted-foreground">
                        {formatDuration(call.duration)}
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>

      <CallSummaryDialog
        open={summaryOpen}
        onOpenChange={setSummaryOpen}
        target={summaryTarget}
      />
      {canUseNotes && (
        <CallNoteDialog
          open={noteOpen}
          onOpenChange={setNoteOpen}
          userId={userId}
          session={noteSession}
          duration={noteDuration}
        />
      )}
    </Card>
  );
};

export default CallHistory;
