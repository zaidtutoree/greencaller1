import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { CheckCircle2, Copy, Loader2, MessageCircle, Power, RefreshCw, Trash2, Wrench, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";

interface Readiness {
  ready: boolean;
  telnyx_key: boolean;
  app_id: string | null;
  app_linked: boolean;
  solution_id: string | null;
  messaging_profile_id: string | null;
  signup_webhook_set: boolean;
  webhook_url: string;
  errors: string[];
}
interface UserOpt { id: string; full_name: string | null; email: string | null; company_name: string | null; account_type: string; }
interface NumberRow { phone_number: string; assigned_to: string | null; provider: string; is_active: boolean | null; }
interface Account {
  user_id: string;
  enabled: boolean;
  phone_number: string | null;
  status: "not_connected" | "connecting" | "connected" | "failed";
  connected_phone_number: string | null;
  waba_id: string | null;
  display_name: string | null;
  signup_state: string | null;
  last_error: string | null;
  connected_at: string | null;
  profiles?: { id: string; full_name: string | null; email: string | null; company_name: string | null; account_type: string } | null;
}

const STATUS_STYLE: Record<Account["status"], string> = {
  not_connected: "bg-muted text-muted-foreground",
  connecting: "bg-amber-100 text-amber-800",
  connected: "bg-emerald-100 text-emerald-800",
  failed: "bg-destructive/10 text-destructive",
};

export const WhatsAppAdmin = () => {
  const { toast } = useToast();
  const [readiness, setReadiness] = useState<Readiness | null>(null);
  const [checking, setChecking] = useState(false);
  const [settingUp, setSettingUp] = useState(false);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [users, setUsers] = useState<UserOpt[]>([]);
  const [numbers, setNumbers] = useState<NumberRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyUser, setBusyUser] = useState<string | null>(null);
  const [selUser, setSelUser] = useState("");
  const [selNumber, setSelNumber] = useState("");
  const [customNumber, setCustomNumber] = useState("");
  const [confirmRemove, setConfirmRemove] = useState<Account | null>(null);

  const token = () => localStorage.getItem("admin_session_token") || "";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const call = useCallback(async (body: Record<string, unknown>): Promise<any> => {
    const { data, error } = await supabase.functions.invoke("admin-whatsapp", { body, headers: { "x-admin-token": token() } });
    if (error) {
      let msg = error.message;
      try { const j = await (error as { context?: Response }).context?.json(); if (j?.error) msg = j.error; } catch { /* ignore */ }
      throw new Error(msg);
    }
    if (data?.error) throw new Error(data.error);
    return data;
  }, []);

  const load = useCallback(async () => {
    try {
      const d = await call({ action: "list" });
      setAccounts(d.accounts || []);
      setUsers(d.users || []);
      setNumbers(d.numbers || []);
    } catch (e: unknown) {
      toast({ title: "Could not load WhatsApp accounts", description: (e as Error).message, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [call, toast]);

  const check = useCallback(async (setup = false) => {
    if (setup) setSettingUp(true);
    else setChecking(true);
    try {
      setReadiness(await call({ action: setup ? "setup" : "readiness" }));
      if (setup) toast({ title: "Setup finished", description: "Messaging profile and signup webhook configured at Telnyx." });
    } catch (e: unknown) {
      toast({ title: setup ? "Setup failed" : "Readiness check failed", description: (e as Error).message, variant: "destructive" });
    } finally {
      setChecking(false);
      setSettingUp(false);
    }
  }, [call, toast]);

  useEffect(() => { load(); check(); }, [load, check]);

  const userNumbers = useMemo(
    () => numbers.filter((n) => n.assigned_to === selUser && n.is_active !== false),
    [numbers, selUser],
  );
  useEffect(() => { setSelNumber(userNumbers[0]?.phone_number || ""); setCustomNumber(""); }, [selUser, userNumbers]);

  const enable = async () => {
    const phone = (selNumber === "__custom" ? customNumber : selNumber).trim();
    if (!selUser || !phone) return;
    setBusyUser(selUser);
    try {
      const d = await call({ action: "enable", userId: selUser, phoneNumber: phone });
      toast({
        title: "WhatsApp enabled",
        description: d.warnings?.length ? d.warnings.join(" ") : "The user now has a WhatsApp tab and can connect their number.",
      });
      setSelUser("");
      await load();
    } catch (e: unknown) {
      toast({ title: "Could not enable", description: (e as Error).message, variant: "destructive" });
    } finally {
      setBusyUser(null);
    }
  };

  const toggle = async (a: Account) => {
    setBusyUser(a.user_id);
    try {
      if (a.enabled) await call({ action: "disable", userId: a.user_id });
      else await call({ action: "enable", userId: a.user_id, phoneNumber: a.phone_number });
      await load();
    } catch (e: unknown) {
      toast({ title: "Update failed", description: (e as Error).message, variant: "destructive" });
    } finally {
      setBusyUser(null);
    }
  };

  const remove = async (a: Account) => {
    setBusyUser(a.user_id);
    try {
      await call({ action: "remove", userId: a.user_id });
      toast({ title: "Removed", description: "WhatsApp access removed. The number stays registered at Meta until deregistered in the Telnyx portal." });
      await load();
    } catch (e: unknown) {
      toast({ title: "Remove failed", description: (e as Error).message, variant: "destructive" });
    } finally {
      setBusyUser(null);
    }
  };

  const Check = ({ ok, label, detail }: { ok: boolean; label: string; detail?: string | null }) => (
    <div className="flex items-start gap-2 text-sm">
      {ok ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" /> : <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />}
      <div>
        <div className={cn(!ok && "text-destructive")}>{label}</div>
        {detail && <div className="break-all font-mono text-xs text-muted-foreground">{detail}</div>}
      </div>
    </div>
  );

  const grantable = users.filter((u) => !accounts.some((a) => a.user_id === u.id));

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-emerald-100">
          <MessageCircle className="h-5 w-5 text-emerald-700" />
        </div>
        <div>
          <h1 className="text-2xl font-semibold">WhatsApp Business</h1>
          <p className="text-sm text-muted-foreground">Grant users a WhatsApp tab on one of their Telnyx numbers. They connect it themselves through Meta.</p>
        </div>
      </div>

      {/* Readiness */}
      <Card>
        <CardContent className="p-5">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="font-semibold">Telnyx / Meta readiness</h2>
              <p className="text-xs text-muted-foreground">Everything below must be green before users can connect.</p>
            </div>
            <div className="flex gap-2">
              <Button size="sm" variant="outline" onClick={() => check(false)} disabled={checking}>
                {checking ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-1.5 h-4 w-4" />} Re-check
              </Button>
              <Button size="sm" onClick={() => check(true)} disabled={settingUp || !readiness?.telnyx_key}>
                {settingUp ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Wrench className="mr-1.5 h-4 w-4" />} Run setup
              </Button>
            </div>
          </div>
          {!readiness ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Checking…</div>
          ) : (
            <div className="grid gap-3 md:grid-cols-2">
              <Check ok={readiness.telnyx_key} label="TELNYX_API_KEY secret set" />
              <Check ok={!!readiness.app_id} label="TELNYX_WHATSAPP_APP_ID secret set (Meta Tech Provider app)" detail={readiness.app_id} />
              <Check ok={readiness.app_linked} label="Meta app linked to this Telnyx account" detail={readiness.solution_id ? `solution_id ${readiness.solution_id}` : null} />
              <Check ok={!!readiness.messaging_profile_id} label="Shared messaging profile (inbound webhook)" detail={readiness.messaging_profile_id} />
              <Check ok={readiness.signup_webhook_set} label="Signup completion webhook registered" />
              <div className="flex items-start gap-2 text-sm">
                <Copy className="mt-0.5 h-4 w-4 shrink-0 cursor-pointer text-muted-foreground" onClick={() => navigator.clipboard.writeText(readiness.webhook_url)} />
                <div>
                  <div>Webhook URL</div>
                  <div className="break-all font-mono text-xs text-muted-foreground">{readiness.webhook_url}</div>
                </div>
              </div>
              {readiness.errors.length > 0 && (
                <ul className="md:col-span-2 list-disc space-y-1 rounded-md bg-destructive/5 p-3 pl-7 text-xs text-destructive">
                  {readiness.errors.map((e, i) => <li key={i}>{e}</li>)}
                </ul>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Grant */}
      <Card>
        <CardContent className="p-5">
          <h2 className="mb-3 font-semibold">Give a user WhatsApp</h2>
          <div className="grid gap-3 md:grid-cols-[1fr_1fr_auto]">
            <div className="space-y-1.5">
              <Label>User</Label>
              <Select value={selUser} onValueChange={setSelUser}>
                <SelectTrigger><SelectValue placeholder="Choose a user" /></SelectTrigger>
                <SelectContent>
                  {grantable.map((u) => (
                    <SelectItem key={u.id} value={u.id}>
                      {u.full_name || u.email} <span className="text-muted-foreground">· {u.company_name || u.account_type}</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Telnyx number to use for WhatsApp</Label>
              <Select value={selNumber} onValueChange={setSelNumber} disabled={!selUser}>
                <SelectTrigger><SelectValue placeholder={selUser ? "Choose a number" : "Pick a user first"} /></SelectTrigger>
                <SelectContent>
                  {userNumbers.map((n) => <SelectItem key={n.phone_number} value={n.phone_number}>{n.phone_number} <span className="text-muted-foreground">· {n.provider}</span></SelectItem>)}
                  <SelectItem value="__custom">Other number…</SelectItem>
                </SelectContent>
              </Select>
              {selNumber === "__custom" && (
                <Input value={customNumber} onChange={(e) => setCustomNumber(e.target.value)} placeholder="+447700900123" />
              )}
            </div>
            <div className="flex items-end">
              <Button onClick={enable} disabled={!selUser || !(selNumber === "__custom" ? customNumber : selNumber) || busyUser === selUser}>
                {busyUser === selUser ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <MessageCircle className="mr-1.5 h-4 w-4" />} Enable
              </Button>
            </div>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            The number must not already be on a personal WhatsApp or WhatsApp Business app. The user will enter this exact number in Meta&apos;s signup window.
          </p>
        </CardContent>
      </Card>

      {/* Accounts */}
      <Card>
        <CardContent className="p-0">
          <div className="flex items-center justify-between border-b px-5 py-3">
            <h2 className="font-semibold">WhatsApp accounts</h2>
            <Button size="sm" variant="ghost" onClick={load}><RefreshCw className="h-4 w-4" /></Button>
          </div>
          {loading ? (
            <div className="flex justify-center py-10"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
          ) : accounts.length === 0 ? (
            <p className="px-5 py-10 text-center text-sm text-muted-foreground">No users have WhatsApp yet.</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-left text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="px-5 py-2 font-medium">User</th>
                  <th className="px-3 py-2 font-medium">Number</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                  <th className="px-3 py-2 font-medium">Details</th>
                  <th className="px-3 py-2 text-right font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {accounts.map((a) => (
                  <tr key={a.user_id} className={cn("border-t", !a.enabled && "opacity-60")}>
                    <td className="px-5 py-3">
                      <div className="font-medium">{a.profiles?.full_name || a.profiles?.email || a.user_id}</div>
                      <div className="text-xs text-muted-foreground">{a.profiles?.email}{a.profiles?.company_name ? ` · ${a.profiles.company_name}` : ""}</div>
                    </td>
                    <td className="px-3 py-3 font-mono text-xs">{a.phone_number}</td>
                    <td className="px-3 py-3">
                      <Badge className={cn("font-normal", STATUS_STYLE[a.status])} variant="secondary">
                        {a.enabled ? a.status.replace("_", " ") : "disabled"}
                      </Badge>
                    </td>
                    <td className="max-w-xs px-3 py-3 text-xs text-muted-foreground">
                      {a.status === "connected" && <div>{a.display_name ? `${a.display_name} · ` : ""}WABA {a.waba_id}</div>}
                      {a.status === "connecting" && <div>Step: {a.signup_state || "waiting for Meta"}</div>}
                      {a.last_error && <div className="text-destructive">{a.last_error}</div>}
                    </td>
                    <td className="px-3 py-3 text-right">
                      <Button size="sm" variant="ghost" onClick={() => toggle(a)} disabled={busyUser === a.user_id} title={a.enabled ? "Disable (hide tab)" : "Enable"}>
                        {busyUser === a.user_id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Power className={cn("h-4 w-4", a.enabled ? "text-emerald-600" : "text-muted-foreground")} />}
                      </Button>
                      <Button size="sm" variant="ghost" className="text-destructive hover:text-destructive" onClick={() => setConfirmRemove(a)} disabled={busyUser === a.user_id}>
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      <AlertDialog open={!!confirmRemove} onOpenChange={(o) => !o && setConfirmRemove(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove WhatsApp access?</AlertDialogTitle>
            <AlertDialogDescription>
              {confirmRemove?.profiles?.full_name || confirmRemove?.profiles?.email} will lose the WhatsApp tab and their connection record here.
              Their conversations stay in the database. The number is not deregistered from Meta.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90" onClick={() => { if (confirmRemove) remove(confirmRemove); setConfirmRemove(null); }}>
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};
