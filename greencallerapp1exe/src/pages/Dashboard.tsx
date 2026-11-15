import { useEffect, useRef, useState, useCallback } from "react";
import { useNavigate, Routes, Route, Navigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { User } from "@supabase/supabase-js";
import { SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/AppSidebar";
import Home from "./Home";
import Dialpad from "@/components/Dialpad";
import { PersonalContacts } from "@/components/PersonalContacts";
import { AIAssistant } from "@/components/AIAssistant";
import { WhatsAppView } from "@/components/WhatsAppView";
import CallHistory from "@/components/CallHistory";
import { VoicemailList } from "@/components/VoicemailList";
import CallRecordings from "@/components/CallRecordings";
import { EnterprisePlatform } from "./EnterprisePlatform";
import { useCallProvider } from "@/hooks/useCallProvider";
import { ActiveCallModal } from "@/components/ActiveCallModal";
import { ActiveCallPanel } from "@/components/ActiveCallPanel";
import { IncomingCallModal } from "@/components/IncomingCallModal";
import { useCallPip } from "@/hooks/useCallPip";
import { useSidebarMode } from "@/hooks/useSidebarMode";
import { SidebarModeButton } from "@/components/SidebarModeButton";
import { CallNoteDialog } from "@/components/CallNoteDialog";
import { CallNotes } from "@/components/CallNotes";
import { useCallNoteController } from "@/hooks/useCallNoteController";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { AlertTriangle, RefreshCw } from "lucide-react";

const Dashboard = () => {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [accountType, setAccountType] = useState<string>("");
  const [assignedNumber, setAssignedNumber] = useState<string | null>(null);
  const [callViewMode, setCallViewMode] = useState<"panel" | "modal">("panel");
  // Native floating PiP card (Electron only) — pops the call out over other apps.
  const [isPipActive, setIsPipActive] = useState(false);
  // Lifted so the floating card's Transfer button can open the picker.
  const [transferOpen, setTransferOpen] = useState(false);
  const navigate = useNavigate();

  // Provider is resolved after we fetch the assigned number.
  // Keeping it undefined initially prevents booting the wrong client briefly.
  const [provider, setProvider] = useState<string | undefined>(undefined);

  // Fetch assigned number for the user
  useEffect(() => {
    const fetchAssignedNumber = async () => {
      if (!user?.id) return;

      const { data } = await supabase
        .from("phone_numbers")
        .select("phone_number, provider")
        .eq("assigned_to", user.id)
        .eq("is_active", true)
        .maybeSingle();

      if (data) {
        setAssignedNumber(data.phone_number);
        setProvider(data.provider || "twilio");
      } else {
        setAssignedNumber(null);
        setProvider(undefined);
      }
    };

    fetchAssignedNumber();
  }, [user?.id]);

  const {
    callState,
    incomingCall,
    makeCall,
    endCall,
    toggleMute,
    toggleHold,
    toggleRecording,
    transferCall,
    answerIncomingCall,
    declineIncomingCall,
    dismissIncomingCall,
    restoreIncomingCall,
    sendIncomingToVoicemail,
    sendDtmf,
    isRegistrationStale,
  } = useCallProvider({ userId: user?.id, assignedNumber, provider });

  // Per-call notes (premium/enterprise). Tracks a stable call ref + direction.
  const notes = useCallNoteController(callState);

  // Reset the popped-out state whenever a call is no longer active.
  useEffect(() => {
    if (!callState.isActive && isPipActive) setIsPipActive(false);
  }, [callState.isActive, isPipActive]);

  // Bridge the call into the native floating PiP window (Electron only).
  useCallPip({
    // Enterprise accounts render EnterprisePlatform instead, which owns the
    // floating card for that shell. Wait until the account type is known.
    enabled: !!accountType && accountType !== "enterprise",
    pipActive: isPipActive,
    callState: {
      isActive: callState.isActive,
      callerName: callState.callerName,
      phoneNumber: callState.phoneNumber,
      duration: callState.duration,
      isMuted: callState.isMuted,
      isOnHold: callState.isOnHold,
      isRecording: callState.isRecording,
      isPaused: callState.isPaused,
    },
    canNote: accountType === "premium" || accountType === "enterprise",
    noteSession: notes.activeSession,
    userId: user?.id,
    // Match the in-app card's gating exactly: Transfer is enterprise-only and
    // Record is premium and above.
    canTransfer: accountType === "enterprise",
    canRecord: accountType === "premium" || accountType === "enterprise",
    onMute: toggleMute,
    onHold: toggleHold,
    onEnd: endCall,
    onRecord: toggleRecording,
    onDtmf: sendDtmf,
    onMaximize: () => {
      setIsPipActive(false);
      setCallViewMode("panel");
    },
    // The transfer picker needs real UI, so it comes back to the call panel.
    onTransfer: () => {
      setIsPipActive(false);
      setCallViewMode("panel");
      setTransferOpen(true);
    },
  });

  useEffect(() => {
    const checkAuth = async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        navigate("/auth");
        return;
      }
      setUser(session.user);
      
      // Fetch account type
      const { data: profile } = await supabase
        .from("profiles")
        .select("account_type")
        .eq("id", session.user.id)
        .single();
      
      if (profile) {
        setAccountType(profile.account_type);
      }
      
      setLoading(false);
    };

    checkAuth();

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!session) {
        navigate("/auth");
      } else {
        setUser(session.user);
      }
    });

    return () => subscription.unsubscribe();
  }, [navigate]);

  // Request notification permission on load so incoming calls can alert in other tabs
  useEffect(() => {
    if ("Notification" in window && Notification.permission === "default") {
      Notification.requestPermission();
    }
  }, []);

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

  const handleMakeCall = (phoneNumber: string, record: boolean = false) => {
    notes.markOutbound();
    makeCall(phoneNumber, record);
  };

  const handleAnswerIncoming = () => {
    notes.markInbound();
    answerIncomingCall();
  };

  // Sidebar Mode (Electron). Container-only: this window keeps the single
  // WebRTC/SIP session and is merely hidden while docked, so calls continue
  // uninterrupted in either direction.
  const sidebar = useSidebarMode({
    // Enterprise accounts render EnterprisePlatform instead, which owns the
    // bridge for that shell. Wait until the account type is known.
    enabled: !!accountType && accountType !== "enterprise",
    userId: user?.id,
    accountType,
    assignedNumber,
    callState,
    incomingCall,
    isRegistrationStale,
    isPipActive,
    onPopOut: () => setIsPipActive(true),
    noteSession: notes.activeSession,
    onAnswer: handleAnswerIncoming,
    onDecline: declineIncomingCall,
    onSendToVoicemail: sendIncomingToVoicemail,
    onEnd: endCall,
    onMute: toggleMute,
    onHold: toggleHold,
    onRecord: toggleRecording,
    onSendDtmf: sendDtmf,
    onTransfer: transferCall,
    onMakeCall: handleMakeCall,
    onOpenNotes: notes.openNotes,
  });

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary mx-auto mb-4"></div>
          <p className="text-muted-foreground">Loading...</p>
        </div>
      </div>
    );
  }

  // Enterprise users get tabbed interface
  if (accountType === 'enterprise') {
    return <EnterprisePlatform userId={user?.id} />;
  }

  // Basic/Premium users get sidebar navigation
  return (
    <SidebarProvider>
      <div className="min-h-screen flex w-full">
        <AppSidebar userEmail={user?.email} />
        
        <div className="flex-1 flex flex-col">
          <header className="border-b bg-card h-16 flex items-center justify-between px-4">
            <SidebarTrigger />
            <SidebarModeButton
              available={sidebar.isAvailable}
              onClick={sidebar.enterSidebarMode}
            />
          </header>

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

          <main className="flex-1 overflow-auto">
            <div className="container mx-auto px-4 py-8">
            <Routes>
              <Route path="/" element={<Home userId={user?.id} accountType={accountType} />} />
              <Route path="dialpad" element={<Dialpad userId={user?.id} onMakeCall={handleMakeCall} accountType={accountType} />} />
              <Route path="contacts" element={
                <div className="max-w-2xl mx-auto h-[calc(100vh-10rem)] border rounded-lg bg-card overflow-hidden">
                  <PersonalContacts userId={user?.id} onCall={handleMakeCall} />
                </div>
              } />
              <Route path="history" element={<CallHistory userId={user?.id} accountType={accountType} />} />
              <Route path="voicemails" element={<VoicemailList userId={user?.id} />} />
              <Route path="recordings" element={<CallRecordings userId={user?.id} />} />
              <Route path="notes" element={<CallNotes userId={user?.id} />} />
              <Route path="ai-assistant" element={<AIAssistant userId={user?.id} />} />
              <Route path="whatsapp" element={<WhatsAppView userId={user?.id} />} />
            </Routes>
            </div>
          </main>
        </div>

        {/* Active Call Sheet (Right Panel) */}
        <Sheet open={callState.isActive && callViewMode === "panel" && !isPipActive} onOpenChange={(open) => {
          if (!open && callState.isActive && !isPipActive) {
            setCallViewMode("modal");
          }
        }}>
          <SheetContent side="right" className="w-[400px] sm:w-[450px] p-0">
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
              onPopOut={() => setIsPipActive(true)}
              transferOpen={transferOpen}
              onTransferOpenChange={setTransferOpen}
              onOpenNotes={notes.openNotes}
              onSendDtmf={sendDtmf}
              userId={user?.id}
              accountType={accountType}
            />
          </SheetContent>
        </Sheet>

        {/* Active Call Modal (Minimized floating view) */}
        <ActiveCallModal
          isVisible={callState.isActive && callViewMode === "modal" && !isPipActive}
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
          onSendDtmf={sendDtmf}
          userId={user?.id}
          onExpand={() => setCallViewMode("panel")}
          onPopOut={() => setIsPipActive(true)}
          transferOpen={transferOpen}
          onTransferOpenChange={setTransferOpen}
          onOpenNotes={notes.openNotes}
          accountType={accountType}
        />

        {/* Call Notes editor (premium/enterprise) */}
        <CallNoteDialog
          open={notes.notesOpen}
          onOpenChange={notes.setNotesOpen}
          userId={user?.id}
          session={notes.session}
          duration={callState.duration}
        />

        {/* Incoming Call Modal */}
        <IncomingCallModal
          isVisible={incomingCall.isIncoming}
          isDismissed={incomingCall.isDismissed}
          callerNumber={incomingCall.phoneNumber}
          callerName={incomingCall.callerName}
          onPickup={handleAnswerIncoming}
          onDecline={declineIncomingCall}
          onDismiss={dismissIncomingCall}
          onRestore={restoreIncomingCall}
          onSendToVoicemail={sendIncomingToVoicemail}
        />
      </div>
    </SidebarProvider>
  );
};

export default Dashboard;
