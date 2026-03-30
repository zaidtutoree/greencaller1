import { useEffect, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { Phone, PhoneMissed, MessageSquare, Voicemail, Mic, TrendingUp, TrendingDown, Activity, AlertTriangle, CreditCard } from "lucide-react";
import { cn } from "@/lib/utils";

interface Stats {
  totalCalls: number;
  totalMessages: number;
  totalVoicemails: number;
  totalRecordings: number;
  missedCalls: number;
  recentCalls: number;
  recentVoicemails: number;
  businessNumber: string;
  callsTrend: number;
  voicemailsTrend: number;
}

interface HomeProps {
  userId?: string;
  accountType?: string;
}

const Home = ({ userId, accountType }: HomeProps) => {
  const [subscriptionInfo, setSubscriptionInfo] = useState<{
    status: string | null;
    checkoutUrl: string | null;
    isLeadUser: boolean;
  }>({ status: null, checkoutUrl: null, isLeadUser: false });

  useEffect(() => {
    const fetchSubInfo = async () => {
      if (!userId) return;

      const { data: profile } = await supabase
        .from("profiles")
        .select("subscription_status, active_subscription_id")
        .eq("id", userId)
        .single();

      if (!profile || !profile.subscription_status || profile.subscription_status === "none") return;

      // Check if user is lead user and get checkout_url
      if (profile.active_subscription_id) {
        const { data: sub } = await supabase
          .from("subscriptions")
          .select("lead_user_id, checkout_url, status")
          .eq("id", profile.active_subscription_id)
          .single();

        setSubscriptionInfo({
          status: profile.subscription_status,
          checkoutUrl: sub?.checkout_url || null,
          isLeadUser: sub?.lead_user_id === userId,
        });
      } else {
        setSubscriptionInfo({
          status: profile.subscription_status,
          checkoutUrl: null,
          isLeadUser: false,
        });
      }
    };
    fetchSubInfo();
  }, [userId]);

  const [stats, setStats] = useState<Stats>({
    totalCalls: 0,
    totalMessages: 0,
    totalVoicemails: 0,
    totalRecordings: 0,
    missedCalls: 0,
    recentCalls: 0,
    recentVoicemails: 0,
    businessNumber: "",
    callsTrend: 0,
    voicemailsTrend: 0,
  });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchStats = async () => {
      if (!userId) {
        setLoading(false);
        return;
      }

      try {
        // Get user's assigned phone number
        const phoneRes = await supabase
          .from("phone_numbers")
          .select("phone_number")
          .eq("assigned_to", userId)
          .eq("is_active", true)
          .limit(1)
          .maybeSingle();

        const userPhoneNumber = phoneRes.data?.phone_number;

        // If user has no assigned number, show empty stats
        if (!userPhoneNumber) {
          setStats({
            totalCalls: 0,
            totalMessages: 0,
            totalVoicemails: 0,
            totalRecordings: 0,
            missedCalls: 0,
            recentCalls: 0,
            recentVoicemails: 0,
            businessNumber: "Not assigned",
            callsTrend: 0,
            voicemailsTrend: 0,
          });
          setLoading(false);
          return;
        }

        // Fetch stats filtered by user_id
        const [callsRes, messagesRes, voicemailsRes, recordingsRes, missedCallsRes] = await Promise.all([
          supabase.from("call_history").select("*", { count: "exact", head: true }).eq("user_id", userId),
          supabase.from("messages").select("*", { count: "exact", head: true }).eq("user_id", userId),
          supabase.from("voicemails").select("*", { count: "exact", head: true }).eq("user_id", userId),
          supabase.from("call_recordings").select("*", { count: "exact", head: true }).eq("user_id", userId),
          supabase.from("call_history").select("*", { count: "exact", head: true }).eq("user_id", userId).eq("direction", "inbound").in("status", ["no-answer", "busy", "failed", "missed", "ringing"]),
        ]);

        const sevenDaysAgo = new Date();
        sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
        
        const fourteenDaysAgo = new Date();
        fourteenDaysAgo.setDate(fourteenDaysAgo.getDate() - 14);

        const [recentCallsRes, recentVoicemailsRes, prevCallsRes, prevVoicemailsRes] = await Promise.all([
          supabase
            .from("call_history")
            .select("*", { count: "exact", head: true })
            .eq("user_id", userId)
            .gte("created_at", sevenDaysAgo.toISOString()),
          supabase
            .from("voicemails")
            .select("*", { count: "exact", head: true })
            .eq("user_id", userId)
            .gte("created_at", sevenDaysAgo.toISOString()),
          supabase
            .from("call_history")
            .select("*", { count: "exact", head: true })
            .eq("user_id", userId)
            .gte("created_at", fourteenDaysAgo.toISOString())
            .lt("created_at", sevenDaysAgo.toISOString()),
          supabase
            .from("voicemails")
            .select("*", { count: "exact", head: true })
            .eq("user_id", userId)
            .gte("created_at", fourteenDaysAgo.toISOString())
            .lt("created_at", sevenDaysAgo.toISOString()),
        ]);

        const recentCalls = recentCallsRes.count || 0;
        const prevCalls = prevCallsRes.count || 0;
        const recentVoicemails = recentVoicemailsRes.count || 0;
        const prevVoicemails = prevVoicemailsRes.count || 0;

        const callsTrend = prevCalls > 0 ? Math.round(((recentCalls - prevCalls) / prevCalls) * 100) : 0;
        const voicemailsTrend = prevVoicemails > 0 ? Math.round(((recentVoicemails - prevVoicemails) / prevVoicemails) * 100) : 0;

        setStats({
          totalCalls: callsRes.count || 0,
          totalMessages: messagesRes.count || 0,
          totalVoicemails: voicemailsRes.count || 0,
          totalRecordings: recordingsRes.count || 0,
          missedCalls: missedCallsRes.count || 0,
          recentCalls,
          recentVoicemails,
          businessNumber: userPhoneNumber,
          callsTrend,
          voicemailsTrend,
        });
      } catch (error) {
        console.error("Error fetching stats:", error);
      } finally {
        setLoading(false);
      }
    };

    fetchStats();
  }, [userId]);

  const statCards = [
    {
      title: "Total Calls",
      value: stats.totalCalls,
      icon: Phone,
      description: `${stats.recentCalls} this week`,
      trend: stats.callsTrend,
      color: "primary",
      bgColor: "bg-primary/10",
      iconColor: "text-primary",
    },
    {
      title: "Messages",
      value: stats.totalMessages,
      icon: MessageSquare,
      description: "Total sent & received",
      color: "info",
      bgColor: "bg-info/10",
      iconColor: "text-info",
    },
    {
      title: "Voicemails",
      value: stats.totalVoicemails,
      icon: Voicemail,
      description: "Total received",
      color: "warning",
      bgColor: "bg-warning/10",
      iconColor: "text-warning",
    },
    ...(accountType === "premium" || accountType === "enterprise"
      ? [{
          title: "Recordings",
          value: stats.totalRecordings,
          icon: Mic,
          description: "Total saved",
          color: "success",
          bgColor: "bg-success/10",
          iconColor: "text-success",
        }]
      : [{
          title: "Missed Calls",
          value: stats.missedCalls,
          icon: PhoneMissed,
          description: "Unanswered inbound",
          color: "destructive",
          bgColor: "bg-destructive/10",
          iconColor: "text-destructive",
        }]),
  ];

  if (loading) {
    return (
      <div className="p-6 space-y-6">
        <div className="space-y-2">
          <div className="h-8 w-48 skeleton" />
          <div className="h-4 w-72 skeleton" />
        </div>
        <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-4 stagger-animation">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="h-36 skeleton rounded-xl" />
          ))}
        </div>
      </div>
    );
  }

  const showSubscriptionBanner = subscriptionInfo.status &&
    ["none", "invite_sent", "cancelled", "past_due"].includes(subscriptionInfo.status);

  return (
    <div className="p-6 space-y-8">
      {/* Subscription Banner */}
      {showSubscriptionBanner && (
        <Card className="border-warning/30 bg-warning/5">
          <CardContent className="flex items-center justify-between py-4">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-warning/10">
                <AlertTriangle className="h-5 w-5 text-warning" />
              </div>
              <div>
                <p className="font-medium">
                  {subscriptionInfo.status === "past_due"
                    ? "Payment past due"
                    : subscriptionInfo.status === "cancelled"
                    ? "Subscription cancelled"
                    : "No active subscription"}
                </p>
                <p className="text-sm text-muted-foreground">
                  {subscriptionInfo.isLeadUser
                    ? subscriptionInfo.status === "invite_sent"
                      ? "Complete your subscription setup to enable calling."
                      : subscriptionInfo.status === "past_due"
                      ? "Please update your payment method to continue using the service."
                      : "Contact your administrator to set up a subscription."
                    : "Your account access depends on your organisation's subscription."}
                </p>
              </div>
            </div>
            {subscriptionInfo.isLeadUser && subscriptionInfo.status === "invite_sent" && subscriptionInfo.checkoutUrl && (
              <Button
                onClick={() => window.open(subscriptionInfo.checkoutUrl!, "_blank")}
                className="shrink-0"
              >
                <CreditCard className="h-4 w-4 mr-2" />
                Subscribe Now
              </Button>
            )}
          </CardContent>
        </Card>
      )}

      {/* Welcome Section */}
      <div className="space-y-1">
        <div className="flex items-center gap-3">
          <div className="h-2 w-2 rounded-full bg-success animate-pulse" />
          <span className="text-sm text-muted-foreground">System Online</span>
        </div>
        <p className="text-muted-foreground">
          Business Number: <span className="font-mono font-medium text-foreground">{stats.businessNumber}</span>
        </p>
      </div>

      {/* Stats Grid */}
      <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-4 stagger-animation">
        {statCards.map((stat) => {
          const Icon = stat.icon;
          const hasTrend = stat.trend !== undefined && stat.trend !== 0;
          const isPositive = stat.trend > 0;

          return (
            <Card key={stat.title} className="relative overflow-hidden group">
              <div className="absolute top-0 right-0 w-32 h-32 -mr-8 -mt-8 opacity-5 group-hover:opacity-10 transition-opacity">
                <Icon className="w-full h-full" />
              </div>
              <CardHeader className="flex flex-row items-center justify-between pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">
                  {stat.title}
                </CardTitle>
                <div className={cn("p-2 rounded-lg", stat.bgColor)}>
                  <Icon className={cn("h-4 w-4", stat.iconColor)} />
                </div>
              </CardHeader>
              <CardContent>
                <div className="flex items-end justify-between">
                  <div>
                    <p className="text-3xl font-display font-bold tracking-tight animate-number">
                      {stat.value.toLocaleString()}
                    </p>
                    <p className="text-xs text-muted-foreground mt-1">{stat.description}</p>
                  </div>
                  {hasTrend && (
                    <div className={cn(
                      "flex items-center gap-0.5 text-xs font-medium px-2 py-1 rounded-full",
                      isPositive ? "bg-success-muted text-success" : "bg-destructive/10 text-destructive"
                    )}>
                      {isPositive ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
                      <span>{Math.abs(stat.trend)}%</span>
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* Activity Section */}
      <Card className="max-w-2xl">
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-lg">Recent Activity</CardTitle>
              <CardDescription>Last 7 days summary</CardDescription>
            </div>
            <div className="p-2 rounded-lg bg-accent">
              <Activity className="w-4 h-4 text-accent-foreground" />
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between py-3 border-b border-border">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-primary/10">
                <Phone className="w-4 h-4 text-primary" />
              </div>
              <div>
                <p className="font-medium">Calls</p>
                <p className="text-xs text-muted-foreground">Inbound & Outbound</p>
              </div>
            </div>
            <div className="text-right">
              <p className="text-xl font-display font-semibold">{stats.recentCalls}</p>
              <p className="text-xs text-muted-foreground">this week</p>
            </div>
          </div>
          <div className="flex items-center justify-between py-3">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-warning/10">
                <Voicemail className="w-4 h-4 text-warning" />
              </div>
              <div>
                <p className="font-medium">Voicemails</p>
                <p className="text-xs text-muted-foreground">New received</p>
              </div>
            </div>
            <div className="text-right">
              <p className="text-xl font-display font-semibold">{stats.recentVoicemails}</p>
              <p className="text-xs text-muted-foreground">this week</p>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
};

export default Home;
