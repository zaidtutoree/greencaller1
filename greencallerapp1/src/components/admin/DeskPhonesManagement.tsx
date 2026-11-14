import { useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Headset, Copy, Loader2, Trash2, CheckCircle2, ChevronRight, RefreshCw, Mic } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import type { DeskPhoneRow } from "@/components/admin/DeskPhoneDialog";

interface Profile {
  id: string;
  full_name: string | null;
  email: string;
  company_name: string | null;
}

interface PhoneNumber {
  id: string;
  phone_number: string;
  assigned_to: string | null;
  provider: string;
}

/**
 * Admin → Desk Phones.
 *
 * One place to put a physical handset (Yealink etc.) on a user's number:
 * pick the number, click Create, and the admin-deskphone function does the
 * whole Telnyx side (dedicated connection with webhook, caller-ID override,
 * SIP-URI calling, on-demand credential). What's left is typing the
 * credential into the handset, so the page then walks the admin through the
 * exact Yealink screens, the two settings that silently break it, and a test
 * plan. Existing handsets are listed with their credentials and can be removed.
 */
const DeskPhonesManagement = () => {
  const { toast } = useToast();
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [numbers, setNumbers] = useState<PhoneNumber[]>([]);
  const [deskPhones, setDeskPhones] = useState<DeskPhoneRow[]>([]);
  const [loading, setLoading] = useState(true);

  const [selectedPhoneId, setSelectedPhoneId] = useState("");
  const [label, setLabel] = useState("");
  const [creating, setCreating] = useState(false);
  /** The handset whose setup guide is open (just created, or chosen from the list). */
  const [guideFor, setGuideFor] = useState<DeskPhoneRow | null>(null);
  const [removeTarget, setRemoveTarget] = useState<DeskPhoneRow | null>(null);

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

  const loadAll = async () => {
    setLoading(true);
    try {
      const [{ data: p }, { data: n }, dp] = await Promise.all([
        supabase.from("profiles").select("id, full_name, email, company_name"),
        supabase.from("phone_numbers").select("id, phone_number, assigned_to, provider"),
        invoke({ action: "list" }),
      ]);
      setProfiles((p as Profile[]) || []);
      setNumbers((n as PhoneNumber[]) || []);
      setDeskPhones((dp.deskPhones as DeskPhoneRow[]) || []);
    } catch (err: any) {
      toast({ title: "Error", description: err?.message, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const profileById = useMemo(() => new Map(profiles.map((p) => [p.id, p])), [profiles]);
  const numberById = useMemo(() => new Map(numbers.map((n) => [n.id, n])), [numbers]);
  const userName = (id: string | null) => {
    const p = id ? profileById.get(id) : undefined;
    return p?.full_name || p?.email || "Unknown user";
  };

  // Only Telnyx numbers that are assigned to a person can carry a desk phone.
  const eligibleNumbers = numbers.filter((n) => n.provider === "telnyx" && n.assigned_to);
  const alreadyHas = (phoneId: string) => deskPhones.some((d) => d.phone_number_id === phoneId && d.is_active);

  const create = async () => {
    const phone = numberById.get(selectedPhoneId);
    if (!phone?.assigned_to) return;
    setCreating(true);
    try {
      const data = await invoke({
        action: "create",
        userId: phone.assigned_to,
        phoneId: phone.id,
        label: label || undefined,
      });
      toast({ title: "Desk phone created", description: "Telnyx is configured. Follow the setup steps below." });
      setSelectedPhoneId("");
      setLabel("");
      await loadAll();
      setGuideFor(data.deskPhone as DeskPhoneRow);
    } catch (err: any) {
      toast({ title: "Couldn't create desk phone", description: err?.message, variant: "destructive" });
    } finally {
      setCreating(false);
    }
  };

  const remove = async () => {
    if (!removeTarget) return;
    try {
      await invoke({ action: "delete", id: removeTarget.id });
      toast({ title: "Desk phone removed", description: "The Telnyx connection was deleted too." });
      if (guideFor?.id === removeTarget.id) setGuideFor(null);
      await loadAll();
    } catch (err: any) {
      toast({ title: "Error", description: err?.message, variant: "destructive" });
    } finally {
      setRemoveTarget(null);
    }
  };

  const copy = async (text: string, what = "Copied") => {
    try {
      await navigator.clipboard.writeText(text);
      toast({ title: what });
    } catch {
      /* clipboard unavailable */
    }
  };

  const guideNumber = guideFor?.phone_number_id ? numberById.get(guideFor.phone_number_id) : undefined;
  const guideUser = guideFor ? userName(guideFor.user_id) : "";

  const allSettingsText = guideFor
    ? [
        `GreenCaller desk phone — ${guideFor.label || "Desk phone"} (${guideUser}, ${guideNumber?.phone_number ?? ""})`,
        "",
        "Account → Register",
        "  Line Active: Enabled",
        `  Label / Display Name: ${guideUser}`,
        `  Register Name: ${guideFor.sip_username}`,
        `  User Name: ${guideFor.sip_username}`,
        `  Password: ${guideFor.sip_password ?? ""}`,
        "  SIP Server 1 → Server Host: sip.telnyx.com   Port: 5060",
        "  Transport: UDP",
        "  Server Expires: 180",
        "  Enable Outbound Proxy Server: Disabled",
        "",
        "Account → Advanced",
        "  RTP Encryption (SRTP): Disabled",
      ].join("\n")
    : "";

  const Field = ({ name, value, mono = true }: { name: string; value: string; mono?: boolean }) => (
    <div className="flex items-center justify-between gap-3 rounded-md border bg-card px-3 py-2 text-sm">
      <span className="text-muted-foreground shrink-0 w-56">{name}</span>
      <span className={`${mono ? "font-mono" : ""} truncate flex-1 text-right`}>{value}</span>
      <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" onClick={() => copy(value)} title="Copy">
        <Copy className="w-3.5 h-3.5" />
      </Button>
    </div>
  );

  const Step = ({ n, title, children }: { n: number; title: string; children: React.ReactNode }) => (
    <div className="flex gap-4">
      <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary text-sm font-semibold">
        {n}
      </div>
      <div className="min-w-0 flex-1 space-y-2">
        <h4 className="font-medium leading-7">{title}</h4>
        {children}
      </div>
    </div>
  );

  return (
    <div className="space-y-6">
      {/* ── Create ─────────────────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Headset className="w-5 h-5 text-primary" />
            Set up a desk phone
          </CardTitle>
          <CardDescription>
            Choose the number the handset should ring on. GreenCaller creates a dedicated Telnyx
            connection for it (webhook, caller ID, SIP routing and a login for the phone) so it
            rings together with the user's apps and never interferes with them.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 md:grid-cols-[1fr_1fr_auto] md:items-end">
            <div className="space-y-1.5">
              <Label>Number (Telnyx, assigned to a user)</Label>
              <Select value={selectedPhoneId} onValueChange={setSelectedPhoneId}>
                <SelectTrigger>
                  <SelectValue placeholder={eligibleNumbers.length ? "Select a number" : "No eligible numbers"} />
                </SelectTrigger>
                <SelectContent>
                  {eligibleNumbers.map((n) => (
                    <SelectItem key={n.id} value={n.id} disabled={alreadyHas(n.id)}>
                      {n.phone_number} — {userName(n.assigned_to)}
                      {alreadyHas(n.id) ? " (has a desk phone)" : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="desk-label">Label (optional)</Label>
              <Input
                id="desk-label"
                placeholder="e.g. Reception Yealink T73W"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
              />
            </div>
            <Button onClick={create} disabled={!selectedPhoneId || creating} className="gap-2">
              {creating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Headset className="w-4 h-4" />}
              Create desk phone
            </Button>
          </div>
          <p className="mt-3 text-xs text-muted-foreground">
            Only Telnyx numbers assigned to a person are listed. Department numbers and unassigned
            numbers can't have a desk phone.
          </p>
        </CardContent>
      </Card>

      {/* ── Setup guide ────────────────────────────────────────────────── */}
      {guideFor && (
        <Card className="border-primary/30">
          <CardHeader>
            <div className="flex items-start justify-between gap-4">
              <div>
                <CardTitle className="flex items-center gap-2">
                  <CheckCircle2 className="w-5 h-5 text-success" />
                  Telnyx is ready. Now set up the handset.
                </CardTitle>
                <CardDescription className="mt-1">
                  {guideFor.label || "Desk phone"} for <strong>{guideUser}</strong> on{" "}
                  <strong>{guideNumber?.phone_number}</strong>. Everything on the Telnyx side is done;
                  the steps below are what you type into the phone.
                </CardDescription>
              </div>
              <div className="flex gap-2 shrink-0">
                <Button variant="outline" size="sm" className="gap-1.5" onClick={() => copy(allSettingsText, "All settings copied")}>
                  <Copy className="w-4 h-4" /> Copy all settings
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setGuideFor(null)}>
                  Close
                </Button>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-6">
            <Step n={1} title="Open the phone's web page">
              <p className="text-sm text-muted-foreground">
                On the handset press <strong>OK</strong> (or Menu → Status) and read the IPv4 address. On a
                computer on the same network open <span className="font-mono">http://&lt;that address&gt;</span>{" "}
                (some models need <span className="font-mono">https://</span>). Default login is{" "}
                <span className="font-mono">admin</span> / <span className="font-mono">admin</span>; newer
                firmware prints a per-phone password on the label underneath.
              </p>
            </Step>

            <Step n={2} title="Account → Register (Account 1) — enter exactly these">
              <div className="space-y-1.5">
                <Field name="Line Active" value="Enabled" mono={false} />
                <Field name="Label / Display Name" value={guideUser} mono={false} />
                <Field name="Register Name" value={guideFor.sip_username} />
                <Field name="User Name" value={guideFor.sip_username} />
                <Field name="Password" value={guideFor.sip_password || "(not stored)"} />
                <Field name="SIP Server 1 → Server Host" value="sip.telnyx.com" />
                <Field name="SIP Server 1 → Port" value="5060" />
                <Field name="Transport" value="UDP" mono={false} />
                <Field name="Server Expires" value="180" />
                <Field name="Enable Outbound Proxy Server" value="Disabled" mono={false} />
              </div>
              <p className="text-sm text-muted-foreground">
                Paste the username into <em>both</em> name fields; it is 48 characters and one typo gives
                "Register Failed". Click <strong>Confirm</strong> and wait about 30 seconds for the status to
                read <strong>Registered</strong>.
              </p>
              <div className="rounded-md border border-warning/40 bg-warning/5 p-3 text-sm">
                <strong>Outbound Proxy must stay Disabled.</strong> With it enabled the phone sends no
                registration at all, with no error shown. TLS on port 5061 also failed to register on the
                firmware we tested; UDP 5060 works.
              </div>
            </Step>

            <Step n={3} title="Account → Advanced (Account 1)">
              <div className="space-y-1.5">
                <Field name="RTP Encryption (SRTP)" value="Disabled" mono={false} />
              </div>
              <p className="text-sm text-muted-foreground">
                Confirm. If this is left on, outbound calls fail with "Not Acceptable Here" because the
                phone offers encrypted audio the connection does not use.
              </p>
            </Step>

            <Step n={4} title="Test">
              <ol className="list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
                <li>
                  Call <strong>{guideNumber?.phone_number}</strong> from another phone. The handset, the
                  user's desktop app and their mobile should ring together. Answer on the handset.
                </li>
                <li>
                  Call a mobile from the handset. The caller ID shown must be{" "}
                  <strong>{guideNumber?.phone_number}</strong>.
                </li>
                <li>
                  Both calls appear in the user's Call History tagged <Badge variant="outline" className="text-[10px] mx-1">Desk phone</Badge>.
                </li>
              </ol>
            </Step>

            <Step n={5} title="Optional: record every desk phone call">
              <p className="text-sm text-muted-foreground flex items-start gap-2">
                <Mic className="w-4 h-4 mt-0.5 shrink-0" />
                The handset has no record button. The user can switch on automatic recording of all
                desk phone calls under <strong>Settings → Desk Phone</strong> in their app. Remind them
                callers should be told calls may be recorded.
              </p>
            </Step>

            <div className="rounded-md bg-muted/40 p-3 text-xs text-muted-foreground space-y-1">
              <div className="font-medium text-foreground">If it still doesn't work</div>
              <div>
                <strong>Register Failed:</strong> re-paste the three credential fields; set Transport to UDP
                explicitly (not DNS-NAPTR); check the phone has a DNS server (Network → Basic); turn off SIP
                ALG on the router.
              </div>
              <div>
                <strong>Registered but never rings:</strong> the connection's SIP-URI calling must be
                "internal" — this page sets it automatically. If the phone was set up another way, ask the
                developer to check the Telnyx connection.
              </div>
              <div>
                <strong>Diagnostics:</strong> this firmware has no log level. Use Settings → Configuration →
                Pcap Feature (Start, reproduce, Stop, Export) and send the file to the developer.
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* ── Existing desk phones ───────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>Desk phones</CardTitle>
              <CardDescription>Handsets already provisioned. Open one to see its setup guide again.</CardDescription>
            </div>
            <Button variant="outline" size="sm" onClick={loadAll} disabled={loading} className="gap-1.5">
              <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} /> Refresh
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {loading && deskPhones.length === 0 ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground py-6">
              <Loader2 className="w-4 h-4 animate-spin" /> Loading…
            </div>
          ) : deskPhones.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">No desk phones yet. Create one above.</div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Label</TableHead>
                  <TableHead>User</TableHead>
                  <TableHead>Number</TableHead>
                  <TableHead>Username</TableHead>
                  <TableHead>Recording</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {deskPhones.map((d) => (
                  <TableRow key={d.id}>
                    <TableCell className="font-medium">{d.label || "Desk phone"}</TableCell>
                    <TableCell>{userName(d.user_id)}</TableCell>
                    <TableCell>{d.phone_number_id ? numberById.get(d.phone_number_id)?.phone_number ?? "—" : "—"}</TableCell>
                    <TableCell className="font-mono text-xs">{d.sip_username.slice(0, 14)}…</TableCell>
                    <TableCell>
                      {(d as DeskPhoneRow & { auto_record?: boolean }).auto_record ? (
                        <Badge className="bg-success/10 text-success border-success/20">All calls</Badge>
                      ) : (
                        <Badge variant="outline">Off</Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {new Date(d.created_at).toLocaleDateString()}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button variant="ghost" size="sm" className="gap-1" onClick={() => setGuideFor(d)}>
                        Setup guide <ChevronRight className="w-4 h-4" />
                      </Button>
                      <Button variant="ghost" size="sm" className="text-destructive" onClick={() => setRemoveTarget(d)}>
                        <Trash2 className="w-4 h-4 mr-1" /> Remove
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <AlertDialog open={!!removeTarget} onOpenChange={(o) => !o && setRemoveTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove this desk phone?</AlertDialogTitle>
            <AlertDialogDescription>
              The handset will stop registering and its Telnyx connection is deleted. The user's apps and
              number are not affected. Past calls stay in history.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={remove} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};

export default DeskPhonesManagement;
