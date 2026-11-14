import { useCallback, useEffect, useMemo, useState } from "react";
import { format, isToday } from "date-fns";
import {
  ArrowRight,
  Building2,
  ChevronLeft,
  Mail,
  MessageCircle,
  MoreHorizontal,
  Phone,
  Plus,
  Search,
  Trash2,
  User,
  Users,
  X,
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { contactColor, contactInitials, usePersonalContacts, type UserContact } from "@/hooks/usePersonalContacts";
import { AddContactDialog } from "@/components/AddContactDialog";
import { TeamConversation } from "@/components/TeamConversation";

interface ContactsViewProps {
  userId?: string;
  onCall?: (phoneNumber: string) => void;
  /** Narrow single-column layout (Sidebar Mode's slide-out panel). */
  compact?: boolean;
  /** Fired when a teammate's unread messages are marked read. */
  onMessagesRead?: () => void;
}

type Mode = "contacts" | "teammates";

interface Teammate {
  id: string;
  full_name: string;
  email: string;
  company_name: string | null;
}

interface Department {
  id: string;
  name: string;
}

const initials = (name: string) =>
  (name || "?")
    .split(" ")
    .map((n) => n[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);

const fmtLast = (iso: string) => {
  const d = new Date(iso);
  return isToday(d) ? format(d, "h:mm a") : format(d, "d MMM");
};

/**
 * Enterprise Contacts: one left bar whose title switches between the user's
 * personal Contacts and the company's Teammates; the right side shows the
 * selected contact's details, or the conversation with the selected teammate
 * (team messaging lives here — there is no separate Messages tab).
 */
export const ContactsView = ({ userId, onCall, compact = false, onMessagesRead }: ContactsViewProps) => {
  const { toast } = useToast();
  const [mode, setMode] = useState<Mode>("contacts");
  const [search, setSearch] = useState("");
  /** Compact only: a detail/conversation is showing instead of the list. */
  const [detailOpen, setDetailOpen] = useState(false);

  // ── Personal contacts ────────────────────────────────────────────────────
  const { contacts, loading: contactsLoading, addContact, deleteContact } = usePersonalContacts(userId);
  const [selectedContactId, setSelectedContactId] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const selectedContact = contacts.find((c) => c.id === selectedContactId) || null;

  // ── Team ─────────────────────────────────────────────────────────────────
  const [company, setCompany] = useState<string | null>(null);
  const [isCompanyAdmin, setIsCompanyAdmin] = useState(false);
  const [teammates, setTeammates] = useState<Teammate[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [membersByDept, setMembersByDept] = useState<Record<string, string[]>>({});
  const [phones, setPhones] = useState<Record<string, string>>({});
  const [unread, setUnread] = useState<Record<string, number>>({});
  const [lastMsgAt, setLastMsgAt] = useState<Record<string, string>>({});
  const [onlineUsers, setOnlineUsers] = useState<Set<string>>(new Set());
  const [selectedMateId, setSelectedMateId] = useState<string | null>(null);
  const selectedMate = teammates.find((t) => t.id === selectedMateId) || null;

  useEffect(() => {
    if (!userId) return;
    supabase
      .from("profiles")
      .select("company_name, is_company_admin")
      .eq("id", userId)
      .maybeSingle()
      .then(({ data }) => {
        setCompany(data?.company_name ?? null);
        setIsCompanyAdmin(!!(data as any)?.is_company_admin);
      });
  }, [userId]);

  const loadTeam = useCallback(async () => {
    if (!userId || !company) return;
    const { data: profiles } = await supabase
      .from("profiles")
      .select("id, full_name, email, company_name")
      .eq("company_name", company)
      .neq("id", userId)
      .order("full_name");
    const mates = (profiles || []) as Teammate[];
    setTeammates(mates);

    const ids = mates.map((m) => m.id);
    const [{ data: phoneRows }, { data: depts }] = await Promise.all([
      ids.length
        ? supabase.from("phone_numbers").select("assigned_to, phone_number").in("assigned_to", ids).eq("is_active", true)
        : Promise.resolve({ data: [] as any[] }),
      supabase.from("departments").select("id, name").eq("company_name", company).order("name"),
    ]);
    const phoneMap: Record<string, string> = {};
    for (const p of (phoneRows || []) as { assigned_to: string | null; phone_number: string }[]) {
      if (p.assigned_to) phoneMap[p.assigned_to] = p.phone_number;
    }
    setPhones(phoneMap);

    const deptList = (depts || []) as Department[];
    setDepartments(deptList);
    if (deptList.length) {
      const { data: members } = await supabase
        .from("department_members")
        .select("department_id, user_id")
        .in("department_id", deptList.map((d) => d.id));
      const grouped: Record<string, string[]> = {};
      for (const m of (members || []) as { department_id: string; user_id: string }[]) {
        (grouped[m.department_id] ||= []).push(m.user_id);
      }
      setMembersByDept(grouped);
    } else {
      setMembersByDept({});
    }
  }, [userId, company]);

  // Unread counts + last-activity per teammate, from a single recent window.
  const loadMessageMeta = useCallback(async () => {
    if (!userId) return;
    const [{ data: unreadRows }, { data: recent }] = await Promise.all([
      supabase.from("team_messages").select("from_user_id").eq("to_user_id", userId).eq("read", false),
      supabase
        .from("team_messages")
        .select("from_user_id, to_user_id, created_at")
        .or(`from_user_id.eq.${userId},to_user_id.eq.${userId}`)
        .order("created_at", { ascending: false })
        .limit(400),
    ]);
    const u: Record<string, number> = {};
    for (const r of (unreadRows || []) as { from_user_id: string }[]) u[r.from_user_id] = (u[r.from_user_id] || 0) + 1;
    setUnread(u);
    const last: Record<string, string> = {};
    for (const r of (recent || []) as { from_user_id: string; to_user_id: string; created_at: string }[]) {
      const other = r.from_user_id === userId ? r.to_user_id : r.from_user_id;
      if (!last[other]) last[other] = r.created_at;
    }
    setLastMsgAt(last);
  }, [userId]);

  useEffect(() => {
    loadTeam();
  }, [loadTeam]);

  useEffect(() => {
    loadMessageMeta();
    if (!userId) return;
    const channel = supabase
      .channel(`contacts-view-${userId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "team_messages", filter: `to_user_id=eq.${userId}` }, loadMessageMeta)
      .on("postgres_changes", { event: "*", schema: "public", table: "team_messages", filter: `from_user_id=eq.${userId}` }, loadMessageMeta)
      .on("postgres_changes", { event: "*", schema: "public", table: "department_members" }, loadTeam)
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [userId, loadMessageMeta, loadTeam]);

  // Presence: who's online right now.
  useEffect(() => {
    if (!userId) return;
    const presence = supabase.channel("online-users", { config: { presence: { key: userId } } });
    presence
      .on("presence", { event: "sync" }, () => {
        setOnlineUsers(new Set(Object.keys(presence.presenceState())));
      })
      .subscribe(async (status) => {
        if (status === "SUBSCRIBED") await presence.track({ user_id: userId, online_at: new Date().toISOString() });
      });
    return () => {
      supabase.removeChannel(presence);
    };
  }, [userId]);

  const unreadTotal = useMemo(() => Object.values(unread).reduce((a, b) => a + b, 0), [unread]);

  // ── Department admin actions ─────────────────────────────────────────────
  const withToast = async (p: PromiseLike<{ error: unknown }>, ok: string, fail: string) => {
    const { error } = await p;
    if (error) {
      toast({ title: "Error", description: fail, variant: "destructive" });
      return;
    }
    toast({ title: ok });
    loadTeam();
  };
  const assignToDept = (uid: string, deptId: string) =>
    withToast(supabase.from("department_members").insert({ user_id: uid, department_id: deptId }), "Assigned to department", "Failed to assign teammate");
  const removeFromDept = (uid: string, deptId: string) =>
    withToast(supabase.from("department_members").delete().eq("user_id", uid).eq("department_id", deptId), "Removed from department", "Failed to remove teammate");
  const moveToDept = async (uid: string, from: string, to: string) => {
    const { error } = await supabase.from("department_members").delete().eq("user_id", uid).eq("department_id", from);
    if (error) {
      toast({ title: "Error", description: "Failed to move teammate", variant: "destructive" });
      return;
    }
    await assignToDept(uid, to);
  };

  // ── Derived lists ────────────────────────────────────────────────────────
  const q = search.trim().toLowerCase();
  const filteredContacts = useMemo(
    () =>
      contacts.filter(
        (c) => !q || c.name.toLowerCase().includes(q) || c.phone_number.includes(search.trim()) || (c.email || "").toLowerCase().includes(q),
      ),
    [contacts, q, search],
  );

  const mateMatches = (m: Teammate) => !q || m.full_name.toLowerCase().includes(q) || m.email.toLowerCase().includes(q);
  const sortMates = (list: Teammate[]) =>
    [...list].sort((a, b) => {
      const ua = unread[a.id] ? 1 : 0;
      const ub = unread[b.id] ? 1 : 0;
      if (ua !== ub) return ub - ua;
      const la = lastMsgAt[a.id] || "";
      const lb = lastMsgAt[b.id] || "";
      if (la !== lb) return lb.localeCompare(la);
      return a.full_name.localeCompare(b.full_name);
    });
  const inAnyDept = new Set(Object.values(membersByDept).flat());
  const unassigned = sortMates(teammates.filter((m) => !inAnyDept.has(m.id) && mateMatches(m)));
  const deptGroups = departments
    .map((d) => ({
      dept: d,
      members: sortMates(teammates.filter((m) => (membersByDept[d.id] || []).includes(m.id) && mateMatches(m))),
    }))
    .filter((g) => g.members.length > 0);
  const visibleMates = unassigned.length + deptGroups.reduce((n, g) => n + g.members.length, 0);

  // ── Selection ────────────────────────────────────────────────────────────
  const pickContact = (c: UserContact) => {
    setSelectedContactId(c.id);
    if (compact) setDetailOpen(true);
  };
  const pickMate = (m: Teammate) => {
    setSelectedMateId(m.id);
    if (compact) setDetailOpen(true);
  };
  const switchMode = (m: Mode) => {
    setMode(m);
    setSearch("");
    setDetailOpen(false);
  };

  const handleDeleteContact = async (c: UserContact) => {
    const { error } = await deleteContact(c.id);
    if (error) {
      toast({ title: "Error", description: "Failed to delete contact", variant: "destructive" });
      return;
    }
    toast({ title: "Contact deleted" });
    setSelectedContactId(null);
    setDetailOpen(false);
  };

  /* ───────────────────────────── pieces ───────────────────────────── */

  const TitleTab = ({ id, label, count, dot }: { id: Mode; label: string; count: number; dot?: boolean }) => {
    const active = mode === id;
    return (
      <button
        type="button"
        onClick={() => switchMode(id)}
        className={cn(
          "relative flex items-center gap-1.5 pb-1 font-display font-semibold transition-colors",
          compact ? "text-sm" : "text-lg",
          active
            ? "text-foreground after:absolute after:inset-x-0 after:-bottom-0.5 after:h-0.5 after:rounded-full after:bg-primary"
            : "text-muted-foreground hover:text-foreground",
        )}
      >
        {label}
        <span className={cn("font-normal text-muted-foreground", compact ? "text-[10px]" : "text-xs")}>{count}</span>
        {dot && <span className="absolute -right-2 top-0 h-2 w-2 rounded-full bg-destructive" aria-label="Unread messages" />}
      </button>
    );
  };

  const contactRow = (c: UserContact) => {
    const active = selectedContactId === c.id && !compact;
    return (
      <button
        key={c.id}
        type="button"
        onClick={() => pickContact(c)}
        className={cn(
          "flex w-full items-center rounded-xl text-left transition-colors",
          compact ? "gap-2 px-2 py-1.5" : "gap-3 px-3 py-2.5",
          active ? "bg-accent shadow-sm" : "hover:bg-muted/50",
        )}
      >
        <Avatar className={compact ? "h-8 w-8" : "h-10 w-10"}>
          <AvatarFallback className={cn("font-semibold text-white", compact ? "text-[11px]" : "text-sm", contactColor(c.name))}>
            {contactInitials(c.name)}
          </AvatarFallback>
        </Avatar>
        <div className="min-w-0 flex-1">
          <p className={cn("truncate font-medium", compact && "text-xs")}>{c.name}</p>
          <p className={cn("truncate font-mono text-muted-foreground", compact ? "text-[10px]" : "text-xs")}>{c.phone_number}</p>
        </div>
        {onCall && (
          <span
            role="button"
            title="Call"
            className={cn(
              "flex shrink-0 items-center justify-center rounded-md text-success transition-colors hover:bg-success/10",
              compact ? "h-7 w-7" : "h-8 w-8",
            )}
            onClick={(e) => {
              e.stopPropagation();
              onCall(c.phone_number);
            }}
          >
            <Phone className="h-4 w-4" />
          </span>
        )}
      </button>
    );
  };

  const mateRow = (m: Teammate, deptId?: string, deptName?: string) => {
    const active = selectedMateId === m.id && !compact;
    const n = unread[m.id] || 0;
    const online = onlineUsers.has(m.id);
    const last = lastMsgAt[m.id];
    return (
      <div
        key={m.id}
        className={cn(
          "flex w-full items-center rounded-xl transition-colors",
          compact ? "gap-2 px-2 py-1.5" : "gap-3 px-3 py-2.5",
          active ? "bg-accent shadow-sm" : "hover:bg-muted/50",
        )}
      >
        <button type="button" onClick={() => pickMate(m)} className={cn("flex min-w-0 flex-1 items-center text-left", compact ? "gap-2" : "gap-3")}>
          <div className="relative shrink-0">
            <Avatar className={cn("border-2 border-background", compact ? "h-8 w-8" : "h-10 w-10")}>
              <AvatarFallback className={cn(compact ? "text-[11px]" : "text-sm", active ? "bg-primary/20 text-primary" : "bg-primary/10 text-primary")}>
                {initials(m.full_name)}
              </AvatarFallback>
            </Avatar>
            {online && (
              <span className={cn("absolute bottom-0 right-0 rounded-full border-2 border-card bg-success", compact ? "h-2 w-2" : "h-2.5 w-2.5")} />
            )}
            {n > 0 && (
              <span
                className={cn(
                  "absolute -right-1 -top-1 flex items-center justify-center rounded-full bg-destructive px-1 font-bold text-white",
                  compact ? "h-3.5 min-w-3.5 text-[9px]" : "h-4 min-w-4 text-[10px]",
                )}
                aria-label={`${n} unread`}
              >
                {n > 9 ? "9+" : n}
              </span>
            )}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <p className={cn("truncate font-medium", compact && "text-xs", n > 0 && "text-foreground")}>{m.full_name}</p>
              {last && (
                <span className={cn("ml-auto shrink-0 text-[10px]", n > 0 ? "font-medium text-destructive" : "text-muted-foreground")}>
                  {fmtLast(last)}
                </span>
              )}
            </div>
            <p className={cn("truncate text-muted-foreground", compact ? "text-[10px]" : "text-xs", phones[m.id] && "font-mono")}>
              {phones[m.id] || m.email}
            </p>
          </div>
        </button>
        {isCompanyAdmin && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="icon" variant="ghost" className={cn("shrink-0", compact ? "h-7 w-7" : "h-8 w-8")}>
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {deptId ? (
                <>
                  <DropdownMenuItem onClick={() => removeFromDept(m.id, deptId)}>
                    <X className="mr-2 h-4 w-4" /> Remove from {deptName}
                  </DropdownMenuItem>
                  {departments.filter((d) => d.id !== deptId).length > 0 && (
                    <DropdownMenuSub>
                      <DropdownMenuSubTrigger>
                        <ArrowRight className="mr-2 h-4 w-4" /> Move to department
                      </DropdownMenuSubTrigger>
                      <DropdownMenuSubContent>
                        {departments
                          .filter((d) => d.id !== deptId)
                          .map((d) => (
                            <DropdownMenuItem key={d.id} onClick={() => moveToDept(m.id, deptId, d.id)}>
                              {d.name}
                            </DropdownMenuItem>
                          ))}
                      </DropdownMenuSubContent>
                    </DropdownMenuSub>
                  )}
                </>
              ) : (
                departments.length > 0 && (
                  <DropdownMenuSub>
                    <DropdownMenuSubTrigger>
                      <ArrowRight className="mr-2 h-4 w-4" /> Assign to department
                    </DropdownMenuSubTrigger>
                    <DropdownMenuSubContent>
                      {departments.map((d) => (
                        <DropdownMenuItem key={d.id} onClick={() => assignToDept(m.id, d.id)}>
                          {d.name}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                )
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
    );
  };

  const sectionLabel = (text: string, icon?: React.ReactNode) => (
    <div className={cn("flex items-center gap-1.5 px-2 py-1 font-semibold uppercase tracking-wider text-muted-foreground", compact ? "text-[10px]" : "text-xs")}>
      {icon}
      {text}
    </div>
  );

  const list =
    mode === "contacts" ? (
      contactsLoading ? (
        <p className="py-10 text-center text-xs text-muted-foreground">Loading…</p>
      ) : filteredContacts.length === 0 ? (
        <div className="px-4 py-10 text-center">
          <p className={cn("font-medium", compact && "text-xs")}>{search ? "No contacts match your search" : "No contacts yet"}</p>
          {!search && (
            <p className={cn("mt-1 text-muted-foreground", compact ? "text-[11px]" : "text-sm")}>
              Add one here or from the mobile app — it shows up automatically.
            </p>
          )}
        </div>
      ) : (
        <div className={compact ? "space-y-0.5 p-2" : "space-y-1 p-3"}>{filteredContacts.map(contactRow)}</div>
      )
    ) : visibleMates === 0 ? (
      <div className="px-4 py-10 text-center">
        <p className={cn("font-medium", compact && "text-xs")}>{search ? "No teammates match your search" : "No teammates yet"}</p>
      </div>
    ) : (
      <div className={compact ? "space-y-3 p-2" : "space-y-4 p-3"}>
        {unassigned.length > 0 && (
          <div>
            {sectionLabel(departments.length ? "Unassigned" : "All teammates")}
            <div className="space-y-0.5">{unassigned.map((m) => mateRow(m))}</div>
          </div>
        )}
        {deptGroups.map(({ dept, members }) => (
          <div key={dept.id}>
            {sectionLabel(dept.name, <Building2 className="h-3 w-3" />)}
            <div className="space-y-0.5">{members.map((m) => mateRow(m, dept.id, dept.name))}</div>
          </div>
        ))}
      </div>
    );

  const leftHeader = (
    <div className={cn("shrink-0 border-b border-border", compact ? "space-y-2 px-3 py-2" : "space-y-3 p-4")}>
      <div className={cn("flex items-center", compact ? "gap-3" : "gap-5")}>
        <TitleTab id="contacts" label="Contacts" count={contacts.length} />
        <TitleTab id="teammates" label="Teammates" count={teammates.length} dot={unreadTotal > 0} />
        {mode === "contacts" && (
          <Button
            size="icon"
            variant="outline"
            className={cn("ml-auto shrink-0", compact ? "h-7 w-7" : "h-8 w-8")}
            title="Add contact"
            onClick={() => setAddOpen(true)}
          >
            <Plus className="h-4 w-4" />
          </Button>
        )}
      </div>
      <div className="relative">
        <Search className={cn("absolute top-1/2 -translate-y-1/2 text-muted-foreground", compact ? "left-2.5 h-3.5 w-3.5" : "left-3 h-4 w-4")} />
        <Input
          placeholder={mode === "contacts" ? "Search contacts…" : "Search teammates…"}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className={cn("bg-background", compact ? "h-8 pl-8 text-xs" : "pl-9")}
        />
      </div>
    </div>
  );

  const contactDetail = selectedContact ? (
    <div className="flex h-full min-h-0 flex-col bg-background-subtle">
      <div className={cn("border-b border-border bg-card", compact ? "px-3 py-2" : "p-6")}>
        <div className={cn("flex items-center", compact ? "gap-3" : "gap-4")}>
          {compact && (
            <Button size="icon" variant="ghost" className="h-7 w-7 -ml-1 shrink-0" onClick={() => setDetailOpen(false)} title="Back">
              <ChevronLeft className="h-4 w-4" />
            </Button>
          )}
          <Avatar className={cn("border-4 border-background shadow-md shrink-0", compact ? "h-11 w-11" : "h-16 w-16")}>
            <AvatarFallback className={cn("font-semibold text-white", compact ? "text-sm" : "text-xl", contactColor(selectedContact.name))}>
              {contactInitials(selectedContact.name)}
            </AvatarFallback>
          </Avatar>
          <div className="min-w-0 flex-1">
            <h2 className={cn("truncate font-display font-semibold", compact ? "text-sm" : "text-2xl")}>{selectedContact.name}</h2>
            <div className={cn("mt-1 flex items-center gap-2", compact && "flex-wrap")}>
              <span className={cn("font-mono text-muted-foreground", compact ? "text-[11px]" : "text-sm")}>{selectedContact.phone_number}</span>
              {onCall && (
                <Button
                  size="sm"
                  className={cn("bg-success text-success-foreground hover:bg-success/90", compact && "h-7 px-2 text-xs")}
                  onClick={() => onCall(selectedContact.phone_number)}
                >
                  <Phone className={cn("mr-1.5", compact ? "h-3.5 w-3.5" : "h-4 w-4")} />
                  Call
                </Button>
              )}
            </div>
          </div>
        </div>
      </div>
      <div className={cn("flex-1 overflow-auto", compact ? "space-y-3 p-3" : "space-y-4 p-6")}>
        <Card>
          <CardContent className={compact ? "p-3" : "pt-6"}>
            {!compact && <h3 className="mb-4 font-display text-lg font-semibold">Contact information</h3>}
            <div className="divide-y divide-border">
              {[
                { icon: Phone, label: "Phone", value: selectedContact.phone_number, mono: true },
                { icon: Mail, label: "Email", value: selectedContact.email || "—", mono: false },
                {
                  icon: User,
                  label: "Added",
                  value: selectedContact.created_at ? format(new Date(selectedContact.created_at), "d MMM yyyy") : "—",
                  mono: false,
                },
              ].map((row) => (
                <div key={row.label} className={cn("flex items-center justify-between gap-4", compact ? "py-2" : "py-3")}>
                  <span className={cn("flex items-center gap-2 text-muted-foreground", compact ? "text-xs" : "text-sm")}>
                    <row.icon className="h-3.5 w-3.5" /> {row.label}
                  </span>
                  <span className={cn("truncate font-medium", compact ? "text-xs" : "text-sm", row.mono && "font-mono")}>{row.value}</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
        <Button
          variant="outline"
          size="sm"
          className="gap-1.5 text-destructive hover:bg-destructive/10 hover:text-destructive"
          onClick={() => handleDeleteContact(selectedContact)}
        >
          <Trash2 className="h-4 w-4" /> Delete contact
        </Button>
      </div>
    </div>
  ) : (
    <div className="flex h-full items-center justify-center bg-background-subtle">
      <div className="text-center">
        <div className="mx-auto mb-4 flex h-20 w-20 items-center justify-center rounded-full bg-accent">
          <Users className="h-10 w-10 text-accent-foreground" />
        </div>
        <h3 className="mb-1 font-display text-lg font-semibold">Select a contact</h3>
        <p className="text-sm text-muted-foreground">Choose a contact from the list to see their details</p>
      </div>
    </div>
  );

  const conversation = selectedMate ? (
    <TeamConversation
      userId={userId}
      member={{
        id: selectedMate.id,
        full_name: selectedMate.full_name,
        email: selectedMate.email,
        phone: phones[selectedMate.id] || null,
        isOnline: onlineUsers.has(selectedMate.id),
      }}
      compact={compact}
      onBack={compact ? () => setDetailOpen(false) : undefined}
      onCall={onCall}
      onMessagesRead={() => {
        loadMessageMeta();
        onMessagesRead?.();
      }}
    />
  ) : (
    <div className="flex h-full items-center justify-center bg-background-subtle">
      <div className="text-center">
        <div className="mx-auto mb-4 flex h-20 w-20 items-center justify-center rounded-full bg-accent">
          <MessageCircle className="h-10 w-10 text-accent-foreground" />
        </div>
        <h3 className="mb-1 font-display text-lg font-semibold">Your teammates</h3>
        <p className="max-w-sm text-sm text-muted-foreground">
          Pick a teammate to open your conversation with them
        </p>
      </div>
    </div>
  );

  const addDialog = <AddContactDialog open={addOpen} onOpenChange={setAddOpen} onAdd={addContact} compact={compact} />;

  /* ───────────────────────────── layouts ───────────────────────────── */

  if (compact) {
    const showDetail = detailOpen && (mode === "contacts" ? !!selectedContact : !!selectedMate);
    return (
      <div className="flex h-full min-h-0 flex-col">
        {showDetail ? (
          mode === "contacts" ? contactDetail : conversation
        ) : (
          <>
            {leftHeader}
            <ScrollArea className="min-h-0 flex-1">{list}</ScrollArea>
          </>
        )}
        {addDialog}
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0">
      <aside className="flex w-80 min-w-[320px] max-w-[320px] flex-col border-r border-border bg-card">
        {leftHeader}
        <ScrollArea className="min-h-0 flex-1">{list}</ScrollArea>
      </aside>
      <main className="flex min-w-0 flex-1 flex-col">{mode === "contacts" ? contactDetail : conversation}</main>
      {addDialog}
    </div>
  );
};

export default ContactsView;
