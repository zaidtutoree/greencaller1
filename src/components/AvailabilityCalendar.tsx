import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Loader2, CalendarDays, ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

interface Slot { id: string; slot_date: string; slot_time: string; }
interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  userId?: string;
}

const toYMD = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

// 08:00 → 19:30 in 30-minute slots.
const TIMES: string[] = [];
for (let h = 8; h < 20; h++) {
  TIMES.push(`${String(h).padStart(2, "0")}:00`, `${String(h).padStart(2, "0")}:30`);
}

const to12h = (t: string) => {
  const [h, m] = t.split(":").map(Number);
  const ap = h < 12 ? "AM" : "PM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, "0")} ${ap}`;
};

export const AvailabilityCalendar = ({ open, onOpenChange, userId }: Props) => {
  const { toast } = useToast();
  const [slots, setSlots] = useState<Slot[]>([]);
  const [loading, setLoading] = useState(true);
  const [weekOffset, setWeekOffset] = useState(0); // in 7-day pages
  const [selectedDate, setSelectedDate] = useState(toYMD(new Date()));
  const [busy, setBusy] = useState<string | null>(null); // "date|time" being toggled

  const fetchSlots = async () => {
    if (!userId) return;
    const { data } = await supabase
      .from("ai_booked_slots")
      .select("id, slot_date, slot_time")
      .eq("user_id", userId);
    setSlots(data || []);
    setLoading(false);
  };

  useEffect(() => {
    if (open) { setLoading(true); fetchSlots(); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, userId]);

  // Map "date|time" → slot id for quick lookup.
  const bookedMap = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of slots) m.set(`${s.slot_date}|${s.slot_time}`, s.id);
    return m;
  }, [slots]);

  // The 7 days shown in the strip (paged by weekOffset).
  const days = useMemo(() => {
    const base = new Date();
    base.setHours(0, 0, 0, 0);
    return Array.from({ length: 7 }, (_, i) => {
      const d = new Date(base);
      d.setDate(base.getDate() + weekOffset * 7 + i);
      return d;
    });
  }, [weekOffset]);

  const bookedCountForDate = (ymd: string) => slots.filter((s) => s.slot_date === ymd).length;

  const toggle = async (time: string) => {
    if (!userId) return;
    const key = `${selectedDate}|${time}`;
    setBusy(key);
    try {
      const existingId = bookedMap.get(key);
      const { data, error } = await supabase.functions.invoke("ai-availability", {
        body: existingId
          ? { action: "remove", id: existingId }
          : { action: "add", slot_date: selectedDate, slot_time: time },
      });
      if (error) throw error;
      if (data?.error) throw new Error(data.error);
      await fetchSlots();
    } catch (e: any) {
      toast({ title: "Error", description: e.message || "Failed to update slot", variant: "destructive" });
    } finally {
      setBusy(null);
    }
  };

  const selectedLabel = useMemo(() => {
    const d = new Date(selectedDate + "T12:00:00");
    return new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long" }).format(d);
  }, [selectedDate]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <CalendarDays className="w-5 h-5 text-primary" /> Availability calendar
          </DialogTitle>
        </DialogHeader>

        <p className="text-sm text-muted-foreground -mt-1">
          Tap a time to mark it <span className="font-medium text-foreground">booked</span>. Your AI assistant won't offer booked times to callers.
        </p>

        {loading ? (
          <div className="flex items-center justify-center py-16"><Loader2 className="w-6 h-6 animate-spin text-primary" /></div>
        ) : (
          <>
            {/* Week strip */}
            <div className="flex items-center gap-1">
              <Button variant="ghost" size="icon" className="h-9 w-9 shrink-0" onClick={() => setWeekOffset((w) => w - 1)} disabled={weekOffset <= 0} title="Previous week">
                <ChevronLeft className="w-4 h-4" />
              </Button>
              <div className="grid grid-cols-7 gap-1 flex-1">
                {days.map((d) => {
                  const ymd = toYMD(d);
                  const isSel = ymd === selectedDate;
                  const count = bookedCountForDate(ymd);
                  return (
                    <button
                      key={ymd}
                      onClick={() => setSelectedDate(ymd)}
                      className={cn(
                        "flex flex-col items-center rounded-lg py-1.5 text-xs transition-colors relative",
                        isSel ? "bg-primary text-primary-foreground" : "hover:bg-muted",
                      )}
                    >
                      <span className="opacity-70">{new Intl.DateTimeFormat("en-GB", { weekday: "short" }).format(d)}</span>
                      <span className="text-sm font-semibold">{d.getDate()}</span>
                      {count > 0 && (
                        <span className={cn("absolute -top-1 -right-0.5 w-4 h-4 rounded-full text-[9px] flex items-center justify-center font-bold",
                          isSel ? "bg-primary-foreground text-primary" : "bg-primary text-primary-foreground")}>
                          {count}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
              <Button variant="ghost" size="icon" className="h-9 w-9 shrink-0" onClick={() => setWeekOffset((w) => w + 1)} title="Next week">
                <ChevronRight className="w-4 h-4" />
              </Button>
            </div>

            {/* Selected day */}
            <div className="flex items-center justify-between">
              <span className="font-medium">{selectedLabel}</span>
              <span className="text-xs text-muted-foreground">{bookedCountForDate(selectedDate)} booked</span>
            </div>

            {/* Time grid */}
            <div className="grid grid-cols-3 gap-2 max-h-64 overflow-y-auto pr-1">
              {TIMES.map((t) => {
                const key = `${selectedDate}|${t}`;
                const isBooked = bookedMap.has(key);
                const isBusy = busy === key;
                return (
                  <button
                    key={t}
                    onClick={() => toggle(t)}
                    disabled={isBusy}
                    className={cn(
                      "flex items-center justify-center gap-1 rounded-lg border py-2 text-sm transition-colors",
                      isBooked
                        ? "border-destructive/40 bg-destructive/10 text-destructive font-medium"
                        : "border-border hover:border-primary/50 hover:bg-muted/50",
                    )}
                  >
                    {isBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : to12h(t)}
                  </button>
                );
              })}
            </div>

            {/* Legend */}
            <div className="flex items-center gap-4 text-xs text-muted-foreground">
              <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded border border-destructive/40 bg-destructive/10" /> Booked</span>
              <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded border" /> Available</span>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
};
