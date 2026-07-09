import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Bot, Phone, PhoneIncoming, Clock, Sparkles, Loader2, ClipboardList, CalendarDays } from "lucide-react";
import { Button } from "@/components/ui/button";
import { format } from "date-fns";
import { AvailabilityCalendar } from "@/components/AvailabilityCalendar";

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

interface AIAssistantProps { userId?: string; }

export const AIAssistant = ({ userId }: AIAssistantProps) => {
  const [loading, setLoading] = useState(true);
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [assistant, setAssistant] = useState<AssistantSummary | null>(null);
  const [stats, setStats] = useState<Stats>({ calls: 0, avg_duration_secs: 0, total_duration_secs: 0 });
  const [conversations, setConversations] = useState<Conversation[]>([]);

  const load = async () => {
    try {
      const { data, error } = await supabase.functions.invoke("ai-assistant-stats", { body: {} });
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
  }, [userId]);

  if (loading) {
    return <div className="flex items-center justify-center h-64"><Loader2 className="w-8 h-8 animate-spin text-primary" /></div>;
  }

  if (!assistant) {
    return (
      <div className="max-w-2xl mx-auto p-6">
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-16 text-center">
            <div className="w-16 h-16 rounded-full bg-muted flex items-center justify-center mb-4">
              <Bot className="w-8 h-8 text-muted-foreground" />
            </div>
            <h3 className="text-xl font-display font-semibold mb-1">No AI assistant yet</h3>
            <p className="text-muted-foreground max-w-sm">
              You don't have an AI assistant assigned. Contact your administrator to get one set up.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto p-6 space-y-6">
      {/* Assistant header */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center justify-between">
            <span className="flex items-center gap-2">
              <Bot className="w-6 h-6 text-primary" />
              {assistant.name}
            </span>
            <div className="flex items-center gap-2">
              <Button size="sm" variant="outline" className="gap-1.5" onClick={() => setCalendarOpen(true)}>
                <CalendarDays className="w-4 h-4" /> Calendar
              </Button>
              <Badge variant={assistant.is_active ? "default" : "secondary"}>
                {assistant.is_active ? "Active" : "Inactive"}
              </Badge>
            </div>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {assistant.description && <p className="text-sm text-muted-foreground">{assistant.description}</p>}
          <div className="flex flex-wrap gap-2 text-sm">
            {assistant.phone_number ? (
              <Badge variant="outline" className="gap-1"><Phone className="w-3 h-3" />{assistant.phone_number}</Badge>
            ) : (
              <Badge variant="outline" className="text-muted-foreground">No number assigned yet</Badge>
            )}
            <Badge variant="outline" className="gap-1"><Sparkles className="w-3 h-3" />Voice: {assistant.voice.split(".").pop()}</Badge>
          </div>
          {assistant.greeting && (
            <p className="text-sm"><span className="text-muted-foreground">Greeting:</span> “{assistant.greeting}”</p>
          )}
          {assistant.collect_fields?.length > 0 && (
            <div>
              <p className="text-sm text-muted-foreground mb-1.5">Collecting from callers:</p>
              <div className="flex flex-wrap gap-1.5">
                {assistant.collect_fields.map((f) => (
                  <Badge key={f} variant="secondary">{FIELD_LABELS[f] || f}</Badge>
                ))}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-4">
        {[
          { label: "Calls handled", value: String(stats.calls), icon: PhoneIncoming },
          { label: "Avg. call length", value: fmtDur(stats.avg_duration_secs), icon: Clock },
          { label: "Total talk time", value: fmtDur(stats.total_duration_secs), icon: Clock },
        ].map((s) => (
          <Card key={s.label}>
            <CardContent className="pt-6 text-center">
              <s.icon className="w-5 h-5 text-primary mx-auto mb-2" />
              <div className="text-2xl font-bold">{s.value}</div>
              <div className="text-xs text-muted-foreground">{s.label}</div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Collected data / conversations */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <ClipboardList className="w-5 h-5 text-primary" /> Calls & collected data
          </CardTitle>
        </CardHeader>
        <CardContent>
          {conversations.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-8">
              No calls yet. When someone calls {assistant.phone_number || "the assistant's number"}, the AI answers and the details it collects appear here.
            </p>
          ) : (
            <div className="space-y-3">
              {conversations.map((c) => (
                <div key={c.id} className="rounded-lg border p-4">
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2 text-sm font-medium">
                      <PhoneIncoming className="w-4 h-4 text-success" />
                      {c.from || "Caller"}
                    </div>
                    <div className="text-xs text-muted-foreground flex items-center gap-3">
                      {c.started_at && <span>{format(new Date(c.started_at), "MMM d, h:mm a")}</span>}
                      <span className="flex items-center gap-1"><Clock className="w-3 h-3" />{fmtDur(c.duration_secs)}</span>
                    </div>
                  </div>
                  {c.summary && <p className="text-sm text-muted-foreground mb-2">{c.summary}</p>}
                  {Object.keys(c.collected).length > 0 && (
                    <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
                      {Object.entries(c.collected).map(([k, v]) => (
                        <div key={k} className="flex gap-2">
                          <span className="text-muted-foreground">{k}:</span>
                          <span className="font-medium">{v}</span>
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

      <AvailabilityCalendar open={calendarOpen} onOpenChange={setCalendarOpen} userId={userId} />
    </div>
  );
};

export default AIAssistant;
