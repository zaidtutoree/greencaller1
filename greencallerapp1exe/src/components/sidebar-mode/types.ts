/**
 * Shared contract between the full app window and the docked sidebar window.
 *
 * Sidebar Mode is a *container* change only. The main window keeps the one and
 * only WebRTC/SIP session (`useCallProvider`); the sidebar window renders the
 * `#/sidebar` route, which never mounts a call provider. Everything below is
 * the serialisable state that travels between the two over IPC.
 */

/** Where the sidebar strip is docked. Bottom docking is not offered. */
export type SidebarDockEdge = "left" | "top" | "right";

/** Geometry pushed from the main process so the strip lays itself out. */
export interface SidebarConfig {
  dockEdge: SidebarDockEdge;
  expanded: boolean;
  /** A secondary panel (call notes) is extended alongside the open panel. */
  aux: boolean;
  /** Strip thickness in px. */
  strip: number;
  panelWidth: number;
  panelHeight: number;
  /** Width of the secondary (notes) panel. */
  auxWidth: number;
  /** Visual gap drawn between the strip and the panel. */
  gap: number;
}

/** Snapshot of the single call session, mirrored into the strip. */
export interface SidebarState {
  call: {
    isActive: boolean;
    callerName?: string;
    callerCompany?: string;
    phoneNumber: string;
    duration: number;
    isMuted: boolean;
    isOnHold: boolean;
    isRecording: boolean;
    isPaused: boolean;
  };
  incoming: {
    isIncoming: boolean;
    phoneNumber: string;
    callerName?: string;
  };
  /** The Greencaller line the call is arriving on. */
  assignedNumber?: string | null;
  userId?: string;
  accountType?: string;
  hasAssistant?: boolean;
  isRegistrationStale?: boolean;
  /**
   * The call has been popped out into the native floating card. The strip stays
   * docked, but it hands the active-call view over and collapses to the rail.
   */
  isPipActive?: boolean;
  /**
   * Stable note session for the call in progress, so the strip can edit the
   * same `call_notes` row the full app would, without leaving sidebar mode.
   */
  noteSession?: {
    callRef: string;
    phoneNumber?: string;
    contactName?: string;
    direction?: "inbound" | "outbound";
  } | null;
}

/** Every action the strip can ask the full app to perform. */
export type SidebarActionType =
  | "answer"
  | "decline"
  | "voicemail"
  | "end"
  | "mute"
  | "hold"
  | "record"
  | "dtmf"
  | "transfer"
  | "dial"
  | "notes"
  | "pip"
  | "open-full-app";

export interface SidebarAction {
  type: SidebarActionType | string;
  payload?: unknown;
}

/**
 * A toast relayed from the full window into the strip. While docked the full
 * window is hidden, so anything it toasts — recording errors, call failures,
 * dialpad validation — would otherwise be invisible.
 */
export interface SidebarToast {
  title?: string;
  description?: string;
  variant?: "default" | "destructive";
}

export const EMPTY_SIDEBAR_STATE: SidebarState = {
  call: {
    isActive: false,
    phoneNumber: "",
    duration: 0,
    isMuted: false,
    isOnHold: false,
    isRecording: false,
    isPaused: false,
  },
  incoming: { isIncoming: false, phoneNumber: "" },
  assignedNumber: null,
};

/** Mirrors the geometry constants in electron/main.ts. */
export const DEFAULT_SIDEBAR_CONFIG: SidebarConfig = {
  dockEdge: "right",
  expanded: false,
  aux: false,
  strip: 56,
  panelWidth: 380,
  panelHeight: 520,
  auxWidth: 300,
  gap: 10,
};

/** True when this renderer is the docked sidebar window. */
export const isSidebarWindow = () =>
  typeof window !== "undefined" && window.location.hash.startsWith("#/sidebar");
