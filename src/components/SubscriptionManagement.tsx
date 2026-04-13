import { useState, useEffect, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import {
  CreditCard,
  Plus,
  Eye,
  XCircle,
  RefreshCw,
  Search,
  Crown,
  Users,
  TrendingUp,
  Loader2,
} from "lucide-react";
import { Progress } from "@/components/ui/progress";

interface UserProfile {
  id: string;
  full_name: string;
  email: string;
}

interface SubscriptionUser {
  user_id: string;
  joined_at: string;
  user: UserProfile;
}

interface Subscription {
  id: string;
  created_at: string;
  trial_period_days: number;
  amount_pence: number;
  status: string;
  lead_user_id: string;
  invite_email_to: string;
  invite_email_from: string;
  invite_sent_at: string | null;
  checkout_url: string | null;
  stripe_subscription_id: string | null;
  lead_user: UserProfile;
  subscription_users: SubscriptionUser[];
}

interface UsageData {
  user_id: string;
  user: UserProfile;
  outbound_mins: number;
  inbound_mins: number;
  outbound_limit: number;
  inbound_limit: number;
  outbound_overage: number;
  inbound_overage: number;
  total_overage_mins: number;
  overage_charge_pence: number;
}

const statusColors: Record<string, string> = {
  draft: "bg-muted text-muted-foreground",
  invite_sent: "bg-blue-500/10 text-blue-500",
  active: "bg-green-500/10 text-green-500",
  trialing: "bg-purple-500/10 text-purple-500",
  past_due: "bg-orange-500/10 text-orange-500",
  cancelled: "bg-red-500/10 text-red-500",
};

const SubscriptionManagement = () => {
  const { toast } = useToast();
  const [subscriptions, setSubscriptions] = useState<Subscription[]>([]);
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [selectedSub, setSelectedSub] = useState<Subscription | null>(null);
  const [usageData, setUsageData] = useState<UsageData[]>([]);
  const [usageLoading, setUsageLoading] = useState(false);
  const [creating, setCreating] = useState(false);

  // Create form state
  const [allUsers, setAllUsers] = useState<UserProfile[]>([]);
  const [selectedUserIds, setSelectedUserIds] = useState<string[]>([]);
  const [leadUserId, setLeadUserId] = useState("");
  const [trialDays, setTrialDays] = useState(14);
  const [trialUnit, setTrialUnit] = useState<"days" | "hours">("days");
  const [amountPounds, setAmountPounds] = useState("");
  const [inviteEmailTo, setInviteEmailTo] = useState("");
  const [inviteEmailFrom, setInviteEmailFrom] = useState("");
  const [outboundMinsLimit, setOutboundMinsLimit] = useState(500);
  const [inboundMinsLimit, setInboundMinsLimit] = useState(1000);
  const [userSearch, setUserSearch] = useState("");

  const getAdminToken = () => localStorage.getItem("admin_session_token") || "";

  const fetchSubscriptions = useCallback(async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase.functions.invoke("admin-subscription", {
        body: { action: "list" },
        headers: { "x-admin-token": getAdminToken() },
      });

      if (error) throw error;
      if (data?.success) {
        setSubscriptions(Array.isArray(data.data) ? data.data : []);
      }
    } catch (err: any) {
      toast({ title: "Error loading subscriptions", description: err.message, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  const fetchUsers = useCallback(async () => {
    const { data } = await supabase
      .from("profiles")
      .select("id, full_name, email")
      .order("full_name");
    if (data) setAllUsers(data);
  }, []);

  useEffect(() => {
    fetchSubscriptions();
    fetchUsers();
  }, [fetchSubscriptions, fetchUsers]);

  const fetchUsage = async (subscriptionId: string) => {
    setUsageLoading(true);
    try {
      const { data, error } = await supabase.functions.invoke("admin-subscription", {
        body: { action: "usage", subscriptionId },
        headers: { "x-admin-token": getAdminToken() },
      });
      if (error) throw error;
      if (data?.success) setUsageData(data.data || []);
    } catch (err: any) {
      toast({ title: "Error loading usage", description: err.message, variant: "destructive" });
    } finally {
      setUsageLoading(false);
    }
  };

  const handleViewDetails = (sub: Subscription) => {
    setSelectedSub(sub);
    setDetailsOpen(true);
    fetchUsage(sub.id);
  };

  const handleCancel = async (subscriptionId: string) => {
    if (!confirm("Are you sure you want to cancel this subscription? All users will lose call access.")) return;

    try {
      const { data, error } = await supabase.functions.invoke("admin-subscription", {
        body: { action: "cancel", subscriptionId },
        headers: { "x-admin-token": getAdminToken() },
      });
      if (error) throw error;
      toast({ title: "Subscription cancelled" });
      fetchSubscriptions();
    } catch (err: any) {
      toast({ title: "Error cancelling", description: err.message, variant: "destructive" });
    }
  };

  const handleCreate = async () => {
    if (!selectedUserIds.length || !leadUserId || !amountPounds || !inviteEmailTo || !inviteEmailFrom) {
      toast({ title: "Please fill all required fields", variant: "destructive" });
      return;
    }

    setCreating(true);
    try {
      const { data, error } = await supabase.functions.invoke("admin-subscription", {
        body: {
          action: "create",
          userIds: selectedUserIds,
          leadUserId,
          trialPeriodDays: trialUnit === "days" ? trialDays : 0,
          trialPeriodHours: trialUnit === "hours" ? trialDays : 0,
          amountPence: Math.round(parseFloat(amountPounds) * 100),
          inviteEmailTo,
          inviteEmailFrom,
          outboundMinsLimit,
          inboundMinsLimit,
        },
        headers: { "x-admin-token": getAdminToken() },
      });

      if (error) throw error;
      if (!data?.success) throw new Error(data?.error || "Failed to create subscription");

      toast({ title: "Subscription created & invite sent" });
      setCreateOpen(false);
      resetForm();
      fetchSubscriptions();
    } catch (err: any) {
      toast({ title: "Error creating subscription", description: err.message, variant: "destructive" });
    } finally {
      setCreating(false);
    }
  };

  const resetForm = () => {
    setSelectedUserIds([]);
    setLeadUserId("");
    setTrialDays(14);
    setTrialUnit("days");
    setAmountPounds("");
    setInviteEmailTo("");
    setInviteEmailFrom("");
    setOutboundMinsLimit(500);
    setInboundMinsLimit(1000);
    setUserSearch("");
  };

  const toggleUser = (userId: string) => {
    setSelectedUserIds((prev) =>
      prev.includes(userId) ? prev.filter((id) => id !== userId) : [...prev, userId]
    );
    // If removing lead user, clear lead
    if (leadUserId === userId && selectedUserIds.includes(userId)) {
      setLeadUserId("");
    }
  };

  const filteredUsers = allUsers.filter(
    (u) =>
      u.full_name.toLowerCase().includes(userSearch.toLowerCase()) ||
      u.email.toLowerCase().includes(userSearch.toLowerCase())
  );

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <div className="flex items-center gap-2">
            <CreditCard className="h-5 w-5 text-primary" />
            <CardTitle>Subscriptions</CardTitle>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={fetchSubscriptions}>
              <RefreshCw className="h-4 w-4 mr-1" />
              Refresh
            </Button>
            <Dialog open={createOpen} onOpenChange={setCreateOpen}>
              <DialogTrigger asChild>
                <Button size="sm">
                  <Plus className="h-4 w-4 mr-1" />
                  Create Subscription
                </Button>
              </DialogTrigger>
              <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
                <DialogHeader>
                  <DialogTitle>Create Subscription</DialogTitle>
                  <DialogDescription>
                    Set up a new subscription, create Stripe billing, and send an invitation email.
                  </DialogDescription>
                </DialogHeader>

                <div className="space-y-5 py-4">
                  {/* User Selection */}
                  <div className="space-y-2">
                    <Label className="font-semibold">Assign Users</Label>
                    <div className="relative">
                      <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                      <Input
                        placeholder="Search users..."
                        value={userSearch}
                        onChange={(e) => setUserSearch(e.target.value)}
                        className="pl-9"
                      />
                    </div>
                    <div className="border rounded-lg max-h-48 overflow-y-auto">
                      {filteredUsers.map((user) => {
                        const isSelected = selectedUserIds.includes(user.id);
                        const isLead = leadUserId === user.id;
                        return (
                          <div
                            key={user.id}
                            className={`flex items-center justify-between px-3 py-2 hover:bg-muted/50 cursor-pointer border-b last:border-b-0 ${
                              isSelected ? "bg-primary/5" : ""
                            }`}
                            onClick={() => toggleUser(user.id)}
                          >
                            <div className="flex items-center gap-2">
                              <input
                                type="checkbox"
                                checked={isSelected}
                                onChange={() => {}}
                                className="rounded"
                              />
                              <div>
                                <p className="text-sm font-medium">{user.full_name}</p>
                                <p className="text-xs text-muted-foreground">{user.email}</p>
                              </div>
                            </div>
                            {isSelected && (
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setLeadUserId(user.id);
                                }}
                                className={`text-xs px-2 py-1 rounded-full ${
                                  isLead
                                    ? "bg-primary text-primary-foreground"
                                    : "bg-muted text-muted-foreground hover:bg-primary/20"
                                }`}
                              >
                                {isLead ? (
                                  <span className="flex items-center gap-1">
                                    <Crown className="h-3 w-3" /> Lead
                                  </span>
                                ) : (
                                  "Set as Lead"
                                )}
                              </button>
                            )}
                          </div>
                        );
                      })}
                    </div>
                    {selectedUserIds.length > 0 && (
                      <p className="text-xs text-muted-foreground">
                        {selectedUserIds.length} user(s) selected
                        {leadUserId ? "" : " — please select a lead user"}
                      </p>
                    )}
                  </div>

                  {/* Trial & Amount */}
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label htmlFor="trialDays">Trial Period</Label>
                      <div className="flex gap-2">
                        <Input
                          id="trialDays"
                          type="number"
                          min="0"
                          value={trialDays}
                          onChange={(e) => setTrialDays(parseInt(e.target.value) || 0)}
                          className="flex-1"
                        />
                        <Select value={trialUnit} onValueChange={(v: "days" | "hours") => setTrialUnit(v)}>
                          <SelectTrigger className="w-24">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="days">Days</SelectItem>
                            <SelectItem value="hours">Hours</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="amount">Monthly Amount (&pound;)</Label>
                      <Input
                        id="amount"
                        type="number"
                        step="0.01"
                        min="0"
                        placeholder="e.g. 29.99"
                        value={amountPounds}
                        onChange={(e) => setAmountPounds(e.target.value)}
                      />
                    </div>
                  </div>

                  {/* Minute Limits */}
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label htmlFor="outboundLimit">Outbound Mins Limit</Label>
                      <Input
                        id="outboundLimit"
                        type="number"
                        min="0"
                        value={outboundMinsLimit}
                        onChange={(e) => setOutboundMinsLimit(parseInt(e.target.value) || 0)}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="inboundLimit">Inbound Mins Limit</Label>
                      <Input
                        id="inboundLimit"
                        type="number"
                        min="0"
                        value={inboundMinsLimit}
                        onChange={(e) => setInboundMinsLimit(parseInt(e.target.value) || 0)}
                      />
                    </div>
                  </div>
                  <p className="text-xs text-muted-foreground -mt-2">
                    Minutes above these limits are charged at &pound;0.04/min overage.
                  </p>

                  {/* Email Fields */}
                  <div className="space-y-2">
                    <Label htmlFor="emailTo">Send Invite Email To</Label>
                    <Input
                      id="emailTo"
                      type="email"
                      placeholder="client@example.com"
                      value={inviteEmailTo}
                      onChange={(e) => setInviteEmailTo(e.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="emailFrom">Send Invite Email From</Label>
                    <Input
                      id="emailFrom"
                      type="email"
                      placeholder="billing@yourdomain.com"
                      value={inviteEmailFrom}
                      onChange={(e) => setInviteEmailFrom(e.target.value)}
                    />
                    <p className="text-xs text-muted-foreground">
                      Must be a verified domain in your Resend account
                    </p>
                  </div>

                  <Button
                    onClick={handleCreate}
                    disabled={creating || !leadUserId || !amountPounds || !inviteEmailTo || !inviteEmailFrom}
                    className="w-full"
                  >
                    {creating ? (
                      <>
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                        Creating...
                      </>
                    ) : (
                      <>
                        <CreditCard className="h-4 w-4 mr-2" />
                        Create &amp; Send Invite
                      </>
                    )}
                  </Button>
                </div>
              </DialogContent>
            </Dialog>
          </div>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="flex justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : subscriptions.length === 0 ? (
            <p className="text-center py-8 text-muted-foreground">No subscriptions yet</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Lead User</TableHead>
                  <TableHead>Assigned Users</TableHead>
                  <TableHead>Trial</TableHead>
                  <TableHead>Monthly</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Invite Sent</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {subscriptions.map((sub) => (
                  <TableRow key={sub.id}>
                    <TableCell>
                      <div>
                        <p className="font-medium text-sm">{sub.lead_user?.full_name || "—"}</p>
                        <p className="text-xs text-muted-foreground">{sub.lead_user?.email || "—"}</p>
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1">
                        <Users className="h-3.5 w-3.5 text-muted-foreground" />
                        <span className="text-sm">
                          {sub.subscription_users
                            ?.map((su) => su.user?.full_name || su.user_id)
                            .join(", ") || "—"}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell className="text-sm">
                      {sub.trial_period_days > 0 ? `${sub.trial_period_days} days` : "None"}
                    </TableCell>
                    <TableCell className="text-sm font-medium">
                      &pound;{(sub.amount_pence / 100).toFixed(2)}
                    </TableCell>
                    <TableCell>
                      <Badge className={statusColors[sub.status] || "bg-muted text-muted-foreground"}>
                        {sub.status.replace("_", " ")}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {sub.invite_sent_at
                        ? new Date(sub.invite_sent_at).toLocaleDateString()
                        : "—"}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleViewDetails(sub)}
                        >
                          <Eye className="h-4 w-4" />
                        </Button>
                        {sub.status !== "cancelled" && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="text-destructive"
                            onClick={() => handleCancel(sub.id)}
                          >
                            <XCircle className="h-4 w-4" />
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Details / Usage Dialog */}
      <Dialog open={detailsOpen} onOpenChange={setDetailsOpen}>
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <TrendingUp className="h-5 w-5" />
              Subscription Details &amp; Usage
            </DialogTitle>
          </DialogHeader>

          {selectedSub && (
            <div className="space-y-6 py-4">
              {/* Subscription Info */}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <p className="text-xs text-muted-foreground">Lead User</p>
                  <p className="font-medium">{selectedSub.lead_user?.full_name}</p>
                  <p className="text-sm text-muted-foreground">{selectedSub.lead_user?.email}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Status</p>
                  <Badge className={statusColors[selectedSub.status] || ""}>
                    {selectedSub.status.replace("_", " ")}
                  </Badge>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Monthly Amount</p>
                  <p className="font-medium">&pound;{(selectedSub.amount_pence / 100).toFixed(2)}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Trial Period</p>
                  <p className="font-medium">
                    {selectedSub.trial_period_days > 0
                      ? `${selectedSub.trial_period_days} days`
                      : "None"}
                  </p>
                </div>
              </div>

              {/* Usage Per User */}
              <div>
                <h3 className="text-sm font-semibold mb-3">Usage This Period</h3>
                {usageLoading ? (
                  <div className="flex justify-center py-4">
                    <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                  </div>
                ) : usageData.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No usage data available</p>
                ) : (
                  <div className="space-y-4">
                    {usageData.map((u) => (
                      <Card key={u.user_id} className="p-4">
                        <div className="flex items-center justify-between mb-3">
                          <div>
                            <p className="font-medium text-sm">{u.user?.full_name}</p>
                            <p className="text-xs text-muted-foreground">{u.user?.email}</p>
                          </div>
                          {u.total_overage_mins > 0 && (
                            <Badge className="bg-orange-500/10 text-orange-500">
                              Overage: &pound;{(u.overage_charge_pence / 100).toFixed(2)}
                            </Badge>
                          )}
                        </div>
                        <div className="grid grid-cols-2 gap-4">
                          <div>
                            <div className="flex justify-between text-xs mb-1">
                              <span className="text-muted-foreground">Outbound</span>
                              <span>{Math.min(u.outbound_mins, u.outbound_limit)} / {u.outbound_limit} mins</span>
                            </div>
                            <Progress
                              value={Math.min(100, (u.outbound_mins / u.outbound_limit) * 100)}
                              className="h-2"
                            />
                            {u.outbound_overage > 0 && (
                              <p className="text-xs text-orange-500 mt-1">+{u.outbound_overage} overage mins</p>
                            )}
                          </div>
                          <div>
                            <div className="flex justify-between text-xs mb-1">
                              <span className="text-muted-foreground">Inbound</span>
                              <span>{Math.min(u.inbound_mins, u.inbound_limit)} / {u.inbound_limit} mins</span>
                            </div>
                            <Progress
                              value={Math.min(100, (u.inbound_mins / u.inbound_limit) * 100)}
                              className="h-2"
                            />
                            {u.inbound_overage > 0 && (
                              <p className="text-xs text-orange-500 mt-1">+{u.inbound_overage} overage mins</p>
                            )}
                          </div>
                        </div>
                        {u.total_overage_mins > 0 && (
                          <p className="text-xs text-muted-foreground mt-2">
                            Total overage: {u.total_overage_mins} mins &times; &pound;0.04 = <span className="font-medium text-orange-500">&pound;{(u.overage_charge_pence / 100).toFixed(2)}</span> extra this month
                          </p>
                        )}
                      </Card>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default SubscriptionManagement;
