import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Copy, Loader2, Trash2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";

export interface DeskPhoneRow {
  id: string;
  user_id: string;
  phone_number_id: string | null;
  telnyx_connection_id: string;
  sip_username: string;
  sip_password: string | null;
  label: string | null;
  is_active: boolean;
  created_at: string;
}

interface DeskPhoneDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The assigned Telnyx number the desk phone will present as caller ID. */
  phone: { id: string; phone_number: string; assigned_to: string | null } | null;
  userName?: string;
}

/**
 * Admin dialog: provision a physical desk phone (Yealink etc.) for the user a
 * number is assigned to, and show the SIP details to type into the handset.
 * Each desk phone gets its own Telnyx connection (see admin-deskphone), so it
 * can never interfere with the user's web / desktop / mobile registrations.
 */
export const DeskPhoneDialog = ({ open, onOpenChange, phone, userName }: DeskPhoneDialogProps) => {
  const { toast } = useToast();
  const [rows, setRows] = useState<DeskPhoneRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [label, setLabel] = useState("");

  const token = typeof window !== "undefined" ? localStorage.getItem("admin_session_token") : null;

  const invoke = async (body: Record<string, unknown>) => {
    if (!token) throw new Error("Admin session not found");
    const { data, error } = await supabase.functions.invoke("admin-deskphone", {
      body,
      headers: { "x-admin-token": token },
    });
    if (error || !data?.success) throw new Error(data?.error || error?.message || "Request failed");
    return data;
  };

  const load = async () => {
    if (!phone?.assigned_to) return;
    setLoading(true);
    try {
      const data = await invoke({ action: "list", userId: phone.assigned_to });
      setRows((data.deskPhones as DeskPhoneRow[]).filter((r) => r.phone_number_id === phone.id || !r.phone_number_id));
    } catch (err: any) {
      toast({ title: "Error", description: err?.message, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (open) {
      setLabel("");
      load();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, phone?.id]);

  const create = async () => {
    if (!phone?.assigned_to) return;
    setCreating(true);
    try {
      await invoke({ action: "create", userId: phone.assigned_to, phoneId: phone.id, label: label || undefined });
      toast({ title: "Desk phone created", description: "Enter the SIP details below into the handset." });
      await load();
    } catch (err: any) {
      toast({ title: "Error", description: err?.message, variant: "destructive" });
    } finally {
      setCreating(false);
    }
  };

  const remove = async (id: string) => {
    try {
      await invoke({ action: "delete", id });
      toast({ title: "Desk phone removed" });
      await load();
    } catch (err: any) {
      toast({ title: "Error", description: err?.message, variant: "destructive" });
    }
  };

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast({ title: "Copied" });
    } catch {
      /* clipboard unavailable */
    }
  };

  const Field = ({ name, value }: { name: string; value: string }) => (
    <div className="flex items-center justify-between gap-2 rounded-md border px-3 py-1.5 text-sm">
      <span className="text-muted-foreground shrink-0">{name}</span>
      <span className="font-mono truncate">{value}</span>
      <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" onClick={() => copy(value)} title="Copy">
        <Copy className="w-3.5 h-3.5" />
      </Button>
    </div>
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Desk phone for {userName || "user"}</DialogTitle>
          <DialogDescription>
            A physical handset that rings together with the apps on {phone?.phone_number} and
            presents that number when calling out. Calls made on it appear in the user's call
            history marked "Desk phone".
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading…
          </div>
        ) : rows.length > 0 ? (
          <div className="space-y-4">
            {rows.map((r) => (
              <div key={r.id} className="space-y-2 rounded-lg border p-3">
                <div className="flex items-center justify-between">
                  <div className="font-medium">{r.label || "Desk phone"}</div>
                  <Button variant="ghost" size="sm" className="text-destructive" onClick={() => remove(r.id)}>
                    <Trash2 className="w-4 h-4 mr-1" /> Remove
                  </Button>
                </div>
                <Field name="SIP server" value="sip.telnyx.com" />
                <Field name="Port / transport" value="5060 UDP (or 5061 TLS)" />
                <Field name="Username" value={r.sip_username} />
                <Field name="Password" value={r.sip_password || "(not stored)"} />
                <p className="text-xs text-muted-foreground">
                  Yealink: Account → Register. Use the username for both Register Name and User Name,
                  leave Outbound Proxy disabled, Server Expires 180. If Telnyx says media encryption is
                  required, set Account → Advanced → RTP Encryption (SRTP) to Compulsory.
                </p>
              </div>
            ))}
          </div>
        ) : (
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="desk-label">Label (optional)</Label>
              <Input
                id="desk-label"
                placeholder="e.g. Reception Yealink T46"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
              />
            </div>
            <Button onClick={create} disabled={creating || !phone?.assigned_to} className="w-full">
              {creating ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
              Create desk phone
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
};
