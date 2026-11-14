import { useEffect, useState } from "react";
import { Bell, Phone, Voicemail, MessageSquare, PhoneMissed, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { supabase } from "@/integrations/supabase/client";
import { formatDistanceToNow } from "date-fns";
import { cn } from "@/lib/utils";

interface Notification {
  id: string;
  type: "missed_call" | "voicemail" | "message";
  title: string;
  description: string;
  timestamp: string;
  read: boolean;
}

interface NotificationsProps {
  userId?: string;
}

export const Notifications = ({ userId }: NotificationsProps) => {
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [open, setOpen] = useState(false);

  const fetchNotifications = async () => {
    if (!userId) return;

    try {
      // Fetch missed calls (last 24 hours)
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);

      const [missedCallsRes, voicemailsRes, messagesRes] = await Promise.all([
        supabase
          .from("call_history")
          .select("id, from_number, created_at, status")
          .eq("user_id", userId)
          .eq("direction", "inbound")
          .in("status", ["missed", "no-answer", "busy"])
          .gte("created_at", yesterday.toISOString())
          .order("created_at", { ascending: false })
          .limit(10),
        supabase
          .from("voicemails")
          .select("id, from_number, created_at, status, duration")
          .eq("user_id", userId)
          .eq("status", "new")
          .order("created_at", { ascending: false })
          .limit(10),
        supabase
          .from("messages")
          .select("id, from_number, message_body, created_at")
          .eq("user_id", userId)
          .eq("direction", "inbound")
          .gte("created_at", yesterday.toISOString())
          .order("created_at", { ascending: false })
          .limit(10),
      ]);

      const allNotifications: Notification[] = [];

      // Add missed calls
      missedCallsRes.data?.forEach((call) => {
        allNotifications.push({
          id: `call-${call.id}`,
          type: "missed_call",
          title: "Missed Call",
          description: call.from_number,
          timestamp: call.created_at || new Date().toISOString(),
          read: false,
        });
      });

      // Add voicemails
      voicemailsRes.data?.forEach((vm) => {
        allNotifications.push({
          id: `vm-${vm.id}`,
          type: "voicemail",
          title: "New Voicemail",
          description: `${vm.from_number} • ${vm.duration || 0}s`,
          timestamp: vm.created_at || new Date().toISOString(),
          read: false,
        });
      });

      // Add messages
      messagesRes.data?.forEach((msg) => {
        allNotifications.push({
          id: `msg-${msg.id}`,
          type: "message",
          title: "New Message",
          description: `${msg.from_number}: ${msg.message_body?.slice(0, 30)}${(msg.message_body?.length || 0) > 30 ? "..." : ""}`,
          timestamp: msg.created_at || new Date().toISOString(),
          read: false,
        });
      });

      // Sort by timestamp
      allNotifications.sort((a, b) => 
        new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
      );

      setNotifications(allNotifications);
    } catch (error) {
      console.error("Error fetching notifications:", error);
    }
  };

  useEffect(() => {
    fetchNotifications();

    // Set up real-time subscriptions
    const callChannel = supabase
      .channel("notifications-calls")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "call_history" },
        () => fetchNotifications()
      )
      .subscribe();

    const voicemailChannel = supabase
      .channel("notifications-voicemails")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "voicemails" },
        () => fetchNotifications()
      )
      .subscribe();

    const messageChannel = supabase
      .channel("notifications-messages")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "messages" },
        () => fetchNotifications()
      )
      .subscribe();

    return () => {
      supabase.removeChannel(callChannel);
      supabase.removeChannel(voicemailChannel);
      supabase.removeChannel(messageChannel);
    };
  }, [userId]);

  const getIcon = (type: Notification["type"]) => {
    switch (type) {
      case "missed_call":
        return <PhoneMissed className="w-4 h-4 text-destructive" />;
      case "voicemail":
        return <Voicemail className="w-4 h-4 text-warning" />;
      case "message":
        return <MessageSquare className="w-4 h-4 text-primary" />;
    }
  };

  const getIconBg = (type: Notification["type"]) => {
    switch (type) {
      case "missed_call":
        return "bg-destructive/10";
      case "voicemail":
        return "bg-warning/10";
      case "message":
        return "bg-primary/10";
    }
  };

  const unreadCount = notifications.length;

  const markAllAsRead = async () => {
    // Mark voicemails as read
    const voicemailIds = notifications
      .filter(n => n.type === "voicemail")
      .map(n => n.id.replace("vm-", ""));

    if (voicemailIds.length > 0) {
      await supabase
        .from("voicemails")
        .update({ status: "read" })
        .in("id", voicemailIds);
    }

    setNotifications([]);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon-sm" className="relative">
          <Bell className="w-4 h-4" />
          {unreadCount > 0 && (
            <span className="absolute -top-0.5 -right-0.5 min-w-[18px] h-[18px] px-1 text-[10px] font-bold bg-destructive text-destructive-foreground rounded-full flex items-center justify-center">
              {unreadCount > 99 ? "99+" : unreadCount}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-0">
        <div className="flex items-center justify-between px-4 py-3 border-b">
          <h3 className="font-semibold">Notifications</h3>
          {unreadCount > 0 && (
            <Button
              variant="ghost"
              size="sm"
              className="text-xs h-7 text-muted-foreground hover:text-foreground"
              onClick={markAllAsRead}
            >
              <Check className="w-3 h-3 mr-1" />
              Mark all read
            </Button>
          )}
        </div>

        <ScrollArea className="max-h-[400px]">
          {notifications.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-8 px-4 text-center">
              <div className="w-12 h-12 rounded-full bg-muted flex items-center justify-center mb-3">
                <Bell className="w-6 h-6 text-muted-foreground" />
              </div>
              <p className="text-sm font-medium text-muted-foreground">
                No new notifications
              </p>
              <p className="text-xs text-muted-foreground mt-1">
                You're all caught up!
              </p>
            </div>
          ) : (
            <div className="divide-y">
              {notifications.map((notification) => (
                <div
                  key={notification.id}
                  className={cn(
                    "flex items-start gap-3 px-4 py-3 hover:bg-muted/50 transition-colors cursor-pointer",
                    !notification.read && "bg-muted/30"
                  )}
                >
                  <div className={cn(
                    "flex items-center justify-center w-8 h-8 rounded-full flex-shrink-0",
                    getIconBg(notification.type)
                  )}>
                    {getIcon(notification.type)}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium">{notification.title}</p>
                    <p className="text-xs text-muted-foreground truncate">
                      {notification.description}
                    </p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {formatDistanceToNow(new Date(notification.timestamp), { addSuffix: true })}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </ScrollArea>
      </PopoverContent>
    </Popover>
  );
};
