import { useMemo } from "react";
import { format, startOfDay, subDays } from "date-fns";
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { Clock, Phone, PhoneIncoming, PhoneMissed, PhoneOutgoing, Timer } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";

export interface AnalyticsCall {
  direction: string;
  duration: number | null;
  status: string;
  created_at: string;
}

const MISSED = ["no-answer", "busy", "failed", "missed"];

export const isMissedCall = (c: AnalyticsCall) =>
  c.direction === "inbound" && (MISSED.includes(c.status) || (c.status === "ringing" && !c.duration));

const fmtTalk = (secs: number) => {
  const m = Math.round(secs / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
};

const fmtAvg = (secs: number) => {
  const s = Math.round(secs);
  return `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, "0")}`;
};

const chartConfig = {
  inbound: { label: "Inbound", color: "hsl(var(--primary))" },
  outbound: { label: "Outbound", color: "hsl(var(--success))" },
} satisfies ChartConfig;

interface CallAnalyticsProps {
  calls: AnalyticsCall[];
  /** Days shown in the activity chart. */
  days?: number;
  /** Copy shown in place of the chart when there are no calls at all. */
  emptyHint?: string;
}

/**
 * Stat tiles + a daily inbound/outbound chart for any set of calls. Used by
 * the Control dashboard for a single user and for an IVR number.
 */
export const CallAnalytics = ({ calls, days = 14, emptyHint = "No calls yet." }: CallAnalyticsProps) => {
  const stats = useMemo(() => {
    const total = calls.length;
    const inbound = calls.filter((c) => c.direction === "inbound").length;
    const outbound = total - inbound;
    const missed = calls.filter(isMissedCall).length;
    const answeredInbound = inbound - missed;
    const talkSecs = calls.reduce((sum, c) => sum + (c.duration || 0), 0);
    const connected = calls.filter((c) => (c.duration || 0) > 0);
    const avgSecs = connected.length ? talkSecs / connected.length : 0;
    const answerRate = inbound ? Math.round((answeredInbound / inbound) * 100) : null;
    return { total, inbound, outbound, missed, talkSecs, avgSecs, answerRate };
  }, [calls]);

  const series = useMemo(() => {
    const today = startOfDay(new Date());
    const buckets = Array.from({ length: days }, (_, i) => {
      const d = subDays(today, days - 1 - i);
      return { key: format(d, "yyyy-MM-dd"), label: format(d, "d MMM"), inbound: 0, outbound: 0 };
    });
    const byKey = new Map(buckets.map((b) => [b.key, b]));
    for (const c of calls) {
      const b = byKey.get(format(new Date(c.created_at), "yyyy-MM-dd"));
      if (!b) continue;
      if (c.direction === "outbound") b.outbound += 1;
      else b.inbound += 1;
    }
    return buckets;
  }, [calls, days]);

  const tiles = [
    { label: "Total calls", value: String(stats.total), icon: Phone, tone: "text-foreground" },
    { label: "Inbound", value: String(stats.inbound), icon: PhoneIncoming, tone: "text-primary" },
    { label: "Outbound", value: String(stats.outbound), icon: PhoneOutgoing, tone: "text-success" },
    {
      label: "Missed",
      value: stats.answerRate === null ? String(stats.missed) : `${stats.missed} · ${stats.answerRate}% answered`,
      icon: PhoneMissed,
      tone: stats.missed ? "text-destructive" : "text-muted-foreground",
    },
    { label: "Talk time", value: fmtTalk(stats.talkSecs), icon: Clock, tone: "text-foreground" },
    { label: "Avg. call", value: fmtAvg(stats.avgSecs), icon: Timer, tone: "text-foreground" },
  ];

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        {tiles.map((t) => (
          <Card key={t.label} className="shadow-none">
            <CardContent className="p-4">
              <div className="flex items-center justify-between text-muted-foreground">
                <span className="text-xs">{t.label}</span>
                <t.icon className={`h-4 w-4 ${t.tone}`} />
              </div>
              <div className="mt-2 text-xl font-semibold tabular-nums leading-tight">{t.value}</div>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card className="shadow-none">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium">Last {days} days</CardTitle>
        </CardHeader>
        <CardContent>
          {calls.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">{emptyHint}</p>
          ) : (
            <ChartContainer config={chartConfig} className="h-[220px] w-full">
              <BarChart data={series} margin={{ left: -20, right: 4 }}>
                <CartesianGrid vertical={false} strokeDasharray="3 3" />
                <XAxis dataKey="label" tickLine={false} axisLine={false} fontSize={11} interval="preserveStartEnd" />
                <YAxis allowDecimals={false} tickLine={false} axisLine={false} fontSize={11} />
                <ChartTooltip content={<ChartTooltipContent />} />
                <Bar dataKey="inbound" stackId="a" fill="var(--color-inbound)" radius={[0, 0, 4, 4]} />
                <Bar dataKey="outbound" stackId="a" fill="var(--color-outbound)" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ChartContainer>
          )}
        </CardContent>
      </Card>
    </div>
  );
};

export default CallAnalytics;
