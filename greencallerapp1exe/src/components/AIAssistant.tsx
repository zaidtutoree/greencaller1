import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Bot, Phone, PhoneIncoming, Clock, Sparkles, Loader2, ClipboardList, CalendarDays } from "lucide-react";
import { Button } from "@/components/ui/button";
import { format } from "date-fns";
import { AvailabilityCalendar } from "@/components/AvailabilityCalendar";
import { cn } from "@/lib/utils";

interface AssistantSummary {
  id: string;
  name: string;
  description: string | null;
  voice: string;
  greeting: string | null;
  phone_number: string | null;
  collect_fields: string[];
  is_active: boolean;
  has_number: boolean;
}
interface Conversation {
  id: string;
  started_at: string | null;
  duration_secs: number;
  from: string | null;
  summary: string | null;
  collected: Record<string, string>;
}
interface Stats { calls: number; avg_duration_secs: number; total_duration_secs: number; }

const FIELD_LABELS: Record<string, string> = {
  name: "Name", email: "Email", phone: "Phone number", company: "Company",
  reason: "Reason for call", address: "Address", appointment: "Appointment time", budget: "Budget",
};

const fmtDur = (s: number) => {
  if (!s) return "0:00";
  const m = Math.floor(s / 60);
  return `${m}:${(s % 60).toString().padStart(2, "0")}`;
};

interface AIAssistantProps {
  userId?: string;
  /** Tighter layout for narrow containers (Sidebar Mode's slide-out panel). */
  compact?: boolean;
  /**
   * Show a specific assistant instead of the caller's own. Used by the Control
   * dashboard, where a company admin views a teammate's assistant — the edge
   * function authorises that on the server.
   */
  assistantId?: string;
  /** Hide owner-only controls (the availability calendar). */
  readOnly?: boolean;
}

export const AIAssistant = ({ userId, compact = false, assistantId, readOnly = false }: AIAssistantProps) => {
  const [loading, setLoading] = useState(true);
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [assistant, setAssistant] = useState<AssistantSummary | null>(null);
  const [stats, setStats] = useState<Stats>({ calls: 0, avg_duration_secs: 0, total_duration_secs: 0 });
  const [conversations, setConversations] = useState<Conversation[]>([]);

  const load = async () => {
    try {
      const { data, error } = await supabase.functions.invoke("ai-assistant-stats", {
        body: assistantId ? { assistantId } : {},
      });
      if (error) throw error;
      setAssistant(data?.assistant || null);
      setStats(data?.stats || { calls: 0, avg_duration_secs: 0, total_duration_secs: 0 });
      setConversations(data?.conversations || []);
    } catch (e) {
      console.error("Failed to load AI assistant stats:", e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, assistantId]);

  if (loading) {
    return <div className="flex items-center justify-center h-64"><Loader2 className="w-8 h-8 animate-spin text-primary" /></div>;
  }

  if (!assistant) {
    return (
      <div className={compact ? "p-3" : "max-w-2xl mx-auto p-6"}>
        <Card>
          <CardContent className={cn("flex flex-col items-center justify-center text-center", compact ? "py-8" : "py-16")}>
            <div className={cn("rounded-full bg-muted flex items-center justify-center", compact ? "w-12 h-12 mb-3" : "w-16 h-16 mb-4")}>
              <Bot className={compact ? "w-6 h-6 text-muted-foreground" : "w-8 h-8 text-muted-foreground"} />
            </div>
            <h3 className={cn("font-display font-semibold mb-1", compact ? "text-base" : "text-xl")}>No AI assistant yet</h3>
            <p className={cn("text-muted-foreground", compact ? "text-xs" : "max-w-sm")}>
              {readOnly
                ? "This assistant could not be loaded."
                : "You don't have an AI assistant assigned. Contact your administrator to get one set up."}
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className={cn(compact ? "p-3 space-y-3" : "max-w-4xl mx-auto p-6 space-y-6")}>
      {/* Assistant header */}
      <Card>
        <CardHeader className={compact ? "p-3 pb-2" : undefined}>
          {/* Narrow containers stack the title above its controls — side by side
              they collide once the assistant name is more than a word or two. */}
          <CardTitle
            className={cn(
              "gap-2",
              compact ? "flex flex-col items-start text-sm" : "flex items-center justify-between",
            )}
          >
            <span className="flex items-center gap-2 min-w-0 max-w-full">
              <Bot className={cn("text-primary shrink-0", compact ? "w-4 h-4" : "w-6 h-6")} />
              <span className="truncate">{assistant.name}</span>
            </span>
            <div className="flex items-center gap-2">
              {!readOnly && (
                <Button
                  size="sm"
                  variant="outline"
                  className={cn("gap-1.5", compact && "h-7 px-2 text-xs")}
                  onClick={() => setCalendarOpen(true)}
                >
                  <CalendarDays className={compact ? "w-3.5 h-3.5" : "w-4 h-4"} /> Calendar
                </Button>
              )}
              <Badge variant={assistant.is_active ? "default" : "secondary"} className={compact ? "text-[10px]" : undefined}>
                {assistant.is_active ? "Active" : "Inactive"}
              </Badge>
            </div>
          </CardTitle>
        </CardHeader>
        <CardContent className={cn(compact ? "p-3 pt-0 space-y-2" : "space-y-4")}>
          {assistant.description && (
            <p className={cn("text-muted-foreground", compact ? "text-xs" : "text-sm")}>{assistant.description}</p>
          )}
          <div className={cn("flex flex-wrap gap-2", compact ? "text-xs" : "text-sm")}>
            {assistant.phone_number ? (
              <Badge variant="outline" className={cn("gap-1", compact && "text-[10px] font-normal")}>
                <Phone className="w-3 h-3" />{assistant.phone_number}
              </Badge>
            ) : (
              <Badge variant="outline" className={cn("text-muted-foreground", compact && "text-[10px] font-normal")}>
                No number assigned yet
              </Badge>
            )}
            <Badge variant="outline" className={cn("gap-1", compact && "text-[10px] font-normal")}>
              <Sparkles className="w-3 h-3" />Voice: {assistant.voice.split(".").pop()}
            </Badge>
          </div>
          {assistant.greeting && (
            <p className={compact ? "text-xs" : "text-sm"}>
              <span className="text-muted-foreground">Greeting:</span> “{assistant.greeting}”
            </p>
          )}
          {assistant.collect_fields?.length > 0 && (
            <div>
              <p className={cn("text-muted-foreground mb-1.5", compact ? "text-xs" : "text-sm")}>Collecting from callers:</p>
              <div className="flex flex-wrap gap-1.5">
                {assistant.collect_fields.map((f) => (
                  <Badge key={f} variant="secondary" className={compact ? "text-[10px] font-normal" : undefined}>
                    {FIELD_LABELS[f] || f}
                  </Badge>
                ))}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Stats */}
      <div className={cn("grid grid-cols-3", compact ? "gap-2" : "gap-4")}>
        {[
          { label: "Calls handled", value: String(stats.calls), icon: PhoneIncoming },
          { label: "Avg. call length", value: fmtDur(stats.avg_duration_secs), icon: Clock },
          { label: "Total talk time", value: fmtDur(stats.total_duration_secs), icon: Clock },
        ].map((s) => (
          <Card key={s.label}>
            <CardContent className={cn("text-center", compact ? "p-2" : "pt-6")}>
              <s.icon className={cn("text-primary mx-auto", compact ? "w-3.5 h-3.5 mb-1" : "w-5 h-5 mb-2")} />
              <div className={cn("font-bold tabular-nums", compact ? "text-base" : "text-2xl")}>{s.value}</div>
              <div className={cn("text-muted-foreground leading-tight", compact ? "text-[10px]" : "text-xs")}>{s.label}</div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Collected data / conversations */}
      <Card>
        <CardHeader className={compact ? "p-3 pb-2" : undefined}>
          <CardTitle className={cn("flex items-center gap-2", compact ? "text-sm" : "text-lg")}>
            <ClipboardList className={cn("text-primary shrink-0", compact ? "w-4 h-4" : "w-5 h-5")} /> Calls & collected data
          </CardTitle>
        </CardHeader>
        <CardContent className={compact ? "p-3 pt-0" : undefined}>
          {conversations.length === 0 ? (
            <p className={cn("text-muted-foreground text-center", compact ? "text-xs py-4" : "text-sm py-8")}>
              No calls yet. When someone calls {assistant.phone_number || "the assistant's number"}, the AI answers and the details it collects appear here.
            </p>
          ) : (
            <div className={compact ? "space-y-2" : "space-y-3"}>
              {conversations.map((c) => (
                <div key={c.id} className={cn("rounded-lg border", compact ? "p-2.5" : "p-4")}>
                  {/* Caller and meta stack when narrow — side by side they wrap
                      into each other once a date and duration are both present. */}
                  <div
                    className={cn(
                      "mb-2",
                      compact ? "flex flex-col gap-0.5" : "flex items-center justify-between",
                    )}
                  >
                    <div className={cn("flex items-center gap-2 font-medium min-w-0", compact ? "text-xs" : "text-sm")}>
                      <PhoneIncoming className={cn("text-success shrink-0", compact ? "w-3.5 h-3.5" : "w-4 h-4")} />
                      <span className="truncate">{c.from || "Caller"}</span>
                    </div>
                    <div className={cn("text-muted-foreground flex items-center gap-3", compact ? "text-[10px]" : "text-xs")}>
                      {c.started_at && <span>{format(new Date(c.started_at), "MMM d, h:mm a")}</span>}
                      <span className="flex items-center gap-1"><Clock className="w-3 h-3" />{fmtDur(c.duration_secs)}</span>
                    </div>
                  </div>
                  {c.summary && (
                    <p className={cn("text-muted-foreground mb-2", compact ? "text-[11px] leading-snug" : "text-sm")}>
                      {c.summary}
                    </p>
                  )}
                  {Object.keys(c.collected).length > 0 && (
                    <div
                      className={cn(
                        "gap-x-4 gap-y-1",
                        compact ? "grid grid-cols-1 text-[11px]" : "grid grid-cols-2 text-sm",
                      )}
                    >
                      {Object.entries(c.collected).map(([k, v]) => (
                        <div key={k} className="flex gap-2 min-w-0">
                          <span className="text-muted-foreground shrink-0">{k}:</span>
                          <span className="font-medium truncate">{v}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {!readOnly && (
        <AvailabilityCalendar open={calendarOpen} onOpenChange={setCalendarOpen} userId={userId} />
      )}
    </div>
  );
};

export default AIAssistant;
