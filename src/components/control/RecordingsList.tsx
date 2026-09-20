import { useCallback, useEffect, useMemo, useState } from "react";
import { format } from "date-fns";
import { Download, Mic, PhoneIncoming, PhoneOutgoing, Play, Sparkles } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import RecordingPlayerModal from "@/components/RecordingPlayerModal";
import { CallSummaryDialog, type CallSummaryTarget } from "@/components/CallSummaryDialog";

interface Recording {
  id: string;
  user_id: string;
  call_sid: string;
  recording_sid: string;
  recording_url: string;
  duration: number;
  from_number: string;
  to_number: string;
  direction: string;
  created_at: string;
  ai_summary: string | null;
}

interface RecordingsListProps {
  /** Recordings owned by this user… */
  userId?: string;
  /** …or by any of these users (an IVR number spans the whole team). */
  userIds?: string[];
  /** Keep only recordings where one party is this number (last 9 digits). */
  matchNumber?: string | null;
  /** Shows who made the recording — for team-wide lists. */
  userNames?: Record<string, string>;
}

const last9 = (n?: string | null) => (n || "").replace(/[^0-9]/g, "").slice(-9);

const fmtDuration = (seconds?: number | null) => {
  const total = seconds || 0;
  return `${Math.floor(total / 60)}:${(total % 60).toString().padStart(2, "0")}`;
};

/**
 * Read-only recordings for the Control dashboard: play, download, AI
 * summary. Deletion and transcription stay with the recording's owner.
 */
export const RecordingsList = ({ userId, userIds, matchNumber, userNames }: RecordingsListProps) => {
  const { toast } = useToast();
  const [rows, setRows] = useState<Recording[]>([]);
  const [loading, setLoading] = useState(true);
  const [playing, setPlaying] = useState<Recording | null>(null);
  const [playerOpen, setPlayerOpen] = useState(false);
  const [summaryTarget, setSummaryTarget] = useState<CallSummaryTarget | null>(null);
  const [summaryOpen, setSummaryOpen] = useState(false);

  const owners = useMemo(() => (userIds && userIds.length ? userIds : userId ? [userId] : []), [userId, userIds]);
  const ownersKey = owners.join(",");

  const load = useCallback(async () => {
    if (owners.length === 0) {
      setRows([]);
      setLoading(false);
      return;
    }
    const { data, error } = await supabase
      .from("call_recordings")
      .select("id, user_id, call_sid, recording_sid, recording_url, duration, from_number, to_number, direction, created_at, ai_summary")
      .in("user_id", owners)
      .order("created_at", { ascending: false })
      .limit(300);
    if (error) console.error("RecordingsList fetch error:", error);
    setRows((data as Recording[]) || []);
    setLoading(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ownersKey]);

  useEffect(() => {
    load();
  }, [load]);

  const visible = useMemo(() => {
    if (!matchNumber) return rows;
    const target = last9(matchNumber);
    if (!target) return rows;
    return rows.filter((r) => last9(r.from_number) === target || last9(r.to_number) === target);
  }, [rows, matchNumber]);

  const download = async (r: Recording) => {
    try {
      const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
      const supabaseKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
      if (!supabaseUrl || !supabaseKey) {
        window.open(r.recording_url, "_blank");
        return;
      }
      const { data: { session } } = await supabase.auth.getSession();
      const params = new URLSearchParams();
      if (r.recording_sid) params.set("sid", r.recording_sid);
      params.set("url", r.recording_url);
      const res = await fetch(`${supabaseUrl}/functions/v1/proxy-recording?${params.toString()}`, {
        headers: { apikey: supabaseKey, Authorization: `Bearer ${session?.access_token || supabaseKey}` },
      });
      if (!res.ok) throw new Error(`Download failed (${res.status})`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `recording-${r.recording_sid || r.id}.mp3`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e: any) {
      toast({ title: "Download failed", description: e.message || "Please try again", variant: "destructive" });
    }
  };

  if (loading) {
    return <p className="py-8 text-center text-sm text-muted-foreground">Loading recordings…</p>;
  }

  if (visible.length === 0) {
    return (
      <div className="py-10 text-center text-muted-foreground">
        <Mic className="mx-auto mb-2 h-8 w-8 opacity-40" />
        <p className="text-sm">No recordings yet</p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {visible.map((r) => {
        const outbound = r.direction === "outbound";
        const number = outbound ? r.to_number : r.from_number;
        return (
          <div
            key={r.id}
            className="flex items-center gap-3 rounded-lg border bg-card px-3 py-2.5 transition-colors hover:bg-accent/5"
          >
            <Button
              size="icon"
              className="h-9 w-9 shrink-0 rounded-full"
              title="Play recording"
              onClick={() => {
                setPlaying(r);
                setPlayerOpen(true);
              }}
            >
              <Play className="ml-0.5 h-4 w-4" />
            </Button>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5 min-w-0">
                {outbound ? (
                  <PhoneOutgoing className="h-3.5 w-3.5 shrink-0 text-success" />
                ) : (
                  <PhoneIncoming className="h-3.5 w-3.5 shrink-0 text-primary" />
                )}
                <span className="truncate text-sm font-medium">{number}</span>
                {userNames?.[r.user_id] && (
                  <span className="truncate text-xs text-muted-foreground">· {userNames[r.user_id]}</span>
                )}
              </div>
              <div className="text-xs text-muted-foreground">
                {format(new Date(r.created_at), "d MMM yyyy · HH:mm")} · {fmtDuration(r.duration)}
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <Button
                variant="outline"
                size="sm"
                className={cn("h-8 gap-1.5", r.ai_summary && "border-primary/40")}
                onClick={() => {
                  setSummaryTarget({
                    recordingId: r.id,
                    phoneNumber: number,
                    direction: r.direction,
                    hasSummary: !!r.ai_summary,
                  });
                  setSummaryOpen(true);
                }}
              >
                <Sparkles className="h-3.5 w-3.5 text-primary" />
                <span className="hidden sm:inline">AI Summary</span>
              </Button>
              <Button variant="ghost" size="icon" className="h-8 w-8" title="Download" onClick={() => download(r)}>
                <Download className="h-4 w-4" />
              </Button>
            </div>
          </div>
        );
      })}

      <RecordingPlayerModal recording={playing} open={playerOpen} onOpenChange={setPlayerOpen} />
      <CallSummaryDialog open={summaryOpen} onOpenChange={setSummaryOpen} target={summaryTarget} />
    </div>
  );
};

export default RecordingsList;
