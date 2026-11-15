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
  AlertTriangle, Camera, Check, CheckCheck, Clock, Copy, CreditCard, ExternalLink, FileText, Image as ImageIcon, Loader2,
  MessageCircle, MessageSquarePlus, RefreshCw, RotateCcw, Search, Send, Settings, X,
} from "lucide-react";
import { cn } from "@/lib/utils";

/* ───────────────────────────── types ───────────────────────────── */

interface Account {
  user_id: string;
  enabled: boolean;
  phone_number: string | null;
  status: "not_connected" | "connecting" | "connected" | "failed";
  signup_state: string | null;
  waba_id: string | null;
  phone_number_id: string | null;
  business_id: string | null;
  connected_phone_number: string | null;
  display_name: string | null;
  name_status: string | null;
  profile_photo_url: string | null;
  about: string | null;
  description: string | null;
  category: string | null;
  email: string | null;
  website: string | null;
  address: string | null;
  last_error: string | null;
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
  foreign_id: string | null;
  created_at: string;
}
interface Template { id: string; name: string; language: string; category: string; body: string; param_count: number; }
interface SignupData { phone_number_id?: string; waba_id?: string; business_id?: string; }

interface WhatsAppViewProps {
  userId?: string;
}

declare global {
  interface Window {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    FB?: any;
    fbAsyncInit?: () => void;
  }
}

const SIGNUP_STEPS: Record<string, string> = {
  EXCHANGE_TOKEN: "Getting access from Meta",
  SUBSCRIBE_WEBHOOKS: "Linking your WhatsApp account to Greencaller",
  VERIFY_NUMBER: "Checking your number",
  REGISTER_PHONE_NUMBER: "Registering your number with WhatsApp",
  COMPLETE: "Finishing up",
};

const CATEGORIES: { value: string; label: string }[] = [
  { value: "AUTO", label: "Automotive" }, { value: "BEAUTY", label: "Beauty, spa & salon" }, { value: "APPAREL", label: "Clothing & apparel" },
  { value: "EDU", label: "Education" }, { value: "ENTERTAIN", label: "Entertainment" }, { value: "EVENT_PLAN", label: "Event planning" },
  { value: "FINANCE", label: "Finance & banking" }, { value: "GROCERY", label: "Food & grocery" }, { value: "GOVT", label: "Public service" },
  { value: "HOTEL", label: "Hotel & lodging" }, { value: "HEALTH", label: "Medical & health" }, { value: "NONPROFIT", label: "Non-profit" },
  { value: "PROF_SERVICES", label: "Professional services" }, { value: "RETAIL", label: "Shopping & retail" }, { value: "TRAVEL", label: "Travel & transportation" },
  { value: "RESTAURANT", label: "Restaurant" }, { value: "OTHER", label: "Other" },
];

const WINDOW_MS = 24 * 60 * 60 * 1000;
const withinWindow = (c: Conversation | null) => !!c?.last_inbound_at && Date.now() - new Date(c.last_inbound_at).getTime() < WINDOW_MS;
const isElectron = typeof navigator !== "undefined" && /electron/i.test(navigator.userAgent);
const BILLING_NOTE_KEY = "wa_billing_note_dismissed";

const fmtTime = (iso: string) => {
  const d = new Date(iso);
  if (isToday(d)) return format(d, "HH:mm");
  if (isYesterday(d)) return `Yesterday ${format(d, "HH:mm")}`;
  return format(d, "d MMM HH:mm");
};
const initials = (s: string) => s.replace(/[^A-Za-z0-9]/g, "").slice(0, 2).toUpperCase() || "#";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

/** Load Meta's JavaScript SDK once and initialise it for our app. */
const loadFacebookSdk = (appId: string, version: string) =>
  new Promise<void>((resolve, reject) => {
    if (window.FB) {
      window.FB.init({ appId, autoLogAppEvents: true, xfbml: false, version });
      resolve();
      return;
    }
    window.fbAsyncInit = () => {
      window.FB.init({ appId, autoLogAppEvents: true, xfbml: false, version });
      resolve();
    };
    const s = document.createElement("script");
    s.src = "https://connect.facebook.net/en_US/sdk.js";
    s.async = true;
    s.defer = true;
    s.crossOrigin = "anonymous";
    s.onerror = () => reject(new Error("Could not load Meta's sign-in script. Disable ad blockers for this site and try again."));
    document.body.appendChild(s);
  });

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

/** Resolve a message's media into a viewable URL (signed storage URL, fetched on demand). */
const useMediaUrl = (m: Message) => {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let on = true;
    (async () => {
      if (!m.media_url) return;
      if (/^https?:\/\//.test(m.media_url)) { setUrl(m.media_url); return; }
      let path = m.media_url.startsWith("storage:") ? m.media_url.slice("storage:".length) : null;
      if (!path && m.media_url.startsWith("meta-media:")) {
        try { path = (await invoke("whatsapp-connect", { action: "media", message_id: m.id })).path; } catch { return; }
      }
      if (!path) return;
      const { data } = await supabase.storage.from("whatsapp-media").createSignedUrl(path, 3600);
      if (on && data?.signedUrl) setUrl(data.signedUrl);
    })();
    return () => { on = false; };
  }, [m.id, m.media_url]);
  return url;
};

const MediaBubble = ({ m }: { m: Message }) => {
  const url = useMediaUrl(m);
  if (!m.media_url) return null;
  if (m.message_type === "image" || m.message_type === "sticker") {
    return url
      ? <a href={url} target="_blank" rel="noreferrer"><img src={url} alt="" className="mb-1 max-h-64 rounded-md" /></a>
      : <div className="mb-1 flex items-center gap-1 text-xs opacity-80"><ImageIcon className="h-3.5 w-3.5" /> Loading image…</div>;
  }
  if (m.message_type === "audio" && url) return <audio controls src={url} className="mb-1 max-w-full" />;
  if (m.message_type === "video" && url) return <video controls src={url} className="mb-1 max-h-64 rounded-md" />;
  return url
    ? <a href={url} target="_blank" rel="noreferrer" className="mb-1 flex items-center gap-1 text-xs underline"><FileText className="h-3.5 w-3.5" /> Open {m.message_type}</a>
    : <div className="mb-1 flex items-center gap-1 text-xs opacity-80"><FileText className="h-3.5 w-3.5" /> Loading {m.message_type}…</div>;
};

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
  const [pendingName, setPendingName] = useState<string | null>(null);
  const [savingProfile, setSavingProfile] = useState(false);
  const [showBilling, setShowBilling] = useState(() => { try { return localStorage.getItem(BILLING_NOTE_KEY) !== "1"; } catch { return true; } });

  const photoInput = useRef<HTMLInputElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const signupData = useRef<SignupData | null>(null);
  const activeIdRef = useRef<string | null>(null);
  const lastMarkedRead = useRef<string | null>(null);

  const active = useMemo(() => conversations.find((c) => c.id === activeId) ?? null, [conversations, activeId]);
  const connected = account?.status === "connected";

  // ── Account status ───────────────────────────────────────────────────
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

  // Realtime: account row + conversations + messages.
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
      .select("id, conversation_id, direction, message_type, body, media_url, media_mime, status, error, foreign_id, created_at")
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
    supabase.from("whatsapp_conversations").update({ unread_count: 0 }).eq("id", activeId).then(() => {
      setConversations((prev) => prev.map((c) => (c.id === activeId ? { ...c, unread_count: 0 } : c)));
    });
  }, [activeId, loadMessages]);

  // Blue ticks for the customer: mark the latest inbound message as read when it's on screen.
  useEffect(() => {
    const lastInbound = [...messages].reverse().find((m) => m.direction === "inbound" && m.foreign_id);
    if (!lastInbound || lastInbound.foreign_id === lastMarkedRead.current) return;
    lastMarkedRead.current = lastInbound.foreign_id;
    invoke("whatsapp-connect", { action: "mark-read", message_id: lastInbound.foreign_id }).catch(() => { /* best effort */ });
  }, [messages]);

  useEffect(() => { bottomRef.current?.scrollIntoView({ block: "end" }); }, [messages.length, activeId]);

  // ── Connection (Meta Embedded Signup) ───────────────────────────────
  const finishSignup = useCallback(async (code: string) => {
    // The FINISH message from Meta's popup usually lands before the login callback; wait briefly if not.
    for (let i = 0; i < 25 && !signupData.current; i++) await sleep(100);
    const d = signupData.current || {};
    try {
      const res = await invoke("whatsapp-connect", {
        action: "complete", code, waba_id: d.waba_id, phone_number_id: d.phone_number_id, business_id: d.business_id,
      });
      setAccount(res.account);
      if (res.account?.status === "connected") toast({ title: "WhatsApp connected", description: "You can now message customers from Greencaller." });
    } catch (e: unknown) {
      toast({ title: "Could not finish connecting", description: (e as Error).message, variant: "destructive" });
      refreshStatus();
    } finally {
      setBusy(false);
    }
  }, [refreshStatus, toast]);

  const startConnect = async () => {
    setBusy(true);
    try {
      const cfg = await invoke("whatsapp-connect", { action: "config" });
      if (!cfg.ready) throw new Error("WhatsApp signup is not configured yet. Ask your administrator.");
      await loadFacebookSdk(cfg.app_id, cfg.graph_version);
      signupData.current = null;

      const onMessage = (ev: MessageEvent) => {
        if (typeof ev.origin !== "string" || !ev.origin.endsWith("facebook.com")) return;
        try {
          const d = typeof ev.data === "string" ? JSON.parse(ev.data) : ev.data;
          if (d?.type !== "WA_EMBEDDED_SIGNUP") return;
          if (typeof d.event === "string" && d.event.startsWith("FINISH")) signupData.current = d.data || {};
          else if (d.event === "ERROR") toast({ title: "Meta reported a problem", description: d.data?.error_message || "Please try again.", variant: "destructive" });
        } catch { /* not ours */ }
      };
      window.addEventListener("message", onMessage);

      window.FB.login(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (resp: any) => {
          const code: string | undefined = resp?.authResponse?.code;
          if (!code) {
            window.removeEventListener("message", onMessage);
            setBusy(false);
            toast({ title: "Connection cancelled", description: "You closed the Meta window before finishing." });
            return;
          }
          // Give the FINISH message a moment to arrive before unhooking.
          setTimeout(() => window.removeEventListener("message", onMessage), 5000);
          finishSignup(code);
        },
        {
          config_id: cfg.config_id,
          response_type: "code",
          override_default_response_type: true,
          extras: { sessionInfoVersion: "3", setup: {} },
        },
      );
    } catch (e: unknown) {
      setBusy(false);
      toast({ title: "Could not start", description: (e as Error).message, variant: "destructive" });
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
    setPendingName(null);
    setSettingsOpen(true);
    try {
      const d = await invoke("whatsapp-connect", { action: "profile" });
      setAccount(d.account);
      setProfile(d.account);
      setPendingName(d.pending_display_name || null);
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
      toast({ title: "Profile updated", description: (d.notes as string[] | undefined)?.join(" ") || "Customers will see the new details in WhatsApp." });
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

  const dismissBilling = () => { setShowBilling(false); try { localStorage.setItem(BILLING_NOTE_KEY, "1"); } catch { /* ignore */ } };

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
    const connecting = account.status === "connecting" || busy;
    const failed = account.status === "failed";
    return (
      <div className="mx-auto max-w-2xl p-6">
        <div className="rounded-xl border bg-white p-8 shadow-sm">
          <div className="mb-6 flex items-center gap-3">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-emerald-100"><MessageCircle className="h-6 w-6 text-emerald-700" /></div>
            <div>
              <h2 className="text-xl font-semibold">Connect WhatsApp Business</h2>
              <p className="text-sm text-muted-foreground">Link your Greencaller number to WhatsApp through your own Meta business. Takes about five minutes.</p>
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
              "Click Connect. Sign in to Facebook in the Meta window that opens.",
              "Choose or create your business portfolio and WhatsApp Business Account. They belong to you, not Greencaller.",
              "Type your number shown above and a display name. Verify it by phone call (answer it here in Greencaller) or by SMS.",
              "Finish. Afterwards add a payment method in WhatsApp Manager so Meta can bill your business for conversations.",
            ].map((s, i) => (
              <li key={i} className="flex gap-3">
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">{i + 1}</span>
                <span>{s}</span>
              </li>
            ))}
          </ol>

          {connecting && (
            <div className="mb-6 flex items-center gap-3 rounded-lg border bg-amber-50 p-4 text-sm text-amber-900">
              <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
              <div>
                <div className="font-medium">{account.signup_state ? SIGNUP_STEPS[account.signup_state] || account.signup_state : "Waiting for you to finish in the Meta window…"}</div>
                <div className="text-xs">Keep this tab open.</div>
              </div>
            </div>
          )}

          {failed && !busy && (
            <div className="mb-6 flex items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
              <div>
                <div className="font-medium text-destructive">Connection failed</div>
                <div className="text-muted-foreground">{account.last_error || "Something went wrong during signup."}</div>
              </div>
            </div>
          )}

          {isElectron && (
            <div className="mb-6 rounded-lg border bg-muted/40 p-4 text-sm text-muted-foreground">
              Meta&apos;s sign-in window doesn&apos;t work inside the desktop app. Open <span className="font-medium">greencaller.app</span> in your browser to connect; messaging then works here too.
            </div>
          )}

          <div className="flex flex-wrap gap-2">
            {!connecting && (
              <Button onClick={startConnect} disabled={busy || !account.phone_number || isElectron} className="bg-emerald-600 hover:bg-emerald-700">
                {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <ExternalLink className="mr-2 h-4 w-4" />}
                {failed ? "Try again" : "Connect WhatsApp"}
              </Button>
            )}
            {(account.status === "connecting" || failed) && !busy && (
              <Button variant="ghost" onClick={resetConnect}><RotateCcw className="mr-2 h-4 w-4" /> Start over</Button>
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

      {showBilling && (
        <div className="flex items-center gap-3 border-b bg-sky-50 px-4 py-2 text-xs text-sky-900">
          <CreditCard className="h-4 w-4 shrink-0" />
          <span className="flex-1">
            Meta bills your business directly for WhatsApp conversations. Add a payment method in{" "}
            <a href="https://business.facebook.com/wa/manage/home/" target="_blank" rel="noreferrer" className="font-medium underline">WhatsApp Manager</a> so messages keep flowing.
          </span>
          <button type="button" onClick={dismissBilling} className="rounded p-1 hover:bg-sky-100" title="Dismiss"><X className="h-3.5 w-3.5" /></button>
        </div>
      )}

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
                  No approved templates yet. Create templates in{" "}
                  <a href="https://business.facebook.com/wa/manage/message-templates/" target="_blank" rel="noreferrer" className="underline">WhatsApp Manager</a>;
                  once Meta approves them they appear here. Until then you can only reply to customers who message you first.
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
                <Button size="sm" variant="outline" onClick={() => photoInput.current?.click()} disabled={savingProfile}>
                  {savingProfile ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Camera className="mr-1.5 h-4 w-4" />} Change photo
                </Button>
                <p className="text-xs text-muted-foreground">Square JPEG works best. We resize to 640×640.</p>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>Display name</Label>
              <Input value={profile.display_name || ""} onChange={(e) => setProfile((p) => ({ ...p, display_name: e.target.value }))} />
              <p className="text-xs text-muted-foreground">
                {pendingName
                  ? `"${pendingName}" is waiting for Meta's review${profile.name_status ? ` (${profile.name_status.toLowerCase().replace(/_/g, " ")})` : ""}.`
                  : "Changing the display name sends it to Meta for review. It must match your business."}
              </p>
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
                <SelectContent>{CATEGORIES.map((c) => <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5"><Label>Email</Label><Input type="email" value={profile.email || ""} maxLength={128} onChange={(e) => setProfile((p) => ({ ...p, email: e.target.value }))} /></div>
              <div className="space-y-1.5"><Label>Website</Label><Input value={profile.website || ""} onChange={(e) => setProfile((p) => ({ ...p, website: e.target.value }))} placeholder="https://" /></div>
            </div>
            <div className="space-y-1.5"><Label>Address</Label><Input value={profile.address || ""} maxLength={256} onChange={(e) => setProfile((p) => ({ ...p, address: e.target.value }))} /></div>
            <div className="rounded-md bg-muted/50 p-3 text-xs text-muted-foreground">
              Number <span className="font-mono">{account.connected_phone_number}</span> · WhatsApp Business Account {account.waba_id}
              {account.connected_at && <> · connected {format(new Date(account.connected_at), "d MMM yyyy")}</>}
              <br />
              Billing, templates and quality rating live in{" "}
              <a href="https://business.facebook.com/wa/manage/home/" target="_blank" rel="noreferrer" className="underline">WhatsApp Manager</a>.
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
