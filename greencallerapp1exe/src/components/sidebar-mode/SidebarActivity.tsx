import { useCallback, useEffect, useMemo, useState } from "react";
import { format, isToday, isYesterday } from "date-fns";
import { History, Mic, PhoneIncoming, PhoneOutgoing, Play, Sparkles } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { cn } from "@/lib/utils";
import RecordingPlayerModal from "@/components/RecordingPlayerModal";
import { CallSummaryInline, type CallSummaryTarget } from "@/components/CallSummaryDialog";

interface CallRow {
  id: string;
  call_sid: string | null;
  from_number: string;
  to_number: string;
  direction: string;
  duration: number;
  status: string;
  created_at: string;
}

interface RecordingRow {
  id: string;
  call_sid: string;
  recording_sid: string;
  recording_url: string;
  from_number: string;
  to_number: string;
  direction: string;
  duration: number;
  created_at: string;
  ai_summary: string | null;
}

interface SidebarActivityProps {
  userId?: string;
  accountType?: string;
}

type Mode = "recents" | "recordings";

const MISSED = ["no-answer", "busy", "failed", "missed"];

const fmtDuration = (seconds?: number | null) => {
  const total = seconds || 0;
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
};

/** "Today 14:05", "Yesterday 09:12", otherwise "12 Sep 14:05". */
const fmtWhen = (iso: string) => {
  const d = new Date(iso);
  if (isToday(d)) return `Today ${format(d, "HH:mm")}`;
  if (isYesterday(d)) return `Yesterday ${format(d, "HH:mm")}`;
  return format(d, "d MMM HH:mm");
};

const isMissed = (c: CallRow) =>
  c.direction === "inbound" &&
  (MISSED.includes(c.status) || (c.status === "ringing" && c.duration === 0));

/**
 * The strip's Activity panel: recent calls and recordings in one place, laid
 * out for a 380px column. Rows are deliberately single-purpose — one icon,
 * one line of text, one trailing action — so nothing wraps into anything else.
 */
export const SidebarActivity = ({ userId, accountType }: SidebarActivityProps) => {
  const [mode, setMode] = useState<Mode>("recents");
  const [calls, setCalls] = useState<CallRow[]>([]);
  const [recordings, setRecordings] = useState<RecordingRow[]>([]);
  const [loading, setLoading] = useState(true);

  const [playing, setPlaying] = useState<RecordingRow | null>(null);
  const [playerOpen, setPlayerOpen] = useState(false);
  /** Summary shown in place of the list — a modal doesn't fit the docked panel. */
  const [summaryTarget, setSummaryTarget] = useState<CallSummaryTarget | null>(null);

  const canSummarise = accountType === "premium" || accountType === "enterprise";

  const load = useCallback(async () => {
    if (!userId) return;
    const [callsRes, recRes] = await Promise.all([
      supabase
        .from("call_history")
        .select("id, call_sid, from_number, to_number, direction, duration, status, created_at")
        .eq("user_id", userId)
        .order("created_at", { ascending: false })
        .limit(150),
      supabase
        .from("call_recordings")
        .select("id, call_sid, recording_sid, recording_url, from_number, to_number, direction, duration, created_at, ai_summary")
        .eq("user_id", userId)
        .order("created_at", { ascending: false })
        .limit(150),
    ]);
    if (!callsRes.error) setCalls((callsRes.data as CallRow[]) || []);
    if (!recRes.error) setRecordings((recRes.data as RecordingRow[]) || []);
    setLoading(false);
  }, [userId]);

  useEffect(() => {
    load();
    if (!userId) return;
    const channel = supabase
      .channel(`sidebar-activity-${userId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "call_history", filter: `user_id=eq.${userId}` }, load)
      .on("postgres_changes", { event: "*", schema: "public", table: "call_recordings", filter: `user_id=eq.${userId}` }, load)
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [userId, load]);

  // Recording backing a call: by call_sid, else same parties within 5 minutes.
  const recordingFor = useMemo(() => {
    return (c: CallRow): RecordingRow | undefined => {
      if (c.call_sid) {
        const bySid = recordings.find((r) => r.call_sid === c.call_sid);
        if (bySid) return bySid;
      }
      const t = new Date(c.created_at).getTime();
      return recordings.find(
        (r) =>
          r.from_number === c.from_number &&
          r.to_number === c.to_number &&
          Math.abs(new Date(r.created_at).getTime() - t) < 5 * 60 * 1000,
      );
    };
  }, [recordings]);

  const openSummary = (r: RecordingRow) => {
    setSummaryTarget({
      recordingId: r.id,
      phoneNumber: r.direction === "outbound" ? r.to_number : r.from_number,
      direction: r.direction,
      hasSummary: !!r.ai_summary,
    });
  };

  const tabs: { id: Mode; label: string; icon: React.ElementType; count: number }[] = [
    { id: "recents", label: "Recents", icon: History, count: calls.length },
    { id: "recordings", label: "Recordings", icon: Mic, count: recordings.length },
  ];

  const empty = (text: string) => (
    <div className="px-4 py-10 text-center text-xs text-muted-foreground">{text}</div>
  );

  if (summaryTarget) {
    return (
      <CallSummaryInline
        target={summaryTarget}
        onClose={() => {
          setSummaryTarget(null);
          load(); // pick up a freshly cached ai_summary
        }}
      />
    );
  }

  return (
    <div className="flex h-full flex-col">
      {/* Segmented switch — compact so it never competes with the row content. */}
      <div className="shrink-0 border-b border-border px-3 py-2">
        <div className="flex items-center gap-0.5 rounded-md bg-muted p-0.5">
          {tabs.map((t) => {
            const Icon = t.icon;
            const active = mode === t.id;
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => setMode(t.id)}
                className={cn(
                  "flex flex-1 items-center justify-center gap-1.5 rounded px-2 py-1 text-[11px] font-medium transition-colors",
                  active ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
                )}
              >
                <Icon className="h-3.5 w-3.5" />
                {t.label}
                <span className={cn("tabular-nums", active ? "text-muted-foreground" : "text-muted-foreground/70")}>
                  {t.count}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {loading ? (
          empty("Loading…")
        ) : mode === "recents" ? (
          calls.length === 0 ? (
            empty("No calls yet")
          ) : (
            <div className="p-2 space-y-0.5">
              {calls.map((c) => {
                const missed = isMissed(c);
                const outbound = c.direction === "outbound";
                const number = outbound ? c.to_number : c.from_number;
                const rec = canSummarise ? recordingFor(c) : undefined;
                return (
                  <div
                    key={c.id}
                    className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 transition-colors hover:bg-muted/60"
                  >
                    <div
                      className={cn(
                        "flex h-7 w-7 shrink-0 items-center justify-center rounded-full",
                        missed
                          ? "bg-destructive/10 text-destructive"
                          : outbound
                            ? "bg-success/10 text-success"
                            : "bg-primary/10 text-primary",
                      )}
                    >
                      {outbound ? <PhoneOutgoing className="h-3.5 w-3.5" /> : <PhoneIncoming className="h-3.5 w-3.5" />}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5 min-w-0">
                        <span className={cn("truncate text-xs font-medium", missed && "text-destructive")}>{number}</span>
                        {missed && <span className="shrink-0 text-[10px] font-medium text-destructive">Missed</span>}
                      </div>
                      <div className="truncate text-[10px] text-muted-foreground">
                        {fmtWhen(c.created_at)}
                        {!missed && c.duration > 0 && <> · {fmtDuration(c.duration)}</>}
                      </div>
                    </div>
                    {rec && (
                      <button
                        type="button"
                        onClick={() => openSummary(rec)}
                        title="AI summary"
                        aria-label="AI summary"
                        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-primary transition-colors hover:bg-primary/10"
                      >
                        <Sparkles className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )
        ) : recordings.length === 0 ? (
          empty("No recordings yet")
        ) : (
          <div className="p-2 space-y-0.5">
            {recordings.map((r) => {
              const outbound = r.direction === "outbound";
              const number = outbound ? r.to_number : r.from_number;
              return (
                <div
                  key={r.id}
                  className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 transition-colors hover:bg-muted/60"
                >
                  <button
                    type="button"
                    onClick={() => {
                      setPlaying(r);
                      setPlayerOpen(true);
                    }}
                    title="Play recording"
                    aria-label="Play recording"
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground transition-colors hover:bg-primary/90"
                  >
                    <Play className="ml-0.5 h-3.5 w-3.5" />
                  </button>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5 min-w-0">
                      {outbound ? (
                        <PhoneOutgoing className="h-3 w-3 shrink-0 text-success" />
                      ) : (
                        <PhoneIncoming className="h-3 w-3 shrink-0 text-primary" />
                      )}
                      <span className="truncate text-xs font-medium">{number}</span>
                    </div>
                    <div className="truncate text-[10px] text-muted-foreground">
                      {fmtWhen(r.created_at)} · {fmtDuration(r.duration)}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => openSummary(r)}
                    title={r.ai_summary ? "AI summary (ready)" : "AI summary"}
                    aria-label="AI summary"
                    className={cn(
                      "flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-primary/10",
                      r.ai_summary ? "text-primary" : "text-muted-foreground hover:text-primary",
                    )}
                  >
                    <Sparkles className="h-3.5 w-3.5" />
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <RecordingPlayerModal compact recording={playing} open={playerOpen} onOpenChange={setPlayerOpen} />
    </div>
  );
};

export default SidebarActivity;
