import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { format, formatDistanceToNow, isToday, isYesterday } from "date-fns";
import {
  AlertTriangle, Camera, Check, CheckCheck, Clock, Copy, ExternalLink, FileText, Image as ImageIcon, Loader2,
  MessageCircle, MessageSquarePlus, RefreshCw, RotateCcw, Search, Send, Settings, Trash2, X,
} from "lucide-react";
import { cn } from "@/lib/utils";

/* ───────────────────────────── types ───────────────────────────── */

interface Account {
  user_id: string;
  enabled: boolean;
  phone_number: string | null;
  status: "not_connected" | "connecting" | "connected" | "failed";
  signup_url: string | null;
  signup_expires_at: string | null;
  signup_state: string | null;
  waba_id: string | null;
  connected_phone_number: string | null;
  display_name: string | null;
  profile_photo_url: string | null;
  about: string | null;
  description: string | null;
  category: string | null;
  email: string | null;
  website: string | null;
  address: string | null;
  last_error: string | null;
  last_otp_code: string | null;
  last_otp_at: string | null;
  connected_at: string | null;
}
interface Conversation {
  id: string;
  contact_number: string;
  contact_name: string | null;
  last_message_at: string | null;
  last_message_preview: string | null;
  last_inbound_at: string | null;
  unread_count: number;
}
interface Message {
  id: string;
  conversation_id: string;
  direction: "inbound" | "outbound";
  message_type: string;
  body: string | null;
  media_url: string | null;
  media_mime: string | null;
  status: string;
  error: string | null;
  created_at: string;
}
interface Template { id: string; name: string; language: string; category: string; body: string; param_count: number; }

interface WhatsAppViewProps {
  userId?: string;
}

const SIGNUP_STEPS: Record<string, string> = {
  SUBSCRIBE_WEBHOOKS: "Linking your WhatsApp account to Telnyx",
  ASSIGNED_USERS: "Granting Telnyx access",
  SHARE_CREDIT_LINE: "Setting up billing with Meta",
  REGISTER_PHONE_NUMBER: "Registering your number with WhatsApp",
  ADD_WABA_TO_DB: "Saving your account",
  ADD_PHONE_NUMBERS_TO_DB: "Saving your number",
  COMPLETE: "Finishing up",
};

const CATEGORIES = [
  "AUTO", "BEAUTY", "APPAREL", "EDU", "ENTERTAIN", "EVENT_PLAN", "FINANCE", "GROCERY", "GOVT", "HOTEL",
  "HEALTH", "NONPROFIT", "PROF_SERVICES", "RETAIL", "TRAVEL", "RESTAURANT", "OTHER",
];
const CATEGORY_LABELS: Record<string, string> = {
  AUTO: "Automotive", BEAUTY: "Beauty, spa & salon", APPAREL: "Clothing & apparel", EDU: "Education", ENTERTAIN: "Entertainment",
  EVENT_PLAN: "Event planning", FINANCE: "Finance & banking", GROCERY: "Food & grocery", GOVT: "Public service", HOTEL: "Hotel & lodging",
  HEALTH: "Medical & health", NONPROFIT: "Non-profit", PROF_SERVICES: "Professional services", RETAIL: "Shopping & retail",
  TRAVEL: "Travel & transportation", RESTAURANT: "Restaurant", OTHER: "Other",
};

const WINDOW_MS = 24 * 60 * 60 * 1000;
const withinWindow = (c: Conversation | null) => !!c?.last_inbound_at && Date.now() - new Date(c.last_inbound_at).getTime() < WINDOW_MS;

const fmtTime = (iso: string) => {
  const d = new Date(iso);
  if (isToday(d)) return format(d, "HH:mm");
  if (isYesterday(d)) return `Yesterday ${format(d, "HH:mm")}`;
  return format(d, "d MMM HH:mm");
};
const initials = (s: string) => s.replace(/[^A-Za-z0-9]/g, "").slice(0, 2).toUpperCase() || "#";

/* ───────────────────────────── helpers ───────────────────────────── */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function invoke(name: string, body: Record<string, unknown>): Promise<any> {
  const { data, error } = await supabase.functions.invoke(name, { body });
  if (error) {
    let msg = error.message;
    try {
      const j = await (error as { context?: Response }).context?.json();
      if (j?.error) msg = j.error;
    } catch { /* ignore */ }
    throw new Error(msg);
  }
  if (data?.error) throw new Error(data.error);
  return data;
}

/** Downscale to a 640px JPEG so the upload is small and Meta-friendly. */
const fileToJpegBase64 = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const size = 640;
      const canvas = document.createElement("canvas");
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext("2d")!;
      const s = Math.min(img.width, img.height);
      ctx.drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, size, size);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL("image/jpeg", 0.9).split(",")[1]);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Could not read that image.")); };
    img.src = url;
  });

/* ───────────────────────────── component ───────────────────────────── */

export const WhatsAppView = ({ userId }: WhatsAppViewProps) => {
  const { toast } = useToast();
  const [account, setAccount] = useState<Account | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [search, setSearch] = useState("");
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);

  const [newChatOpen, setNewChatOpen] = useState(false);
  const [newNumber, setNewNumber] = useState("");
  const [templates, setTemplates] = useState<Template[] | null>(null);
  const [tplName, setTplName] = useState("");
  const [tplParams, setTplParams] = useState<string[]>([]);

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [profile, setProfile] = useState<Partial<Account>>({});
  const [savingProfile, setSavingProfile] = useState(false);
  const photoInput = useRef<HTMLInputElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  const active = useMemo(() => conversations.find((c) => c.id === activeId) ?? null, [conversations, activeId]);
  const connected = account?.status === "connected";

  // ── Account status (polls while connecting) ──────────────────────────
  const refreshStatus = useCallback(async () => {
    try {
      const d = await invoke("whatsapp-connect", { action: "status" });
      setAccount(d.account);
      return d.account as Account;
    } catch (e: unknown) {
      if (!account) setAccount(null);
      if (loading) toast({ title: "WhatsApp unavailable", description: (e as Error).message, variant: "destructive" });
      return null;
    } finally {
      setLoading(false);
    }
  }, [account, loading, toast]);

  useEffect(() => {
    refreshStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (account?.status !== "connecting") return;
    const t = window.setInterval(refreshStatus, 4000);
    return () => window.clearInterval(t);
  }, [account?.status, refreshStatus]);

  // Realtime: account row (OTP code, status flips) + conversations + messages.
  useEffect(() => {
    if (!userId) return;
    const ch = supabase
      .channel(`whatsapp-${userId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "whatsapp_accounts", filter: `user_id=eq.${userId}` }, () => refreshStatus())
      .on("postgres_changes", { event: "*", schema: "public", table: "whatsapp_conversations", filter: `user_id=eq.${userId}` }, () => loadConversations())
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "whatsapp_messages", filter: `user_id=eq.${userId}` }, (p) => {
        const m = p.new as Message;
        setMessages((prev) => (m.conversation_id === activeIdRef.current && !prev.some((x) => x.id === m.id) ? [...prev, m] : prev));
      })
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "whatsapp_messages", filter: `user_id=eq.${userId}` }, (p) => {
        const m = p.new as Message;
        setMessages((prev) => prev.map((x) => (x.id === m.id ? m : x)));
      })
      .subscribe();
    return () => { supabase.removeChannel(ch); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  const activeIdRef = useRef<string | null>(null);
  useEffect(() => { activeIdRef.current = activeId; }, [activeId]);

  // ── Conversations / messages ────────────────────────────────────────
  const loadConversations = useCallback(async () => {
    if (!userId) return;
    const { data } = await supabase
      .from("whatsapp_conversations")
      .select("id, contact_number, contact_name, last_message_at, last_message_preview, last_inbound_at, unread_count")
      .eq("user_id", userId)
      .order("last_message_at", { ascending: false, nullsFirst: false });
    setConversations((data as Conversation[]) || []);
  }, [userId]);

  const loadMessages = useCallback(async (convId: string) => {
    const { data } = await supabase
      .from("whatsapp_messages")
      .select("id, conversation_id, direction, message_type, body, media_url, media_mime, status, error, created_at")
      .eq("conversation_id", convId)
      .order("created_at", { ascending: true })
      .limit(500);
    setMessages((data as Message[]) || []);
  }, []);

  useEffect(() => { if (connected) loadConversations(); }, [connected, loadConversations]);

  // Realtime can miss events (see EnterprisePlatform) → light polling fallback.
  useEffect(() => {
    if (!connected) return;
    const t = window.setInterval(() => { loadConversations(); if (activeIdRef.current) loadMessages(activeIdRef.current); }, 10000);
    return () => window.clearInterval(t);
  }, [connected, loadConversations, loadMessages]);

  useEffect(() => {
    if (!activeId) return;
    loadMessages(activeId);
    // Mark read (RLS allows users to update their own conversation rows).
    supabase.from("whatsapp_conversations").update({ unread_count: 0 }).eq("id", activeId).then(() => {
      setConversations((prev) => prev.map((c) => (c.id === activeId ? { ...c, unread_count: 0 } : c)));
    });
  }, [activeId, loadMessages]);

  useEffect(() => { bottomRef.current?.scrollIntoView({ block: "end" }); }, [messages.length, activeId]);

  // ── Connection actions ──────────────────────────────────────────────
  const openSignup = (url: string) => {
    const w = window.open(url, "_blank", "noopener");
    if (!w) toast({ title: "Pop-up blocked", description: "Allow pop-ups for this site, or use the link shown below." });
  };

  const startConnect = async () => {
    setBusy(true);
    try {
      const d = await invoke("whatsapp-connect", { action: "start" });
      setAccount(d.account);
      openSignup(d.url);
    } catch (e: unknown) {
      toast({ title: "Could not start", description: (e as Error).message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  const resetConnect = async () => {
    setBusy(true);
    try {
      const d = await invoke("whatsapp-connect", { action: "reset" });
      setAccount(d.account);
    } catch (e: unknown) {
      toast({ title: "Could not reset", description: (e as Error).message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  // ── Messaging ───────────────────────────────────────────────────────
  const send = async (to: string, payload: Record<string, unknown>) => {
    setSending(true);
    try {
      const d = await invoke("whatsapp-send", { to, ...payload });
      const conv = d.conversation as Conversation;
      setConversations((prev) => [conv, ...prev.filter((c) => c.id !== conv.id)]);
      setActiveId(conv.id);
      setMessages((prev) => (prev.some((m) => m.id === d.message.id) ? prev : [...prev, d.message]));
      return true;
    } catch (e: unknown) {
      toast({ title: "Not sent", description: (e as Error).message, variant: "destructive" });
      return false;
    } finally {
      setSending(false);
    }
  };

  const sendDraft = async () => {
    if (!active || !draft.trim()) return;
    const text = draft.trim();
    setDraft("");
    const ok = await send(active.contact_number, { text });
    if (!ok) setDraft(text);
  };

  const loadTemplates = async () => {
    if (templates) return;
    try {
      const d = await invoke("whatsapp-connect", { action: "templates" });
      setTemplates(d.templates || []);
    } catch (e: unknown) {
      setTemplates([]);
      toast({ title: "Could not load templates", description: (e as Error).message, variant: "destructive" });
    }
  };
  const tpl = templates?.find((t) => t.name === tplName) || null;
  const tplParamCount = tpl?.param_count || 0;
  useEffect(() => {
    setTplParams((prev) => Array.from({ length: tplParamCount }, (_, i) => prev[i] || ""));
  }, [tplName, tplParamCount]);

  const previewOf = (t: Template, params: string[]) => t.body.replace(/\{\{(\d+)\}\}/g, (_, n) => params[Number(n) - 1] || `{{${n}}}`);

  const sendTemplate = async (to: string) => {
    if (!tpl) return;
    const ok = await send(to, { template: { name: tpl.name, language: tpl.language, params: tplParams }, preview: previewOf(tpl, tplParams) });
    if (ok) { setNewChatOpen(false); setNewNumber(""); setTplName(""); }
  };

  // ── Profile ─────────────────────────────────────────────────────────
  const openSettings = async () => {
    setProfile(account || {});
    setSettingsOpen(true);
    try {
      const d = await invoke("whatsapp-connect", { action: "profile" });
      setAccount(d.account);
      setProfile(d.account);
    } catch { /* show cached values */ }
  };

  const saveProfile = async () => {
    setSavingProfile(true);
    try {
      const d = await invoke("whatsapp-connect", {
        action: "update-profile",
        display_name: profile.display_name ?? "",
        about: profile.about ?? "",
        description: profile.description ?? "",
        category: profile.category ?? "",
        email: profile.email ?? "",
        website: profile.website ?? "",
        address: profile.address ?? "",
      });
      setAccount(d.account);
      toast({ title: "Profile updated", description: "Display name changes may take time while Meta reviews them." });
      setSettingsOpen(false);
    } catch (e: unknown) {
      toast({ title: "Could not save", description: (e as Error).message, variant: "destructive" });
    } finally {
      setSavingProfile(false);
    }
  };

  const uploadPhoto = async (file: File) => {
    setSavingProfile(true);
    try {
      const data_base64 = await fileToJpegBase64(file);
      const d = await invoke("whatsapp-connect", { action: "upload-photo", data_base64, content_type: "image/jpeg" });
      setAccount(d.account);
      setProfile(d.account);
      toast({ title: "Profile photo updated" });
    } catch (e: unknown) {
      toast({ title: "Upload failed", description: (e as Error).message, variant: "destructive" });
    } finally {
      setSavingProfile(false);
    }
  };

  const deletePhoto = async () => {
    setSavingProfile(true);
    try {
      const d = await invoke("whatsapp-connect", { action: "delete-photo" });
      setAccount(d.account);
      setProfile(d.account);
    } catch (e: unknown) {
      toast({ title: "Could not remove photo", description: (e as Error).message, variant: "destructive" });
    } finally {
      setSavingProfile(false);
    }
  };

  /* ───────────────────────────── render ───────────────────────────── */

  if (loading) {
    return <div className="flex h-full min-h-[50vh] items-center justify-center"><Loader2 className="h-8 w-8 animate-spin text-primary" /></div>;
  }

  if (!account) {
    return (
      <div className="flex h-full min-h-[50vh] flex-col items-center justify-center p-8 text-center">
        <MessageCircle className="mb-3 h-10 w-10 text-muted-foreground" />
        <h2 className="text-lg font-semibold">WhatsApp isn&apos;t enabled for your account</h2>
        <p className="mt-1 max-w-sm text-sm text-muted-foreground">Ask your administrator to enable WhatsApp Business on one of your numbers.</p>
      </div>
    );
  }

  // ── Not connected / connecting / failed ───────────────────────────────
  if (!connected) {
    const connecting = account.status === "connecting";
    const failed = account.status === "failed";
    const expired = !!account.signup_expires_at && new Date(account.signup_expires_at) < new Date();
    return (
      <div className="mx-auto max-w-2xl p-6">
        <div className="rounded-xl border bg-white p-8 shadow-sm">
          <div className="mb-6 flex items-center gap-3">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-emerald-100"><MessageCircle className="h-6 w-6 text-emerald-700" /></div>
            <div>
              <h2 className="text-xl font-semibold">Connect WhatsApp Business</h2>
              <p className="text-sm text-muted-foreground">Link your Greencaller number to WhatsApp through Meta. Takes about five minutes.</p>
            </div>
          </div>

          <div className="mb-6 rounded-lg border bg-muted/30 p-4">
            <div className="text-xs uppercase tracking-wide text-muted-foreground">Your WhatsApp number</div>
            <div className="mt-1 flex items-center gap-2">
              <span className="font-mono text-2xl font-semibold">{account.phone_number || "Not assigned yet"}</span>
              {account.phone_number && (
                <Button size="sm" variant="ghost" onClick={() => { navigator.clipboard.writeText(account.phone_number!); toast({ title: "Copied" }); }}>
                  <Copy className="h-4 w-4" />
                </Button>
              )}
            </div>
            <p className="mt-1 text-xs text-muted-foreground">Enter exactly this number when Meta asks which phone number to use.</p>
          </div>

          <ol className="mb-6 space-y-3 text-sm">
            {[
              "Click Connect. A Meta window opens: sign in with Facebook and pick or create your business portfolio.",
              "Choose or create a WhatsApp Business Account, then type your number shown above and a display name.",
              "Pick how to receive the verification code. If you choose SMS the code appears right here; if you choose a phone call, answer it in Greencaller.",
              "Finish the Meta steps and come back here. We complete the setup automatically.",
            ].map((s, i) => (
              <li key={i} className="flex gap-3">
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">{i + 1}</span>
                <span className={cn(connecting && i < 1 && "text-muted-foreground")}>{s}</span>
              </li>
            ))}
          </ol>

          {connecting && account.last_otp_code && (
            <div className="mb-6 rounded-lg border-2 border-emerald-300 bg-emerald-50 p-4 text-center">
              <div className="text-xs uppercase tracking-wide text-emerald-800">Your verification code</div>
              <div className="font-mono text-3xl font-bold tracking-widest text-emerald-900">{account.last_otp_code}</div>
              <div className="text-xs text-emerald-800">Received {account.last_otp_at ? formatDistanceToNow(new Date(account.last_otp_at), { addSuffix: true }) : ""}. Type it into the Meta window.</div>
            </div>
          )}

          {connecting && (
            <div className="mb-6 flex items-center gap-3 rounded-lg border bg-amber-50 p-4 text-sm text-amber-900">
              <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
              <div>
                <div className="font-medium">{account.signup_state ? SIGNUP_STEPS[account.signup_state] || account.signup_state : "Waiting for you to finish the Meta steps…"}</div>
                <div className="text-xs">This page updates automatically.{expired ? " Your signup link has expired; start again." : ""}</div>
              </div>
            </div>
          )}

          {failed && (
            <div className="mb-6 flex items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
              <div>
                <div className="font-medium text-destructive">Connection failed</div>
                <div className="text-muted-foreground">{account.last_error || "Something went wrong during signup."}</div>
              </div>
            </div>
          )}

          <div className="flex flex-wrap gap-2">
            {!connecting && (
              <Button onClick={startConnect} disabled={busy || !account.phone_number} className="bg-emerald-600 hover:bg-emerald-700">
                {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <ExternalLink className="mr-2 h-4 w-4" />}
                {failed ? "Try again" : "Connect WhatsApp"}
              </Button>
            )}
            {connecting && account.signup_url && !expired && (
              <Button variant="outline" onClick={() => openSignup(account.signup_url!)}>
                <ExternalLink className="mr-2 h-4 w-4" /> Open the Meta window again
              </Button>
            )}
            {(connecting || failed) && (
              <Button variant="ghost" onClick={resetConnect} disabled={busy}><RotateCcw className="mr-2 h-4 w-4" /> Start over</Button>
            )}
            <Button variant="ghost" onClick={refreshStatus} disabled={busy}><RefreshCw className="mr-2 h-4 w-4" /> Refresh</Button>
          </div>
        </div>
      </div>
    );
  }

  // ── Connected: chat UI ────────────────────────────────────────────────
  const q = search.trim().toLowerCase();
  const list = q ? conversations.filter((c) => (c.contact_name || "").toLowerCase().includes(q) || c.contact_number.includes(q)) : conversations;
  const inWindow = withinWindow(active);

  const StatusIcon = ({ m }: { m: Message }) => {
    if (m.direction !== "outbound") return null;
    if (m.status === "failed") return <AlertTriangle className="h-3 w-3 text-destructive" />;
    if (m.status === "read") return <CheckCheck className="h-3 w-3 text-sky-500" />;
    if (m.status === "delivered") return <CheckCheck className="h-3 w-3" />;
    if (m.status === "sent") return <Check className="h-3 w-3" />;
    return <Clock className="h-3 w-3" />;
  };

  const MediaBubble = ({ m }: { m: Message }) => {
    const isHttp = !!m.media_url && /^https?:\/\//.test(m.media_url);
    if (m.message_type === "image" || m.message_type === "sticker") {
      return isHttp
        ? <a href={m.media_url!} target="_blank" rel="noreferrer"><img src={m.media_url!} alt="" className="mb-1 max-h-64 rounded-md" /></a>
        : <div className="mb-1 flex items-center gap-1 text-xs opacity-80"><ImageIcon className="h-3.5 w-3.5" /> Image (not downloadable)</div>;
    }
    if (["document", "video", "audio"].includes(m.message_type)) {
      return isHttp
        ? <a href={m.media_url!} target="_blank" rel="noreferrer" className="mb-1 flex items-center gap-1 text-xs underline"><FileText className="h-3.5 w-3.5" /> Open {m.message_type}</a>
        : <div className="mb-1 flex items-center gap-1 text-xs opacity-80"><FileText className="h-3.5 w-3.5" /> {m.message_type} (not downloadable)</div>;
    }
    return null;
  };

  return (
    <div className="flex h-full min-h-[calc(100vh-8rem)] flex-col">
      {/* Header */}
      <div className="flex items-center justify-between gap-3 border-b bg-white px-4 py-3">
        <div className="flex items-center gap-3">
          <Avatar className="h-10 w-10">
            <AvatarImage src={account.profile_photo_url || undefined} />
            <AvatarFallback className="bg-emerald-100 text-emerald-800">{initials(account.display_name || "WA")}</AvatarFallback>
          </Avatar>
          <div>
            <div className="flex items-center gap-2 font-semibold">{account.display_name || "WhatsApp Business"} <Badge variant="secondary" className="bg-emerald-100 font-normal text-emerald-800">Connected</Badge></div>
            <div className="font-mono text-xs text-muted-foreground">{account.connected_phone_number}</div>
          </div>
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={() => { setNewChatOpen(true); loadTemplates(); }}><MessageSquarePlus className="mr-1.5 h-4 w-4" /> New chat</Button>
          <Button size="sm" variant="outline" onClick={openSettings}><Settings className="mr-1.5 h-4 w-4" /> Profile &amp; settings</Button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* Conversation list */}
        <aside className="flex w-80 shrink-0 flex-col border-r bg-white">
          <div className="relative border-b p-3">
            <Search className="pointer-events-none absolute left-5 top-5 h-4 w-4 text-muted-foreground" />
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search chats" className="h-9 pl-8" />
          </div>
          <div className="flex-1 overflow-y-auto">
            {list.length === 0 ? (
              <p className="p-6 text-center text-sm text-muted-foreground">{conversations.length === 0 ? "No conversations yet. Customers who message your number will appear here, or start a new chat." : "No matches."}</p>
            ) : list.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => setActiveId(c.id)}
                className={cn("flex w-full items-center gap-3 border-b px-3 py-3 text-left transition-colors hover:bg-muted/50", c.id === activeId && "bg-emerald-50")}
              >
                <Avatar className="h-10 w-10"><AvatarFallback>{initials(c.contact_name || c.contact_number)}</AvatarFallback></Avatar>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-sm font-medium">{c.contact_name || c.contact_number}</span>
                    {c.last_message_at && <span className="shrink-0 text-[11px] text-muted-foreground">{fmtTime(c.last_message_at)}</span>}
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-xs text-muted-foreground">{c.contact_name ? `${c.contact_number} · ` : ""}{c.last_message_preview || ""}</span>
                    {c.unread_count > 0 && <span className="shrink-0 rounded-full bg-emerald-600 px-1.5 text-[11px] font-semibold text-white">{c.unread_count}</span>}
                  </div>
                </div>
              </button>
            ))}
          </div>
        </aside>

        {/* Thread */}
        <main className="flex min-w-0 flex-1 flex-col bg-[#efeae2]">
          {!active ? (
            <div className="flex flex-1 flex-col items-center justify-center p-8 text-center text-muted-foreground">
              <MessageCircle className="mb-3 h-10 w-10" />
              <p className="text-sm">Select a conversation or start a new chat.</p>
            </div>
          ) : (
            <>
              <div className="flex items-center justify-between border-b bg-white px-4 py-2.5">
                <div>
                  <div className="text-sm font-medium">{active.contact_name || active.contact_number}</div>
                  <div className="text-xs text-muted-foreground">{active.contact_name ? active.contact_number : (active.last_inbound_at ? `Last message ${formatDistanceToNow(new Date(active.last_inbound_at), { addSuffix: true })}` : "No messages from them yet")}</div>
                </div>
                <Button size="sm" variant="ghost" onClick={() => { const n = window.prompt("Contact name", active.contact_name || ""); if (n !== null) { supabase.from("whatsapp_conversations").update({ contact_name: n.trim() || null }).eq("id", active.id).then(loadConversations); } }}>
                  Rename
                </Button>
              </div>

              <div className="flex-1 space-y-1.5 overflow-y-auto px-6 py-4">
                {messages.map((m) => (
                  <div key={m.id} className={cn("flex", m.direction === "outbound" ? "justify-end" : "justify-start")}>
                    <div className={cn("max-w-[70%] rounded-lg px-3 py-1.5 text-sm shadow-sm", m.direction === "outbound" ? "bg-[#d9fdd3]" : "bg-white")}>
                      <MediaBubble m={m} />
                      {m.body && <div className="whitespace-pre-wrap break-words">{m.body}</div>}
                      <div className="mt-0.5 flex items-center justify-end gap-1 text-[10px] text-muted-foreground">
                        {m.message_type === "template" && <span className="rounded bg-black/5 px-1">template</span>}
                        {fmtTime(m.created_at)} <StatusIcon m={m} />
                      </div>
                      {m.error && <div className="text-[11px] text-destructive">{m.error}</div>}
                    </div>
                  </div>
                ))}
                <div ref={bottomRef} />
              </div>

              <div className="border-t bg-white p-3">
                {!inWindow && (
                  <div className="mb-2 flex flex-wrap items-center justify-between gap-2 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-900">
                    <span>WhatsApp only allows free-text replies within 24 hours of the customer&apos;s last message. Start with an approved template instead.</span>
                    <Button size="sm" variant="outline" className="h-7" onClick={() => { setNewNumber(active.contact_number); setNewChatOpen(true); loadTemplates(); }}>Send template</Button>
                  </div>
                )}
                <form className="flex items-end gap-2" onSubmit={(e) => { e.preventDefault(); sendDraft(); }}>
                  <Textarea
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendDraft(); } }}
                    placeholder={inWindow ? "Type a message" : "Free-text replies are outside the 24-hour window"}
                    rows={1}
                    className="min-h-[40px] max-h-32 resize-none"
                    disabled={sending}
                  />
                  <Button type="submit" disabled={sending || !draft.trim()} className="bg-emerald-600 hover:bg-emerald-700">
                    {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                  </Button>
                </form>
              </div>
            </>
          )}
        </main>
      </div>

      {/* New chat / template dialog */}
      <Dialog open={newChatOpen} onOpenChange={(o) => { setNewChatOpen(o); if (!o) { setTplName(""); } }}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>New WhatsApp message</DialogTitle>
            <DialogDescription>To message someone who hasn&apos;t written to you in the last 24 hours, WhatsApp requires an approved template.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label>Recipient number</Label>
              <Input value={newNumber} onChange={(e) => setNewNumber(e.target.value)} placeholder="+447700900123" />
            </div>
            <div className="space-y-1.5">
              <Label>Template</Label>
              {templates === null ? (
                <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading templates…</div>
              ) : templates.length === 0 ? (
                <p className="rounded-md bg-muted p-3 text-xs text-muted-foreground">
                  No approved templates yet. Templates are created and approved through Meta (via the Telnyx portal). Until then you can only reply to customers who message you first.
                </p>
              ) : (
                <Select value={tplName} onValueChange={setTplName}>
                  <SelectTrigger><SelectValue placeholder="Choose an approved template" /></SelectTrigger>
                  <SelectContent>
                    {templates.map((t) => <SelectItem key={t.id} value={t.name}>{t.name} <span className="text-muted-foreground">· {t.language} · {t.category}</span></SelectItem>)}
                  </SelectContent>
                </Select>
              )}
            </div>
            {tpl && (
              <>
                {tplParams.map((p, i) => (
                  <div key={i} className="space-y-1.5">
                    <Label>Value for {`{{${i + 1}}}`}</Label>
                    <Input value={p} onChange={(e) => setTplParams((prev) => prev.map((x, j) => (j === i ? e.target.value : x)))} />
                  </div>
                ))}
                <div className="rounded-lg bg-[#d9fdd3] p-3 text-sm whitespace-pre-wrap">{previewOf(tpl, tplParams)}</div>
              </>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setNewChatOpen(false)}>Cancel</Button>
            <Button onClick={() => sendTemplate(newNumber)} disabled={!tpl || !newNumber.trim() || sending || tplParams.some((p) => !p.trim())} className="bg-emerald-600 hover:bg-emerald-700">
              {sending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Send className="mr-2 h-4 w-4" />} Send template
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Profile & settings dialog */}
      <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>WhatsApp business profile</DialogTitle>
            <DialogDescription>What customers see when they open your business in WhatsApp.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="flex items-center gap-4">
              <Avatar className="h-20 w-20">
                <AvatarImage src={profile.profile_photo_url || undefined} />
                <AvatarFallback className="bg-emerald-100 text-xl text-emerald-800">{initials(profile.display_name || "WA")}</AvatarFallback>
              </Avatar>
              <div className="space-y-2">
                <input ref={photoInput} type="file" accept="image/*" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadPhoto(f); e.target.value = ""; }} />
                <Button size="sm" variant="outline" onClick={() => photoInput.current?.click()} disabled={savingProfile}><Camera className="mr-1.5 h-4 w-4" /> Change photo</Button>
                {profile.profile_photo_url && (
                  <Button size="sm" variant="ghost" className="text-destructive hover:text-destructive" onClick={deletePhoto} disabled={savingProfile}><Trash2 className="mr-1.5 h-4 w-4" /> Remove</Button>
                )}
                <p className="text-xs text-muted-foreground">Square JPEG works best. We resize to 640×640.</p>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>Display name</Label>
              <Input value={profile.display_name || ""} onChange={(e) => setProfile((p) => ({ ...p, display_name: e.target.value }))} />
              <p className="text-xs text-muted-foreground">Changing the display name triggers a Meta review.</p>
            </div>
            <div className="space-y-1.5">
              <Label>About <span className="text-muted-foreground">({(profile.about || "").length}/139)</span></Label>
              <Input value={profile.about || ""} maxLength={139} onChange={(e) => setProfile((p) => ({ ...p, about: e.target.value }))} placeholder="e.g. Available Mon–Fri 9am–6pm" />
            </div>
            <div className="space-y-1.5">
              <Label>Description <span className="text-muted-foreground">({(profile.description || "").length}/512)</span></Label>
              <Textarea value={profile.description || ""} maxLength={512} rows={3} onChange={(e) => setProfile((p) => ({ ...p, description: e.target.value }))} />
            </div>
            <div className="space-y-1.5">
              <Label>Category</Label>
              <Select value={profile.category || ""} onValueChange={(v) => setProfile((p) => ({ ...p, category: v }))}>
                <SelectTrigger><SelectValue placeholder="Choose a category" /></SelectTrigger>
                <SelectContent>{CATEGORIES.map((c) => <SelectItem key={c} value={c}>{CATEGORY_LABELS[c]}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5"><Label>Email</Label><Input type="email" value={profile.email || ""} onChange={(e) => setProfile((p) => ({ ...p, email: e.target.value }))} /></div>
              <div className="space-y-1.5"><Label>Website</Label><Input value={profile.website || ""} onChange={(e) => setProfile((p) => ({ ...p, website: e.target.value }))} placeholder="https://" /></div>
            </div>
            <div className="space-y-1.5"><Label>Address</Label><Input value={profile.address || ""} onChange={(e) => setProfile((p) => ({ ...p, address: e.target.value }))} /></div>
            <div className="rounded-md bg-muted/50 p-3 text-xs text-muted-foreground">
              Number <span className="font-mono">{account.connected_phone_number}</span> · WhatsApp Business Account {account.waba_id}
              {account.connected_at && <> · connected {format(new Date(account.connected_at), "d MMM yyyy")}</>}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSettingsOpen(false)}><X className="mr-1.5 h-4 w-4" /> Close</Button>
            <Button onClick={saveProfile} disabled={savingProfile} className="bg-emerald-600 hover:bg-emerald-700">
              {savingProfile ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Check className="mr-2 h-4 w-4" />} Save profile
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};
