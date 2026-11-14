import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Loader2, Check, Clock } from "lucide-react";

interface OpeningHoursProps { userId?: string; }

interface DayHours { open: boolean; start: string; end: string; }
type HoursMap = Record<string, DayHours>;

const DAYS: { key: string; label: string }[] = [
  { key: "mon", label: "Monday" },
  { key: "tue", label: "Tuesday" },
  { key: "wed", label: "Wednesday" },
  { key: "thu", label: "Thursday" },
  { key: "fri", label: "Friday" },
  { key: "sat", label: "Saturday" },
  { key: "sun", label: "Sunday" },
];

// A short, sensible list of timezones (extend as needed).
const TIMEZONES = [
  "Europe/London", "Europe/Dublin", "Europe/Paris", "Europe/Berlin", "Europe/Madrid",
  "America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles",
  "Asia/Dubai", "Asia/Karachi", "Asia/Kolkata", "Asia/Singapore", "Australia/Sydney",
];

const defaultHours = (): HoursMap => {
  const m: HoursMap = {};
  for (const d of DAYS) {
    const weekday = d.key !== "sat" && d.key !== "sun";
    m[d.key] = { open: weekday, start: "09:00", end: "17:00" };
  }
  return m;
};

const guessTz = () => {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return TIMEZONES.includes(tz) ? tz : "Europe/London";
  } catch { return "Europe/London"; }
};

export const OpeningHours = ({ userId }: OpeningHoursProps) => {
  const { toast } = useToast();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [timezone, setTimezone] = useState(guessTz());
  const [hours, setHours] = useState<HoursMap>(defaultHours());
  const [voicemailMessage, setVoicemailMessage] = useState(
    "Thank you for calling. We're currently closed. Please leave a message after the beep and we'll get back to you during our opening hours.",
  );

  useEffect(() => {
    const load = async () => {
      if (!userId) return;
      const { data } = await supabase
        .from("opening_hours")
        .select("*")
        .eq("user_id", userId)
        .maybeSingle();
      if (data) {
        setEnabled(data.enabled);
        setTimezone(data.timezone || guessTz());
        const h = (data.hours || {}) as unknown as HoursMap;
        // Merge stored hours over defaults so all 7 days exist.
        const merged = defaultHours();
        for (const d of DAYS) if (h[d.key]) merged[d.key] = { ...merged[d.key], ...h[d.key] };
        setHours(merged);
        if (data.voicemail_message) setVoicemailMessage(data.voicemail_message);
      }
      setLoading(false);
    };
    load();
  }, [userId]);

  const setDay = (key: string, patch: Partial<DayHours>) =>
    setHours((h) => ({ ...h, [key]: { ...h[key], ...patch } }));

  const save = async () => {
    if (!userId) return;
    setSaving(true);
    const { error } = await supabase.from("opening_hours").upsert({
      user_id: userId,
      enabled,
      timezone,
      hours: hours as any,
      voicemail_message: voicemailMessage.trim() || null,
    });
    setSaving(false);
    if (error) {
      toast({ title: "Error", description: error.message, variant: "destructive" });
      return;
    }
    toast({ title: "Opening hours saved" });
  };

  if (loading) {
    return <div className="flex items-center justify-center py-16"><Loader2 className="w-6 h-6 animate-spin text-primary" /></div>;
  }

  return (
    <div className="space-y-6">
      {/* Enable toggle */}
      <div className="flex items-center justify-between rounded-lg border p-4">
        <div>
          <div className="font-medium flex items-center gap-2"><Clock className="w-4 h-4 text-primary" /> Enable opening hours</div>
          <p className="text-sm text-muted-foreground">When on, calls outside your hours go straight to voicemail.</p>
        </div>
        <Switch checked={enabled} onCheckedChange={setEnabled} />
      </div>

      <div className={enabled ? "space-y-6" : "space-y-6 opacity-50 pointer-events-none"}>
        {/* Timezone */}
        <div className="space-y-2 max-w-xs">
          <Label>Timezone</Label>
          <Select value={timezone} onValueChange={setTimezone}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent className="max-h-72">
              {TIMEZONES.map((tz) => <SelectItem key={tz} value={tz}>{tz.replace("_", " ")}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>

        {/* Per-day hours */}
        <div className="space-y-2">
          <Label>Hours</Label>
          <div className="space-y-2">
            {DAYS.map((d) => {
              const day = hours[d.key];
              return (
                <div key={d.key} className="flex items-center gap-3 rounded-lg border p-3">
                  <div className="w-24 shrink-0 font-medium text-sm">{d.label}</div>
                  <Switch checked={day.open} onCheckedChange={(v) => setDay(d.key, { open: v })} />
                  {day.open ? (
                    <div className="flex items-center gap-2 text-sm">
                      <Input type="time" value={day.start} onChange={(e) => setDay(d.key, { start: e.target.value })} className="h-8 w-28" />
                      <span className="text-muted-foreground">to</span>
                      <Input type="time" value={day.end} onChange={(e) => setDay(d.key, { end: e.target.value })} className="h-8 w-28" />
                    </div>
                  ) : (
                    <span className="text-sm text-muted-foreground">Closed</span>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* Out-of-hours voicemail message */}
        <div className="space-y-2">
          <Label>Out-of-hours voicemail message</Label>
          <Textarea
            value={voicemailMessage}
            onChange={(e) => setVoicemailMessage(e.target.value)}
            placeholder="What callers hear when they call outside your opening hours."
            className="min-h-[90px]"
          />
          <p className="text-xs text-muted-foreground">Callers hear this, then can leave a voicemail.</p>
        </div>
      </div>

      <div className="flex justify-end">
        <Button onClick={save} disabled={saving} className="gap-1.5">
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
          Save
        </Button>
      </div>
    </div>
  );
};
