import { useEffect, useState } from "react";
import { Headset, Loader2 } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";

interface DeskPhoneRow {
  id: string;
  label: string | null;
  auto_record: boolean;
  is_active: boolean;
}

interface DeskPhoneSettingsProps {
  userId?: string;
}

/**
 * Settings → Desk phone. Shown only to users who have a physical handset
 * provisioned (desk_phones row). The handset has no Record button, so the one
 * control here is "record every call on this desk phone": when on, the
 * call-events webhook starts a dual-channel recording the moment a handset
 * call is answered, inbound or outbound, and it lands in Recordings like any
 * other call. RLS lets the owner update only the auto_record column.
 */
export const DeskPhoneSettings = ({ userId }: DeskPhoneSettingsProps) => {
  const { toast } = useToast();
  const [rows, setRows] = useState<DeskPhoneRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);

  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase
        .from("desk_phones")
        .select("id,label,auto_record,is_active")
        .eq("user_id", userId)
        .eq("is_active", true)
        .order("created_at", { ascending: true });
      if (cancelled) return;
      if (error) console.error("desk_phones load error:", error);
      setRows((data as DeskPhoneRow[]) ?? []);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [userId]);

  const toggle = async (row: DeskPhoneRow, next: boolean) => {
    setSaving(row.id);
    const prev = rows;
    setRows((rs) => rs.map((r) => (r.id === row.id ? { ...r, auto_record: next } : r)));
    const { error } = await supabase.from("desk_phones").update({ auto_record: next }).eq("id", row.id);
    setSaving(null);
    if (error) {
      setRows(prev);
      toast({ title: "Couldn't save", description: error.message, variant: "destructive" });
      return;
    }
    toast({
      title: next ? "Desk phone recording on" : "Desk phone recording off",
      description: next
        ? "Every call on this handset will be recorded from now on."
        : "Calls on this handset are no longer recorded.",
    });
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="w-4 h-4 animate-spin" /> Loading…
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No desk phone is set up for your number. Ask your admin to add one.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      {rows.map((row) => (
        <div key={row.id} className="flex items-start justify-between gap-4 rounded-lg border p-4">
          <div className="flex items-start gap-3 min-w-0">
            <div className="mt-0.5 rounded-md bg-primary/10 p-2 text-primary">
              <Headset className="w-4 h-4" />
            </div>
            <div className="min-w-0">
              <div className="font-medium">{row.label || "Desk phone"}</div>
              <Label htmlFor={`rec-${row.id}`} className="font-normal text-sm text-muted-foreground">
                Record every call on this desk phone. Recordings appear in your Recordings tab and
                can be summarised like any other call. The handset itself has no record button.
              </Label>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {saving === row.id && <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />}
            <Switch
              id={`rec-${row.id}`}
              checked={row.auto_record}
              disabled={saving === row.id}
              onCheckedChange={(v) => toggle(row, v)}
            />
          </div>
        </div>
      ))}
      <p className="text-xs text-muted-foreground">
        Make sure callers are told calls may be recorded, in line with how you handle app recordings.
      </p>
    </div>
  );
};
