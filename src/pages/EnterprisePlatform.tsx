import { useState, useEffect, useRef, useCallback } from "react";
import { Contacts } from "@/components/Contacts";
import { Switchboard } from "@/components/Switchboard";
import Home from "./Home";
import Dialpad from "@/components/Dialpad";
import MessagesList from "@/components/MessagesList";
import { ActivityView } from "@/components/ActivityView";
import UserManagement from "@/components/UserManagement";
import DepartmentManagement from "@/components/DepartmentManagement";
import CompanyManagement from "@/components/CompanyManagement";
import UserCallUsage from "@/components/UserCallUsage";
import LiveCDR from "@/components/LiveCDR";
import { IVRConfiguration } from "@/components/IVRConfiguration";
import { ProfileSettings } from "@/components/ProfileSettings";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { supabase } from "@/integrations/supabase/client";
import { useNavigate } from "react-router-dom";
import { useToast } from "@/hooks/use-toast";
import { MainSidebar } from "@/components/layout/MainSidebar";
import { Header } from "@/components/layout/Header";
import { ActiveCallModal } from "@/components/ActiveCallModal";
import { ActiveCallPanel } from "@/components/ActiveCallPanel";
import { IncomingCallModal } from "@/components/IncomingCallModal";
import { useCallProvider } from "@/hooks/useCallProvider";
import { AlertTriangle, RefreshCw } from "lucide-react";

interface EnterprisePlatformProps {
  userId?: string;
}

const TAB_TITLES: Record<string, { title: string; subtitle: string }> = {
  home: { title: "Dashboard", subtitle: "Overview of your communication activity" },
  messages: { title: "Messages", subtitle: "Team communication" },
  activity: { title: "Activity", subtitle: "Call history and recordings" },
  contacts: { title: "Contacts", subtitle: "Manage your contact list" },
  departments: { title: "Switchboard", subtitle: "Department call management" },
  admin: { title: "Administration", subtitle: "User and system settings" },
};

export const EnterprisePlatform = ({ userId }: EnterprisePlatformProps) => {
  const navigate = useNavigate();
  const { toast } = useToast();
  const [dialpadOpen, setDialpadOpen] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [queueCount, setQueueCount] = useState(0);
  const [activeTab, setActiveTab] = useState("home");
  const [userEmail, setUserEmail] = useState<string>("");
  const [userName, setUserName] = useState<string>("");
  const [userAvatarUrl, setUserAvatarUrl] = useState<string | null>(null);
  const [assignedNumber, setAssignedNumber] = useState<string | null>(null);
  const [provider, setProvider] = useState<string>("twilio");
  const [profileOpen, setProfileOpen] = useState(false);
  const [callViewMode, setCallViewMode] = useState<"panel" | "modal">("panel");
  const [unreadMessageCount, setUnreadMessageCount] = useState(0);

  const {
    callState,
    incomingCall,
    makeCall,
    endCall,
    toggleMute,
    toggleHold,
    toggleRecording,
    transferCall,
    pickupQueuedCall,
    answerIncomingCall,
    declineIncomingCall,
    dismissIncomingCall,
    restoreIncomingCall,
    sendIncomingToVoicemail,
    sendDtmf,
    isRegistrationStale,
  } = useCallProvider({ userId, assignedNumber, provider });

  // Reset to panel view when a new call starts
  useEffect(() => {
    if (callState.isActive) {
      setCallViewMode("panel");
    }
  }, [callState.isActive]);

  // Auto-refresh after 4 minutes of idle to keep SIP registration alive
  // But NEVER during an active or incoming call
  const idleTimerRef = useRef<number | null>(null);
  const callBusyRef = useRef(false);
  const IDLE_TIMEOUT = 30 * 60 * 1000; // 30 minutes

  // Keep ref in sync — this is the ONLY source of truth the timer checks
  useEffect(() => {
    callBusyRef.current = callState.isActive || incomingCall.isIncoming;
    // If a call just started, kill any pending timer immediately
    if (callBusyRef.current && idleTimerRef.current) {
      window.clearTimeout(idleTimerRef.current);
      idleTimerRef.current = null;
    }
  }, [callState.isActive, incomingCall.isIncoming]);

  useEffect(() => {
    const resetIdleTimer = () => {
      if (idleTimerRef.current) window.clearTimeout(idleTimerRef.current);
      idleTimerRef.current = window.setTimeout(() => {
        if (callBusyRef.current) {
          console.log("Idle timer fired but call is active — skipping reload");
          return;
        }
        console.log(">>> IDLE TIMER FIRING — RELOADING PAGE <<<");
        window.location.reload();
      }, IDLE_TIMEOUT);
    };

    const events = ["mousemove", "keydown", "click", "scroll", "touchstart"];
    events.forEach((e) => window.addEventListener(e, resetIdleTimer, { passive: true }));
    resetIdleTimer();

    return () => {
      events.forEach((e) => window.removeEventListener(e, resetIdleTimer));
      if (idleTimerRef.current) window.clearTimeout(idleTimerRef.current);
    };
  }, []);

  useEffect(() => {
    const checkAdminRole = async () => {
      const { data: { user } } = await supabase.auth.getUser();
      // Only admin@gmail.com has admin access
      setIsAdmin(user?.email === 'admin@gmail.com');
    };

    const fetchUserInfo = async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (user) {
        setUserEmail(user.email || "");
        
        const { data: profile } = await supabase
          .from("profiles")
          .select("full_name, avatar_url")
          .eq("id", user.id)
          .single();
        
        if (profile) {
          setUserName(profile.full_name);
          setUserAvatarUrl(profile.avatar_url);
        }
      }
    };

    const fetchAssignedNumber = async () => {
      if (!userId) return;

      const { data } = await supabase
        .from("phone_numbers")
        .select("phone_number, provider")
        .eq("assigned_to", userId)
        .eq("is_active", true)
        .maybeSingle();

      if (data) {
        setAssignedNumber(data.phone_number);
        setProvider(data.provider || "twilio");
      }
    };

    checkAdminRole();
    fetchUserInfo();
    fetchAssignedNumber();
  }, [userId]);

  // Fetch queue count with polling fallback + real-time updates
  const departmentIdsRef = useRef<string[]>([]);
  const prevQueueCountRef = useRef(0);

  const fetchQueueCount = useCallback(async () => {
    if (!userId) return;

    // Only fetch department IDs once
    if (departmentIdsRef.current.length === 0) {
      const { data: profile } = await supabase
        .from("profiles")
        .select("company_name")
        .eq("id", userId)
        .single();

      if (!profile?.company_name) return;

      const { data: departments } = await supabase
        .from("departments")
        .select("id")
        .eq("company_name", profile.company_name);

      if (!departments || departments.length === 0) return;

      departmentIdsRef.current = departments.map(d => d.id);
    }

    // Clean up stale queue entries where hold music stopped checking in (caller hung up)
    // Hold music updates updated_at every ~10s; if it's been >20s, caller is gone
    const staleThreshold = new Date(Date.now() - 20 * 1000).toISOString();
    await supabase
      .from("call_queue")
      .update({ status: "abandoned" })
      .in("department_id", departmentIdsRef.current)
      .in("status", ["ringing", "waiting"])
      .lt("updated_at", staleThreshold)
      .lt("created_at", staleThreshold);

    // Count calls in queue with 'ringing' or 'waiting' status
    const { count } = await supabase
      .from("call_queue")
      .select("*", { count: "exact", head: true })
      .in("department_id", departmentIdsRef.current)
      .in("status", ["ringing", "waiting"]);

    const newCount = count || 0;

    // Toast when queue count increases
    if (newCount > prevQueueCountRef.current) {
      toast({
        title: "New caller in queue",
        description: `${newCount} caller(s) waiting in department queue`,
      });
    }
    prevQueueCountRef.current = newCount;
    setQueueCount(newCount);
  }, [userId, toast]);

  useEffect(() => {
    fetchQueueCount();

    // Poll every 2 seconds as fallback (Realtime can miss events)
    const interval = setInterval(fetchQueueCount, 2000);

    // Also keep real-time subscription for instant updates
    const channel = supabase
      .channel("queue-count-updates")
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "call_queue",
        },
        () => {
          fetchQueueCount();
        }
      )
      .subscribe();

    return () => {
      clearInterval(interval);
      supabase.removeChannel(channel);
    };
  }, [fetchQueueCount]);

  const fetchUnreadMessageCount = useCallback(async () => {
    if (!userId) return;
    const { count } = await supabase
      .from("team_messages")
      .select("*", { count: "exact", head: true })
      .eq("to_user_id", userId)
      .eq("read", false);

    setUnreadMessageCount(count || 0);
  }, [userId]);

  // Fetch unread message count and subscribe to real-time updates
  useEffect(() => {
    if (!userId) return;

    const fetchUnreadCount = fetchUnreadMessageCount;

    fetchUnreadCount();

    const channel = supabase
      .channel("unread-messages-count")
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "team_messages",
          filter: `to_user_id=eq.${userId}`,
        },
        () => {
          fetchUnreadCount();
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [userId]);

  const handleLogout = async () => {
    await supabase.auth.signOut();
    toast({ title: "Logged out successfully" });
    navigate("/auth");
  };

  const handleMakeCall = (phoneNumber: string, record: boolean = false) => {
    makeCall(phoneNumber, record);
    setDialpadOpen(false);
  };

  const currentTab = TAB_TITLES[activeTab] || TAB_TITLES.home;

  const renderContent = () => {
    switch (activeTab) {
      case "home":
        return <Home userId={userId} />;
      case "messages":
        return <MessagesList userId={userId} onMessagesRead={fetchUnreadMessageCount} />;
      case "activity":
        return <ActivityView userId={userId} />;
      case "contacts":
        return <Contacts userId={userId} onCall={handleMakeCall} />;
      case "departments":
        return <Switchboard userId={userId} onPickupCall={pickupQueuedCall} />;
      case "admin":
        return isAdmin ? (
          <div className="p-6 space-y-8 animate-fade-in">
            <LiveCDR />
            <UserManagement />
            <UserCallUsage />
            <CompanyManagement />
            <DepartmentManagement />
            <IVRConfiguration />
          </div>
        ) : null;
      default:
        return <Home userId={userId} />;
    }
  };

  return (
    <div className="h-screen flex bg-background overflow-hidden">
      {/* Sidebar */}
      <MainSidebar
        activeTab={activeTab}
        onTabChange={setActiveTab}
        isAdmin={isAdmin}
        queueCount={queueCount}
        unreadMessageCount={unreadMessageCount}
        onDialpadOpen={() => setDialpadOpen(true)}
      />

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col min-w-0 min-h-0">
        <Header
          title={currentTab.title}
          subtitle={currentTab.subtitle}
          onLogout={handleLogout}
          userEmail={userEmail}
          userName={userName}
          userAvatarUrl={userAvatarUrl || undefined}
          userId={userId}
          onNavigate={setActiveTab}
          onProfileClick={() => setProfileOpen(true)}
        />

        {isRegistrationStale && (
          <div className="bg-destructive/10 border-b border-destructive/30 px-4 py-3 flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-sm text-destructive">
              <AlertTriangle className="w-4 h-4 shrink-0" />
              <span>Your phone system is offline. Incoming calls will go to voicemail.</span>
            </div>
            <button
              onClick={() => window.location.reload()}
              className="flex items-center gap-1.5 text-sm font-medium text-destructive hover:text-destructive/80 whitespace-nowrap"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              Refresh to reconnect
            </button>
          </div>
        )}

        {/* Page Content */}
        <main className="flex-1 overflow-auto min-h-0">
          <div className="animate-fade-in h-full">
            {renderContent()}
          </div>
        </main>
      </div>

      {/* Dialpad Sheet - only show when not in a call or call is minimized */}
      <Sheet open={dialpadOpen && (!callState.isActive || callViewMode === "modal")} onOpenChange={setDialpadOpen}>
        <SheetContent side="right" className="w-[400px] sm:w-[420px]">
          <SheetHeader>
            <SheetTitle className="font-display">Dialpad</SheetTitle>
          </SheetHeader>
          <div className="mt-4">
            <Dialpad userId={userId} onMakeCall={handleMakeCall} accountType="enterprise" />
          </div>
        </SheetContent>
      </Sheet>

      {/* Active Call Panel - shows on right side like dialpad */}
      <Sheet open={callState.isActive && callViewMode === "panel"} onOpenChange={() => {}}>
        <SheetContent side="right" className="w-[400px] sm:w-[420px] p-0">
          <ActiveCallPanel
            callerName={callState.callerName}
            callerCompany={callState.callerCompany}
            callerNumber={callState.phoneNumber}
            duration={callState.duration}
            isMuted={callState.isMuted}
            isOnHold={callState.isOnHold}
            isRecording={callState.isRecording}
            isPaused={callState.isPaused}
            onMuteToggle={toggleMute}
            onHoldToggle={toggleHold}
            onRecordToggle={toggleRecording}
            onEndCall={endCall}
            onTransfer={transferCall}
            onMinimize={() => setCallViewMode("modal")}
            onSendDtmf={sendDtmf}
            userId={userId}
            accountType="enterprise"
          />
        </SheetContent>
      </Sheet>

      {/* Active Call Modal - shows when minimized */}
      <ActiveCallModal
        isVisible={callState.isActive && callViewMode === "modal"}
        callerName={callState.callerName}
        callerCompany={callState.callerCompany}
        callerNumber={callState.phoneNumber}
        duration={callState.duration}
        isMuted={callState.isMuted}
        isOnHold={callState.isOnHold}
        isRecording={callState.isRecording}
        isPaused={callState.isPaused}
        onMuteToggle={toggleMute}
        onHoldToggle={toggleHold}
        onRecordToggle={toggleRecording}
        onEndCall={endCall}
        onTransfer={transferCall}
        onExpand={() => setCallViewMode("panel")}
        onSendDtmf={sendDtmf}
        userId={userId}
        accountType="enterprise"
      />

      {/* Incoming Call Modal */}
      <IncomingCallModal
        isVisible={incomingCall.isIncoming}
        isDismissed={incomingCall.isDismissed}
        callerNumber={incomingCall.phoneNumber}
        callerName={incomingCall.callerName}
        onPickup={answerIncomingCall}
        onDecline={declineIncomingCall}
        onDismiss={dismissIncomingCall}
        onRestore={restoreIncomingCall}
        onSendToVoicemail={sendIncomingToVoicemail}
      />

      {/* Profile Settings Dialog */}
      <Dialog open={profileOpen} onOpenChange={setProfileOpen}>
        <DialogContent className="max-w-2xl p-0">
          <ProfileSettings 
            userId={userId} 
            onClose={() => {
              setProfileOpen(false);
              // Refresh user info after profile update
              const refreshUserInfo = async () => {
                const { data: profile } = await supabase
                  .from("profiles")
                  .select("full_name, avatar_url")
                  .eq("id", userId)
                  .single();
                if (profile) {
                  setUserName(profile.full_name);
                  setUserAvatarUrl(profile.avatar_url);
                }
              };
              refreshUserInfo();
            }} 
          />
        </DialogContent>
      </Dialog>
    </div>
  );
};
