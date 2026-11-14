import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Bot,
  Grid3x3,
  History,
  NotebookPen,
  PictureInPicture2,
  Settings,
  Users,
  Voicemail as VoicemailIcon,
  X,
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { toast, useToast } from "@/hooks/use-toast";

import Dialpad from "@/components/Dialpad";
import { AIAssistant } from "@/components/AIAssistant";
import { ContactsView } from "@/components/ContactsView";
import { PersonalContacts } from "@/components/PersonalContacts";
import { VoicemailList } from "@/components/VoicemailList";
import { ActiveCallPanel } from "@/components/ActiveCallPanel";
import { CallNotes } from "@/components/CallNotes";

import { SidebarStrip, type StripItem } from "@/components/sidebar-mode/SidebarStrip";
import { SidebarPanel } from "@/components/sidebar-mode/SidebarPanel";
import { SidebarIncomingCall } from "@/components/sidebar-mode/SidebarIncomingCall";
import { SidebarSettings } from "@/components/sidebar-mode/SidebarSettings";
import { SidebarCallNotes } from "@/components/sidebar-mode/SidebarCallNotes";
import { SidebarActivity } from "@/components/sidebar-mode/SidebarActivity";
import { cn } from "@/lib/utils";
import { useSidebarBadges } from "@/components/sidebar-mode/useSidebarBadges";
import {
  DEFAULT_SIDEBAR_CONFIG,
  EMPTY_SIDEBAR_STATE,
  type SidebarConfig,
  type SidebarState,
} from "@/components/sidebar-mode/types";
import "@/components/sidebar-mode/sidebar-mode.css";

/** How long the call panel lingers after a call ends before collapsing. */
const CALL_COLLAPSE_DELAY = 1000;
/** Matches the CSS exit animation. */
const CLOSE_ANIM_MS = 150;

type PanelId = "recents" | "contacts" | "notes" | "voicemail" | "ai" | "dialpad" | "settings";

const PANEL_TITLES: Record<PanelId, string> = {
  recents: "Activity",
  contacts: "Contacts",
  notes: "Notes",
  voicemail: "Voicemail",
  ai: "AI Assistant",
  dialpad: "Dialpad",
  settings: "Settings",
};

/**
 * The docked Sidebar Mode window (hash route `#/sidebar`).
 *
 * IMPORTANT: this renderer deliberately does NOT mount `useCallProvider`. The
 * full app window stays alive (hidden) and keeps the one and only Telnyx /
 * Twilio registration; everything here mirrors that window's state over IPC and
 * posts actions back to it. Sidebar Mode is a container, not a second client.
 */
const SidebarApp = () => {
  const api = typeof window !== "undefined" ? window.electronAPI?.sidebar : undefined;

  const [config, setConfig] = useState<SidebarConfig>(DEFAULT_SIDEBAR_CONFIG);
  const [state, setState] = useState<SidebarState>(EMPTY_SIDEBAR_STATE);
  const [activePanel, setActivePanel] = useState<PanelId | null>(null);
  const [closing, setClosing] = useState(false);
  /** Call notes extended alongside the active-call panel. */
  const [notesOpen, setNotesOpen] = useState(false);

  const [sessionUserId, setUserId] = useState<string | undefined>(undefined);
  const [sessionAccountType, setAccountType] = useState<string>("basic");
  const [hasAssistant, setHasAssistant] = useState(false);

  // The hidden main window owns the auth session and the telephony
  // registration, so its mirrored identity is authoritative. This window's
  // own session read is only a fallback until the first snapshot lands —
  // writing notes under a stale user id is silently rejected by RLS.
  const userId = state.userId ?? sessionUserId;
  const accountType = state.userId ? (state.accountType ?? sessionAccountType) : sessionAccountType;

  const { badges, markSeen, refresh: refreshBadges } = useSidebarBadges(userId, accountType);
  const closeTimer = useRef<number | null>(null);

  // ── Window chrome ──────────────────────────────────────────────────────
  // The BrowserWindow is frameless + transparent, so the document must not
  // paint a background of its own.
  useEffect(() => {
    document.documentElement.classList.add("gc-sidebar-window");
    return () => document.documentElement.classList.remove("gc-sidebar-window");
  }, []);

  // ── Identity (shared auth session with the main window) ────────────────
  // This window is hidden, never destroyed, when leaving Sidebar Mode — so it
  // must re-read who is signed in whenever the session changes (log out, log
  // in as someone else) and every time it is docked again, or it keeps showing
  // the previous account's number, contacts and assistant.
  const [identityTick, setIdentityTick] = useState(0);
  useEffect(() => {
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event) => {
      if (event === "SIGNED_IN" || event === "SIGNED_OUT" || event === "USER_UPDATED") {
        setIdentityTick((t) => t + 1);
      }
    });
    return () => subscription.unsubscribe();
  }, []);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (cancelled) return;
      if (!session?.user) {
        setUserId(undefined);
        setAccountType("basic");
        setHasAssistant(false);
        return;
      }

      setUserId(session.user.id);

      const { data: profile } = await supabase
        .from("profiles")
        .select("account_type")
        .eq("id", session.user.id)
        .maybeSingle();
      if (!cancelled && profile?.account_type) setAccountType(profile.account_type);

      const { data: assistant } = await supabase
        .from("ai_assistants")
        .select("id")
        .eq("assigned_user_id", session.user.id)
        .maybeSingle();
      if (!cancelled) setHasAssistant(!!assistant);
    };

    load();
    return () => {
      cancelled = true;
    };
  }, [identityTick]);

  // Listeners are registered once, so they read live values through a ref.
  const live = useRef({ closePanel: () => {}, hasPanel: false });

  // ── IPC wiring ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (!api) return;

    api.onConfig((next) => {
      setConfig({ ...DEFAULT_SIDEBAR_CONFIG, ...next });
      // Config is pushed on every dock — re-read identity in case the
      // account changed while this window sat hidden.
      setIdentityTick((t) => t + 1);
    });
    api.onState((next) => setState({ ...EMPTY_SIDEBAR_STATE, ...next }));
    api.onForceCollapse(() => {
      setClosing(false);
      setActivePanel(null);
    });
    // Toasts raised by the hidden full window surface here instead.
    api.onToast((t) => {
      if (!t?.title && !t?.description) return;
      toast({
        title: t.title,
        description: t.description,
        variant: t.variant === "destructive" ? "destructive" : "default",
      });
    });
    api.onBlur(() => {
      // Clicking away closes a browsing panel, but never a live call — the
      // call panel is derived from call state, so it is unaffected either way.
      if (live.current.hasPanel) live.current.closePanel();
    });

    return () => api.removeAllListeners();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api]);

  const send = useCallback(
    (type: string, payload?: unknown) => api?.sendAction({ type, payload }),
    [api],
  );

  // ── Call-driven panel ──────────────────────────────────────────────────
  // An inbound or active call overrides whatever the user had open, and holds
  // the panel open for a beat after the call ends.
  // A call popped out to the native floating card hands the view over: the
  // strip stays docked but collapses back to the rail.
  const hasLiveCall =
    state.incoming.isIncoming || (state.call.isActive && !state.isPipActive);
  const [callLingering, setCallLingering] = useState(false);
  const hadLiveCall = useRef(false);

  useEffect(() => {
    if (hasLiveCall) {
      hadLiveCall.current = true;
      setCallLingering(false);
      return;
    }
    if (!hadLiveCall.current) return;
    hadLiveCall.current = false;
    setCallLingering(true);
    const t = window.setTimeout(() => setCallLingering(false), CALL_COLLAPSE_DELAY);
    return () => window.clearTimeout(t);
  }, [hasLiveCall]);

  const showCallPanel = hasLiveCall || callLingering;

  // Bring the strip forward (without stealing keyboard focus) on a new call.
  const wasIncoming = useRef(false);
  useEffect(() => {
    if (state.incoming.isIncoming && !wasIncoming.current) api?.alert();
    wasIncoming.current = state.incoming.isIncoming;
  }, [state.incoming.isIncoming, api]);

  // ── Expand / collapse the window around the panel ───────────────────────
  const expanded = showCallPanel || activePanel !== null;

  // ── Notices ────────────────────────────────────────────────────────────
  // The app's global Toaster is hidden in this window (see sidebar-mode.css):
  // a full-size toast cannot fit a 56px strip and ends up cut off over the
  // buttons. Instead the newest toast renders as a small banner INSIDE the
  // open panel, auto-clears after a few seconds, and is dropped outright when
  // no panel is open (there is nothing to anchor it to).
  const { toasts: sidebarToasts, dismiss: dismissToast } = useToast();
  const notice = expanded ? sidebarToasts.find((t) => t.open !== false) ?? null : null;
  useEffect(() => {
    const newest = sidebarToasts[0];
    if (!newest || newest.open === false) return;
    if (!expanded) {
      dismissToast(newest.id);
      return;
    }
    const t = window.setTimeout(() => dismissToast(newest.id), 5000);
    return () => window.clearTimeout(t);
  }, [sidebarToasts, expanded, dismissToast]);

  // Call notes extend a SECOND panel alongside the call panel, so the user can
  // write notes without leaving the strip. Only meaningful during a live call.
  const canUseNotes = accountType === "premium" || accountType === "enterprise";
  const notesAvailable = Boolean(canUseNotes && state.noteSession && state.call.isActive);
  const showNotesPanel = notesOpen && notesAvailable && showCallPanel;

  // Drop the notes panel as soon as the call it belongs to is over.
  useEffect(() => {
    if (!notesAvailable && notesOpen) setNotesOpen(false);
  }, [notesAvailable, notesOpen]);

  useEffect(() => {
    api?.setExpanded(expanded, showNotesPanel);
  }, [api, expanded, showNotesPanel]);

  const closePanel = useCallback(() => {
    if (closeTimer.current) window.clearTimeout(closeTimer.current);
    setClosing(true);
    closeTimer.current = window.setTimeout(() => {
      setClosing(false);
      setActivePanel(null);
      closeTimer.current = null;
    }, CLOSE_ANIM_MS);
  }, []);

  live.current = { closePanel, hasPanel: activePanel !== null };

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (showCallPanel) return; // never dismiss a live call with Esc
      if (activePanel) closePanel();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activePanel, showCallPanel, closePanel]);

  useEffect(() => () => {
    if (closeTimer.current) window.clearTimeout(closeTimer.current);
  }, []);

  const handleSelect = (id: string) => {
    const panel = id as PanelId;
    if (activePanel === panel) {
      closePanel();
      return;
    }
    if (panel === "recents") markSeen("recents");
    if (panel === "voicemail") markSeen("voicemail");
    setClosing(false);
    setActivePanel(panel);
  };

  const openFullApp = useCallback(() => api?.exit(), [api]);

  // ── Strip items ────────────────────────────────────────────────────────
  const items = useMemo<StripItem[]>(() => {
    const list: StripItem[] = [
      {
        id: "recents",
        label: "Activity",
        icon: History,
        badge: badges.recents,
        pulse: state.incoming.isIncoming,
      },
      { id: "dialpad", label: "Dialpad", icon: Grid3x3 },
      // Team messages live under Contacts → Teammates, so their unread dot sits here.
      { id: "contacts", label: "Contacts", icon: Users, badge: badges.messages },
      { id: "voicemail", label: "Voicemail", icon: VoicemailIcon, badge: badges.voicemail },
    ];
    if (canUseNotes) {
      list.push({ id: "notes", label: "Notes", icon: NotebookPen });
    }
    if (hasAssistant) {
      list.push({ id: "ai", label: "AI Assistant", icon: Bot });
    }
    list.push({ id: "settings", label: "Settings", icon: Settings });
    return list;
  }, [accountType, hasAssistant, canUseNotes, badges, state.incoming.isIncoming]);

  // ── Panel content ──────────────────────────────────────────────────────
  const renderPanelBody = () => {
    if (showCallPanel) {
      if (state.incoming.isIncoming) {
        return (
          <SidebarIncomingCall
            callerNumber={state.incoming.phoneNumber}
            callerName={state.incoming.callerName}
            lineNumber={state.assignedNumber}
            onAccept={() => send("answer")}
            onDecline={() => send("decline")}
            onSendToVoicemail={() => send("voicemail")}
          />
        );
      }
      if (state.call.isActive) {
        return (
          <ActiveCallPanel
            embedded
            callerName={state.call.callerName}
            callerCompany={state.call.callerCompany}
            callerNumber={state.call.phoneNumber}
            duration={state.call.duration}
            isMuted={state.call.isMuted}
            isOnHold={state.call.isOnHold}
            isRecording={state.call.isRecording}
            isPaused={state.call.isPaused}
            onMuteToggle={() => send("mute")}
            onHoldToggle={() => send("hold")}
            onRecordToggle={() => send("record")}
            onEndCall={() => send("end")}
            onTransfer={(targetId, targetType) => send("transfer", { targetId, targetType })}
            onSendDtmf={(digit) => send("dtmf", digit)}
            userId={userId}
            accountType={accountType}
          />
        );
      }
      // Lingering after hang-up.
      return (
        <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
          Call ended
        </div>
      );
    }

    switch (activePanel) {
      case "recents":
        return <SidebarActivity userId={userId} accountType={accountType} />;
      case "contacts":
        return accountType === "enterprise" ? (
          <ContactsView
            compact
            userId={userId}
            onCall={(number) => send("dial", { number })}
            onMessagesRead={refreshBadges}
          />
        ) : (
          <PersonalContacts userId={userId} onCall={(number) => send("dial", { number })} />
        );
      case "notes":
        return (
          <div className="h-full overflow-y-auto">
            <CallNotes userId={userId} compact />
          </div>
        );
      case "voicemail":
        return (
          <div className="h-full overflow-y-auto">
            <VoicemailList userId={userId} />
          </div>
        );
      case "ai":
        return (
          <div className="h-full overflow-y-auto">
            <AIAssistant compact userId={userId} />
          </div>
        );
      case "dialpad":
        return (
          <div className="h-full overflow-y-auto">
            <Dialpad
              compact
              userId={userId}
              accountType={accountType}
              // Mirror the line the hidden main window is registered on; fall
              // back to Dialpad's own lookup until the first snapshot lands.
              lineNumber={state.userId ? (state.assignedNumber ?? null) : undefined}
              onMakeCall={(number, record) => send("dial", { number, record })}
            />
          </div>
        );
      case "settings":
        return <SidebarSettings />;
      default:
        return null;
    }
  };

  const panelTitle = showCallPanel
    ? state.incoming.isIncoming
      ? "Incoming Call"
      : "Active Call"
    : activePanel
      ? PANEL_TITLES[activePanel]
      : "";

  // Active-call header actions: call notes (extends a second panel right here,
  // no need to leave the strip) and pop-out to the floating card.
  const inActiveCall = showCallPanel && state.call.isActive;
  const panelAction = inActiveCall ? (
    <>
      {notesAvailable && (
        <button
          type="button"
          onClick={() => setNotesOpen((v) => !v)}
          title={notesOpen ? "Hide call notes" : "Call notes"}
          aria-label="Call notes"
          aria-pressed={notesOpen}
          className={cn(
            "gc-sb-nodrag flex items-center justify-center h-6 w-6 rounded-md transition-colors",
            notesOpen
              ? "bg-white/20 text-white"
              : "text-white/70 hover:text-white hover:bg-white/12",
          )}
        >
          <NotebookPen className="w-3.5 h-3.5" />
        </button>
      )}
      <button
        type="button"
        onClick={() => send("pip")}
        title="Pop out as floating window — the sidebar stays docked"
        aria-label="Pop out as floating window"
        className="gc-sb-nodrag flex items-center justify-center h-6 w-6 rounded-md text-white/70 hover:text-white hover:bg-white/12 transition-colors"
      >
        <PictureInPicture2 className="w-3.5 h-3.5" />
      </button>
    </>
  ) : null;

  // ── Layout ─────────────────────────────────────────────────────────────
  const { dockEdge, strip, panelWidth, auxWidth, gap } = config;
  const isVertical = dockEdge !== "top";

  // The gap between strip and panel is drawn as a margin on the panel side
  // facing the strip, so the two glass surfaces read as one docked unit.
  const panelSlotStyle: React.CSSProperties = isVertical
    ? {
        width: panelWidth,
        height: "100%",
        marginRight: dockEdge === "right" ? gap : undefined,
        marginLeft: dockEdge === "left" ? gap : undefined,
      }
    : { flex: 1, minWidth: 0, height: "100%" };

  const panelSlot = expanded ? (
    <div className="relative min-h-0 min-w-0" style={panelSlotStyle}>
      <SidebarPanel
        title={panelTitle}
        dockEdge={dockEdge}
        closing={closing}
        onClose={showCallPanel ? undefined : closePanel}
        onOpenFullApp={openFullApp}
        action={panelAction}
      >
        {renderPanelBody()}
      </SidebarPanel>
      {/* Compact notice pinned inside the panel — never a full-size toast
          floating over the strip's buttons. */}
      {notice && (
        <div
          role="status"
          className={cn(
            "gc-sb-notice absolute left-3 right-3 bottom-3 z-20 flex items-start gap-2 rounded-lg px-3 py-2 text-[12px] shadow-lg",
            notice.variant === "destructive"
              ? "bg-red-600 text-white"
              : "bg-[rgb(var(--gc-sb-forest))] text-white",
          )}
        >
          <div className="min-w-0 flex-1">
            {notice.title && <div className="font-semibold truncate">{String(notice.title)}</div>}
            {notice.description && (
              <div className="opacity-90 line-clamp-2">{String(notice.description)}</div>
            )}
          </div>
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => dismissToast(notice.id)}
            className="shrink-0 rounded p-0.5 text-white/80 hover:text-white hover:bg-white/15"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}
    </div>
  ) : null;

  // Secondary panel: sits further from the docked edge than the call panel, so
  // the strip → call → notes reading order always runs toward screen centre.
  const auxSlotStyle: React.CSSProperties = isVertical
    ? {
        width: auxWidth,
        height: "100%",
        marginRight: dockEdge === "right" ? gap : undefined,
        marginLeft: dockEdge === "left" ? gap : undefined,
      }
    : { width: auxWidth, height: "100%", marginLeft: gap };

  const auxSlot =
    showNotesPanel && state.noteSession ? (
      <div className="min-h-0 min-w-0" style={auxSlotStyle}>
        <SidebarPanel
          title="Call Notes"
          dockEdge={dockEdge}
          onClose={() => setNotesOpen(false)}
        >
          <SidebarCallNotes
            userId={userId}
            session={state.noteSession}
            duration={state.call.duration}
          />
        </SidebarPanel>
      </div>
    ) : null;

  // For a top dock the two panels sit side by side beneath the horizontal strip.
  const panelRow =
    expanded && !isVertical ? (
      <div className="flex min-h-0 min-w-0" style={{ flex: 1, marginTop: gap }}>
        {panelSlot}
        {auxSlot}
      </div>
    ) : null;

  const stripEl = (
    <SidebarStrip
      items={items}
      activeId={showCallPanel ? null : activePanel}
      dockEdge={dockEdge}
      thickness={strip}
      onSelect={handleSelect}
      onExpandApp={openFullApp}
    />
  );

  return (
    <div
      className="h-screen w-screen overflow-hidden flex"
      style={{
        flexDirection: isVertical ? "row" : "column",
        alignItems: "stretch",
      }}
    >
      {isVertical && dockEdge === "right" ? (
        // Furthest from the edge first: notes, then the panel, then the strip.
        <>
          {auxSlot}
          {panelSlot}
          <div style={{ width: strip, flex: "0 0 auto" }}>{stripEl}</div>
        </>
      ) : isVertical ? (
        <>
          <div style={{ width: strip, flex: "0 0 auto" }}>{stripEl}</div>
          {panelSlot}
          {auxSlot}
        </>
      ) : (
        <>
          <div style={{ height: strip, flex: "0 0 auto" }}>{stripEl}</div>
          {panelRow}
        </>
      )}
    </div>
  );
};

export default SidebarApp;
