import { useCallback, useEffect, useMemo, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import {
  ArrowLeft,
  Bot,
  Building2,
  LogOut,
  Mail,
  Phone,
  PhoneForwarded,
  RefreshCw,
  ShieldCheck,
  Users,
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import logo from "@/assets/greencaller-full-logo.png";
import { AIAssistant } from "@/components/AIAssistant";
import { ControlUserDetail, type ControlDepartment, type ControlUser } from "@/components/control/ControlUserDetail";
import { ControlIvrDetail, type ControlIvr } from "@/components/control/ControlIvrDetail";
import type { AnalyticsCall } from "@/components/control/CallAnalytics";

/* ───────────────────────────── types ───────────────────────────── */

interface MeProfile {
  id: string;
  full_name: string | null;
  email: string | null;
  company_name: string | null;
  is_company_admin: boolean | null;
}

interface Assistant {
  id: string;
  name: string;
  telnyx_phone_number: string | null;
  assigned_user_id: string | null;
  is_active: boolean | null;
}

interface RecentCall extends AnalyticsCall {
  user_id: string;
  to_number: string;
  from_number: string;
}

interface CompanyData {
  users: ControlUser[];
  departments: ControlDepartment[];
  /** user id → department ids */
  memberships: Record<string, string[]>;
  ivrs: ControlIvr[];
  assistants: Assistant[];
  /** Last 30 days, for the overview cards. */
  recentCalls: RecentCall[];
}

type Selection = { type: "user" | "ivr" | "assistant"; id: string } | null;

const EMPTY: CompanyData = { users: [], departments: [], memberships: {}, ivrs: [], assistants: [], recentCalls: [] };

const last9 = (n?: string | null) => (n || "").replace(/[^0-9]/g, "").slice(-9);

const initials = (name?: string | null) =>
  (name || "?")
    .split(" ")
    .map((n) => n[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);

/* ───────────────────────────── login ───────────────────────────── */

const ControlLogin = () => {
  const { toast } = useToast();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) throw error;
    } catch (err: any) {
      toast({ title: "Sign in failed", description: err.message, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen flex-col bg-muted/30">
      <header className="border-b border-border/40 bg-white px-6 py-3">
        <img src={logo} alt="Greencaller" className="h-10 w-auto" />
      </header>
      <main className="flex flex-1 items-center justify-center p-6">
        <div className="w-full max-w-md">
          <div className="rounded-lg border border-border/60 bg-white p-8 shadow-sm md:p-10">
            <div className="mb-8">
              <Badge variant="secondary" className="mb-3 gap-1 font-normal">
                <ShieldCheck className="h-3 w-3" /> Control
              </Badge>
              <h1 className="mb-2 text-2xl font-semibold text-foreground">Company admin sign in</h1>
              <p className="text-sm text-muted-foreground">
                Use your Greencaller login. Only accounts marked as a company admin can open Control.
              </p>
            </div>
            <form onSubmit={submit} className="space-y-5">
              <div className="space-y-2">
                <Label htmlFor="control-email">Email</Label>
                <Input
                  id="control-email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  placeholder="Enter email address"
                  className="h-11 bg-white"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="control-password">Password</Label>
                <Input
                  id="control-password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  minLength={6}
                  placeholder="Enter your password"
                  className="h-11 bg-white"
                />
              </div>
              <Button type="submit" className="mt-6 h-11 w-full" disabled={loading}>
                {loading ? "Please wait…" : "Continue"}
              </Button>
            </form>
          </div>
        </div>
      </main>
    </div>
  );
};

/* ───────────────────────────── page ───────────────────────────── */

const ControlDashboard = () => {
  const { toast } = useToast();
  const [session, setSession] = useState<Session | null>(null);
  const [sessionReady, setSessionReady] = useState(false);
  const [me, setMe] = useState<MeProfile | null>(null);
  const [meLoading, setMeLoading] = useState(false);
  const [data, setData] = useState<CompanyData>(EMPTY);
  const [dataLoading, setDataLoading] = useState(false);
  const [selected, setSelected] = useState<Selection>(null);
  const [ivrCalls, setIvrCalls] = useState<AnalyticsCall[]>([]);

  // ── Session ────────────────────────────────────────────────────────────
  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
      setSessionReady(true);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, next) => {
      setSession(next);
      if (!next) {
        setMe(null);
        setData(EMPTY);
        setSelected(null);
      }
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  // ── Who am I / which company ───────────────────────────────────────────
  useEffect(() => {
    if (!session?.user) return;
    let cancelled = false;
    setMeLoading(true);
    supabase
      .from("profiles")
      .select("id, full_name, email, company_name, is_company_admin")
      .eq("id", session.user.id)
      .maybeSingle()
      .then(({ data: profile }) => {
        if (cancelled) return;
        setMe((profile as MeProfile) || null);
        setMeLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [session?.user?.id]);

  const isCompanyAdmin = !!me?.is_company_admin && !!me?.company_name;
  const company = me?.company_name || null;

  // ── Company data ───────────────────────────────────────────────────────
  const loadCompany = useCallback(async () => {
    if (!company) return;
    setDataLoading(true);
    try {
      const { data: profiles, error: pErr } = await supabase
        .from("profiles")
        .select("id, full_name, email, account_type, is_company_admin")
        .eq("company_name", company)
        .order("full_name");
      if (pErr) throw pErr;
      const users = (profiles || []) as ControlUser[];
      const ids = users.map((u) => u.id);

      const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

      const [phonesRes, deptRes, ivrRes, assistRes, callsRes] = await Promise.all([
        ids.length
          ? supabase.from("phone_numbers").select("phone_number, assigned_to").in("assigned_to", ids).eq("is_active", true)
          : Promise.resolve({ data: [] as any[], error: null }),
        supabase.from("departments").select("id, name, description").eq("company_name", company).order("name"),
        supabase.from("ivr_configurations").select("id, phone_number_id, greeting_message, voice").eq("company_name", company),
        ids.length
          ? supabase.from("ai_assistants").select("id, name, telnyx_phone_number, assigned_user_id, is_active").in("assigned_user_id", ids)
          : Promise.resolve({ data: [] as any[], error: null }),
        ids.length
          ? supabase
              .from("call_history")
              .select("user_id, direction, duration, status, created_at, to_number, from_number")
              .in("user_id", ids)
              .gte("created_at", since)
              .order("created_at", { ascending: false })
              .limit(5000)
          : Promise.resolve({ data: [] as any[], error: null }),
      ]);

      const phoneByUser: Record<string, string> = {};
      for (const p of (phonesRes.data || []) as { phone_number: string; assigned_to: string | null }[]) {
        if (p.assigned_to) phoneByUser[p.assigned_to] = p.phone_number;
      }
      for (const u of users) u.phone = phoneByUser[u.id] || null;

      const departments = ((deptRes.data || []) as ControlDepartment[]) ?? [];
      const memberships: Record<string, string[]> = {};
      if (departments.length) {
        const { data: members } = await supabase
          .from("department_members")
          .select("department_id, user_id")
          .in("department_id", departments.map((d) => d.id));
        for (const m of (members || []) as { department_id: string; user_id: string }[]) {
          (memberships[m.user_id] ||= []).push(m.department_id);
        }
      }

      // IVR: resolve the attached number and route names for each option.
      const ivrRows = (ivrRes.data || []) as { id: string; phone_number_id: string | null; greeting_message: string | null; voice: string | null }[];
      let ivrs: ControlIvr[] = [];
      if (ivrRows.length) {
        const phoneIds = ivrRows.map((r) => r.phone_number_id).filter(Boolean) as string[];
        const [{ data: ivrPhones }, { data: options }] = await Promise.all([
          phoneIds.length
            ? supabase.from("phone_numbers").select("id, phone_number").in("id", phoneIds)
            : Promise.resolve({ data: [] as any[] }),
          supabase
            .from("ivr_menu_options")
            .select("id, ivr_config_id, digit, label, department_id, user_id")
            .in("ivr_config_id", ivrRows.map((r) => r.id)),
        ]);
        const phoneById = new Map(((ivrPhones || []) as { id: string; phone_number: string }[]).map((p) => [p.id, p.phone_number]));
        const deptName = new Map(departments.map((d) => [d.id, d.name]));
        const userName = new Map(users.map((u) => [u.id, u.full_name || u.email || "User"]));
        ivrs = ivrRows.map((r) => ({
          id: r.id,
          phone_number: r.phone_number_id ? phoneById.get(r.phone_number_id) || null : null,
          greeting_message: r.greeting_message,
          voice: r.voice,
          options: ((options || []) as any[])
            .filter((o) => o.ivr_config_id === r.id)
            .map((o) => ({
              id: o.id,
              digit: o.digit,
              label: o.label,
              department_name: o.department_id ? deptName.get(o.department_id) || null : null,
              user_name: o.user_id ? userName.get(o.user_id) || null : null,
            })),
        }));
      }

      setData({
        users,
        departments,
        memberships,
        ivrs,
        assistants: (assistRes.data || []) as Assistant[],
        recentCalls: (callsRes.data || []) as RecentCall[],
      });
    } catch (e: any) {
      console.error("Control load error:", e);
      toast({ title: "Could not load company data", description: e?.message, variant: "destructive" });
    } finally {
      setDataLoading(false);
    }
  }, [company, toast]);

  useEffect(() => {
    if (isCompanyAdmin) loadCompany();
  }, [isCompanyAdmin, loadCompany]);

  // IVR detail wants all-time inbound calls to that number, across the team.
  useEffect(() => {
    if (selected?.type !== "ivr") return;
    const ivr = data.ivrs.find((i) => i.id === selected.id);
    const digits = last9(ivr?.phone_number);
    const ids = data.users.map((u) => u.id);
    if (!digits || ids.length === 0) {
      setIvrCalls([]);
      return;
    }
    let cancelled = false;
    supabase
      .from("call_history")
      .select("direction, duration, status, created_at, to_number")
      .in("user_id", ids)
      .eq("direction", "inbound")
      .ilike("to_number", `%${digits}`)
      .order("created_at", { ascending: false })
      .limit(3000)
      .then(({ data: rows }) => {
        if (!cancelled) setIvrCalls((rows as AnalyticsCall[]) || []);
      });
    return () => {
      cancelled = true;
    };
  }, [selected, data.ivrs, data.users]);

  // ── Derived, for the overview cards ────────────────────────────────────
  const userStats = useMemo(() => {
    const m: Record<string, { calls: number; secs: number; missed: number }> = {};
    for (const c of data.recentCalls) {
      const s = (m[c.user_id] ||= { calls: 0, secs: 0, missed: 0 });
      s.calls += 1;
      s.secs += c.duration || 0;
      if (c.direction === "inbound" && (["no-answer", "busy", "failed", "missed"].includes(c.status) || (c.status === "ringing" && !c.duration))) s.missed += 1;
    }
    return m;
  }, [data.recentCalls]);

  const ivrRecentCount = useCallback(
    (ivr: ControlIvr) => {
      const d = last9(ivr.phone_number);
      if (!d) return 0;
      return data.recentCalls.filter((c) => c.direction === "inbound" && last9(c.to_number) === d).length;
    },
    [data.recentCalls],
  );

  const userNames = useMemo(
    () => Object.fromEntries(data.users.map((u) => [u.id, u.full_name || u.email || "User"])),
    [data.users],
  );

  const signOut = async () => {
    await supabase.auth.signOut();
  };

  /* ───────────────────────────── render ───────────────────────────── */

  if (!sessionReady) return null;
  if (!session) return <ControlLogin />;

  const shell = (children: React.ReactNode) => (
    <div className="flex min-h-screen flex-col bg-muted/30">
      <header className="sticky top-0 z-10 border-b border-border/40 bg-white/95 px-6 py-3 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center gap-4">
          <img src={logo} alt="Greencaller" className="h-9 w-auto" />
          <div className="h-6 w-px bg-border" />
          <div className="flex min-w-0 items-center gap-2">
            <Badge variant="secondary" className="gap-1 font-normal">
              <ShieldCheck className="h-3 w-3" /> Control
            </Badge>
            {company && <span className="truncate text-sm font-medium">{company}</span>}
          </div>
          <div className="ml-auto flex items-center gap-3">
            {me && (
              <span className="hidden text-sm text-muted-foreground sm:inline">
                {me.full_name || me.email}
              </span>
            )}
            <Button variant="outline" size="sm" onClick={signOut} className="gap-1.5">
              <LogOut className="h-3.5 w-3.5" /> Sign out
            </Button>
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-8">{children}</main>
    </div>
  );

  if (meLoading || !me) {
    return shell(<p className="py-16 text-center text-sm text-muted-foreground">Loading…</p>);
  }

  if (!isCompanyAdmin) {
    return shell(
      <div className="mx-auto max-w-md py-16">
        <Card>
          <CardContent className="space-y-4 py-10 text-center">
            <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-muted">
              <ShieldCheck className="h-7 w-7 text-muted-foreground" />
            </div>
            <h2 className="font-display text-xl font-semibold">Not a company admin</h2>
            <p className="text-sm text-muted-foreground">
              <span className="font-medium">{me.email}</span> isn't marked as a company admin
              {me.company_name ? ` for ${me.company_name}` : ""}. Ask your Greencaller administrator to
              assign you in the Companies tab.
            </p>
            <Button variant="outline" onClick={signOut} className="gap-1.5">
              <LogOut className="h-3.5 w-3.5" /> Sign out
            </Button>
          </CardContent>
        </Card>
      </div>,
    );
  }

  // ── Detail views ──────────────────────────────────────────────────────
  if (selected) {
    const back = (
      <Button variant="ghost" size="sm" className="-ml-2 mb-4 gap-1.5" onClick={() => setSelected(null)}>
        <ArrowLeft className="h-4 w-4" /> Back to overview
      </Button>
    );

    if (selected.type === "user") {
      const user = data.users.find((u) => u.id === selected.id);
      if (!user) return shell(back);
      return shell(
        <>
          {back}
          <ControlUserDetail
            user={user}
            departments={data.departments}
            memberDeptIds={data.memberships[user.id] || []}
            onMembershipChanged={loadCompany}
          />
        </>,
      );
    }

    if (selected.type === "ivr") {
      const ivr = data.ivrs.find((i) => i.id === selected.id);
      if (!ivr) return shell(back);
      return shell(
        <>
          {back}
          <ControlIvrDetail ivr={ivr} calls={ivrCalls} userIds={data.users.map((u) => u.id)} userNames={userNames} />
        </>,
      );
    }

    const assistant = data.assistants.find((a) => a.id === selected.id);
    if (!assistant) return shell(back);
    return shell(
      <>
        {back}
        <Card className="mb-4 shadow-none">
          <CardContent className="flex flex-wrap items-center gap-4 p-5">
            <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
              <Bot className="h-6 w-6" />
            </div>
            <div className="min-w-0 flex-1">
              <h2 className="font-display text-xl font-semibold">{assistant.name}</h2>
              <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
                <span className="font-mono">{assistant.telnyx_phone_number || "No number assigned"}</span>
                {assistant.assigned_user_id && (
                  <span className="flex items-center gap-1.5">
                    <Users className="h-3.5 w-3.5" /> {userNames[assistant.assigned_user_id] || "Unassigned"}
                  </span>
                )}
              </div>
            </div>
          </CardContent>
        </Card>
        {/* Same view the assigned user gets, minus owner-only controls. */}
        <div className="[&>div]:max-w-none [&>div]:p-0">
          <AIAssistant assistantId={assistant.id} userId={assistant.assigned_user_id || undefined} readOnly />
        </div>
      </>,
    );
  }

  // ── Overview ──────────────────────────────────────────────────────────
  const sectionTitle = (icon: React.ElementType, title: string, count: number) => {
    const Icon = icon;
    return (
      <div className="mb-3 flex items-center gap-2">
        <Icon className="h-4 w-4 text-primary" />
        <h2 className="font-display text-base font-semibold">{title}</h2>
        <Badge variant="secondary" className="font-normal">
          {count}
        </Badge>
      </div>
    );
  };

  const cardBase =
    "group cursor-pointer text-left transition-all hover:-translate-y-0.5 hover:shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-primary";

  return shell(
    <div className="space-y-10">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-semibold">{company}</h1>
          <p className="text-sm text-muted-foreground">
            {data.users.length} user{data.users.length === 1 ? "" : "s"} · {data.recentCalls.length} calls in the last 30 days
          </p>
        </div>
        <Button variant="outline" size="sm" className="gap-1.5" onClick={loadCompany} disabled={dataLoading}>
          <RefreshCw className={cn("h-3.5 w-3.5", dataLoading && "animate-spin")} /> Refresh
        </Button>
      </div>

      {/* Team */}
      <section>
        {sectionTitle(Users, "Team", data.users.length)}
        {dataLoading && data.users.length === 0 ? (
          <p className="py-8 text-sm text-muted-foreground">Loading…</p>
        ) : data.users.length === 0 ? (
          <p className="py-8 text-sm text-muted-foreground">No users are assigned to {company} yet.</p>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {data.users.map((u) => {
              const st = userStats[u.id];
              const depts = (data.memberships[u.id] || [])
                .map((id) => data.departments.find((d) => d.id === id)?.name)
                .filter(Boolean) as string[];
              return (
                <Card
                  key={u.id}
                  role="button"
                  tabIndex={0}
                  className={cardBase}
                  onClick={() => setSelected({ type: "user", id: u.id })}
                  onKeyDown={(e) => e.key === "Enter" && setSelected({ type: "user", id: u.id })}
                >
                  <CardContent className="p-4">
                    <div className="flex items-start gap-3">
                      <Avatar className="h-11 w-11 border-2 border-background">
                        <AvatarFallback className="bg-primary/10 font-semibold text-primary">
                          {initials(u.full_name)}
                        </AvatarFallback>
                      </Avatar>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <span className="truncate font-medium">{u.full_name || "Unnamed user"}</span>
                          {u.is_company_admin && <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-primary" />}
                        </div>
                        <div className="flex items-center gap-1 truncate text-xs text-muted-foreground">
                          <Mail className="h-3 w-3 shrink-0" /> <span className="truncate">{u.email}</span>
                        </div>
                        <div className="flex items-center gap-1 text-xs text-muted-foreground">
                          <Phone className="h-3 w-3 shrink-0" />
                          <span className="font-mono">{u.phone || "No number"}</span>
                        </div>
                      </div>
                    </div>
                    <div className="mt-3 flex flex-wrap items-center gap-1.5">
                      {depts.length > 0 ? (
                        depts.map((d) => (
                          <Badge key={d} variant="outline" className="gap-1 font-normal">
                            <Building2 className="h-3 w-3" /> {d}
                          </Badge>
                        ))
                      ) : (
                        <span className="text-xs text-muted-foreground">No department</span>
                      )}
                    </div>
                    <div className="mt-3 flex items-center gap-4 border-t pt-3 text-xs text-muted-foreground">
                      <span>
                        <span className="font-semibold text-foreground tabular-nums">{st?.calls || 0}</span> calls
                      </span>
                      <span>
                        <span className="font-semibold text-foreground tabular-nums">{Math.round((st?.secs || 0) / 60)}</span> min
                      </span>
                      {st?.missed ? (
                        <span className="text-destructive">
                          <span className="font-semibold tabular-nums">{st.missed}</span> missed
                        </span>
                      ) : null}
                      <span className="ml-auto text-[10px] uppercase tracking-wider">30 days</span>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </section>

      {/* IVR */}
      <section>
        {sectionTitle(PhoneForwarded, "IVR numbers", data.ivrs.length)}
        {data.ivrs.length === 0 ? (
          <p className="py-6 text-sm text-muted-foreground">
            No IVR is configured for {company}. IVRs are set up from the admin console.
          </p>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {data.ivrs.map((ivr) => (
              <Card
                key={ivr.id}
                role="button"
                tabIndex={0}
                className={cardBase}
                onClick={() => setSelected({ type: "ivr", id: ivr.id })}
                onKeyDown={(e) => e.key === "Enter" && setSelected({ type: "ivr", id: ivr.id })}
              >
                <CardContent className="p-4">
                  <div className="flex items-start gap-3">
                    <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
                      <PhoneForwarded className="h-5 w-5" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="font-medium">IVR number</div>
                      <div className="font-mono text-xs text-muted-foreground">{ivr.phone_number || "No number attached"}</div>
                    </div>
                  </div>
                  <p className="mt-3 line-clamp-2 text-xs text-muted-foreground">
                    {ivr.greeting_message ? `“${ivr.greeting_message}”` : "No greeting set."}
                  </p>
                  <div className="mt-3 flex items-center gap-4 border-t pt-3 text-xs text-muted-foreground">
                    <span>
                      <span className="font-semibold text-foreground tabular-nums">{ivr.options.length}</span> menu options
                    </span>
                    <span>
                      <span className="font-semibold text-foreground tabular-nums">{ivrRecentCount(ivr)}</span> calls
                    </span>
                    <span className="ml-auto text-[10px] uppercase tracking-wider">30 days</span>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </section>

      {/* AI assistants */}
      <section>
        {sectionTitle(Bot, "AI assistants", data.assistants.length)}
        {data.assistants.length === 0 ? (
          <p className="py-6 text-sm text-muted-foreground">
            No AI assistant is assigned to anyone at {company} yet.
          </p>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {data.assistants.map((a) => (
              <Card
                key={a.id}
                role="button"
                tabIndex={0}
                className={cardBase}
                onClick={() => setSelected({ type: "assistant", id: a.id })}
                onKeyDown={(e) => e.key === "Enter" && setSelected({ type: "assistant", id: a.id })}
              >
                <CardContent className="p-4">
                  <div className="flex items-start gap-3">
                    <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
                      <Bot className="h-5 w-5" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate font-medium">{a.name}</span>
                        <Badge variant={a.is_active ? "default" : "secondary"} className="ml-auto shrink-0 text-[10px]">
                          {a.is_active ? "Active" : "Inactive"}
                        </Badge>
                      </div>
                      <div className="font-mono text-xs text-muted-foreground">
                        {a.telnyx_phone_number || "No number assigned"}
                      </div>
                    </div>
                  </div>
                  <div className="mt-3 flex items-center gap-1.5 border-t pt-3 text-xs text-muted-foreground">
                    <Users className="h-3 w-3" />
                    {a.assigned_user_id ? userNames[a.assigned_user_id] || "Assigned user" : "Unassigned"}
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </section>
    </div>,
  );
};

export default ControlDashboard;
