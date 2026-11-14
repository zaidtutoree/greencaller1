import { useCallback, useEffect, useState } from "react";
import { BarChart3, Building2, History, Mail, Mic, NotebookPen, Phone, ShieldCheck } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/hooks/use-toast";
import CallHistory from "@/components/CallHistory";
import { CallAnalytics, type AnalyticsCall } from "./CallAnalytics";
import { RecordingsList } from "./RecordingsList";
import { NotesList } from "./NotesList";

export interface ControlUser {
  id: string;
  full_name: string | null;
  email: string | null;
  account_type: string | null;
  is_company_admin: boolean | null;
  phone?: string | null;
}

export interface ControlDepartment {
  id: string;
  name: string;
  description?: string | null;
}

interface ControlUserDetailProps {
  user: ControlUser;
  departments: ControlDepartment[];
  /** Department ids this user currently belongs to. */
  memberDeptIds: string[];
  /** Called after a membership change so the parent can refresh its cache. */
  onMembershipChanged: () => void;
}

const initials = (name?: string | null) =>
  (name || "?")
    .split(" ")
    .map((n) => n[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);

/**
 * One teammate, in depth: analytics, calls, recordings, notes and department
 * membership. Everything is scoped to `user.id`; the RLS policies added for
 * company admins are what make the notes/departments reads possible.
 */
export const ControlUserDetail = ({ user, departments, memberDeptIds, onMembershipChanged }: ControlUserDetailProps) => {
  const { toast } = useToast();
  const [calls, setCalls] = useState<AnalyticsCall[]>([]);
  const [callsLoading, setCallsLoading] = useState(true);
  const [busyDept, setBusyDept] = useState<string | null>(null);

  const loadCalls = useCallback(async () => {
    const { data, error } = await supabase
      .from("call_history")
      .select("direction, duration, status, created_at")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .limit(2000);
    if (error) console.error("ControlUserDetail calls error:", error);
    setCalls((data as AnalyticsCall[]) || []);
    setCallsLoading(false);
  }, [user.id]);

  useEffect(() => {
    setCallsLoading(true);
    loadCalls();
  }, [loadCalls]);

  const toggleDepartment = async (dept: ControlDepartment, member: boolean) => {
    setBusyDept(dept.id);
    try {
      if (member) {
        const { error } = await supabase
          .from("department_members")
          .delete()
          .eq("department_id", dept.id)
          .eq("user_id", user.id);
        if (error) throw error;
        toast({ title: `Removed from ${dept.name}` });
      } else {
        const { error } = await supabase
          .from("department_members")
          .insert({ department_id: dept.id, user_id: user.id });
        if (error) throw error;
        toast({ title: `Added to ${dept.name}` });
      }
      onMembershipChanged();
    } catch (e: any) {
      toast({
        title: "Could not update department",
        description: e?.message || "You may not have permission to change this department.",
        variant: "destructive",
      });
    } finally {
      setBusyDept(null);
    }
  };

  const memberDepts = departments.filter((d) => memberDeptIds.includes(d.id));

  return (
    <div className="space-y-6">
      {/* Header */}
      <Card className="shadow-none">
        <CardContent className="flex flex-wrap items-center gap-4 p-5">
          <Avatar className="h-14 w-14 border-2 border-background shadow-sm">
            <AvatarFallback className="bg-primary/10 text-lg font-semibold text-primary">
              {initials(user.full_name)}
            </AvatarFallback>
          </Avatar>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="truncate font-display text-xl font-semibold">{user.full_name || "Unnamed user"}</h2>
              {user.is_company_admin && (
                <Badge variant="secondary" className="gap-1 font-normal">
                  <ShieldCheck className="h-3 w-3" /> Company admin
                </Badge>
              )}
              {user.account_type && (
                <Badge variant="outline" className="font-normal capitalize">
                  {user.account_type}
                </Badge>
              )}
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
              {user.email && (
                <span className="flex items-center gap-1.5">
                  <Mail className="h-3.5 w-3.5" /> {user.email}
                </span>
              )}
              <span className="flex items-center gap-1.5 font-mono">
                <Phone className="h-3.5 w-3.5" /> {user.phone || "No number assigned"}
              </span>
            </div>
            {memberDepts.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {memberDepts.map((d) => (
                  <Badge key={d.id} variant="outline" className="gap-1 font-normal">
                    <Building2 className="h-3 w-3" /> {d.name}
                  </Badge>
                ))}
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      <Tabs defaultValue="analytics" className="space-y-4">
        <TabsList className="h-auto flex-wrap justify-start gap-1 bg-muted/60 p-1">
          <TabsTrigger value="analytics" className="gap-1.5">
            <BarChart3 className="h-3.5 w-3.5" /> Analytics
          </TabsTrigger>
          <TabsTrigger value="calls" className="gap-1.5">
            <History className="h-3.5 w-3.5" /> Calls
          </TabsTrigger>
          <TabsTrigger value="recordings" className="gap-1.5">
            <Mic className="h-3.5 w-3.5" /> Recordings
          </TabsTrigger>
          <TabsTrigger value="notes" className="gap-1.5">
            <NotebookPen className="h-3.5 w-3.5" /> Notes
          </TabsTrigger>
          <TabsTrigger value="departments" className="gap-1.5">
            <Building2 className="h-3.5 w-3.5" /> Departments
          </TabsTrigger>
        </TabsList>

        <TabsContent value="analytics">
          {callsLoading ? (
            <p className="py-8 text-center text-sm text-muted-foreground">Loading analytics…</p>
          ) : (
            <CallAnalytics calls={calls} emptyHint="This user hasn't made or received any calls yet." />
          )}
        </TabsContent>

        <TabsContent value="calls">
          {/* The same list the user sees in their own Call History, incl. AI summaries. */}
          <div className="[&>div]:max-w-none">
            <CallHistory userId={user.id} accountType="enterprise" />
          </div>
        </TabsContent>

        <TabsContent value="recordings">
          <RecordingsList userId={user.id} />
        </TabsContent>

        <TabsContent value="notes">
          <NotesList userId={user.id} />
        </TabsContent>

        <TabsContent value="departments">
          {departments.length === 0 ? (
            <div className="py-10 text-center text-muted-foreground">
              <Building2 className="mx-auto mb-2 h-8 w-8 opacity-40" />
              <p className="text-sm">Your company has no departments yet.</p>
              <p className="mt-1 text-xs">Departments are created from the admin console.</p>
            </div>
          ) : (
            <div className="space-y-2">
              {departments.map((d) => {
                const member = memberDeptIds.includes(d.id);
                return (
                  <div
                    key={d.id}
                    className="flex items-center justify-between gap-3 rounded-lg border bg-card px-4 py-3"
                  >
                    <div className="min-w-0">
                      <div className="text-sm font-medium">{d.name}</div>
                      {d.description && (
                        <div className="truncate text-xs text-muted-foreground">{d.description}</div>
                      )}
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <span className="text-xs text-muted-foreground">{member ? "Member" : "Not a member"}</span>
                      <Switch
                        checked={member}
                        disabled={busyDept !== null}
                        onCheckedChange={() => toggleDepartment(d, member)}
                        aria-label={member ? `Remove from ${d.name}` : `Add to ${d.name}`}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
};

export default ControlUserDetail;
