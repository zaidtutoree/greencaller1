import type {
  SidebarAction,
  SidebarConfig,
  SidebarDockEdge,
  SidebarState,
  SidebarToast,
} from "@/components/sidebar-mode/types";

export {};

interface CallPipState {
  callerName?: string;
  callerNumber?: string;
  duration?: number;
  isMuted?: boolean;
  isOnHold?: boolean;
  isRecording?: boolean;
  isPaused?: boolean;
  canNote?: boolean;
  /** Enterprise only, mirroring the in-app call card. */
  canTransfer?: boolean;
  /** Premium and enterprise only. */
  canRecord?: boolean;
}

/**
 * Sidebar Mode bridge. Purely a UI transport: the main window stays the single
 * owner of the call session and the sidebar window only mirrors/forwards.
 */
interface SidebarAPI {
  /** True inside the docked sidebar window (hash route `#/sidebar`). */
  isSidebarWindow: boolean;
  getMode(): Promise<boolean>;
  enter(): void;
  exit(): void;
  toggle(): void;
  /** The call shell has mounted; a persisted sidebar mode may now restore. */
  shellReady(): void;
  dock(edge: SidebarDockEdge): void;
  /**
   * Grow/shrink the docked window around the slide-out panel. `aux` extends a
   * second panel (call notes) alongside it.
   */
  setExpanded(expanded: boolean, aux?: boolean): void;
  /** Pull attention to the strip without stealing keyboard focus. */
  alert(): void;
  pushState(state: SidebarState): void;
  onState(callback: (state: SidebarState) => void): void;
  /** Relay a toast to the strip — the full window is hidden while docked. */
  pushToast(payload: SidebarToast): void;
  onToast(callback: (payload: SidebarToast) => void): void;
  sendAction(action: SidebarAction): void;
  onAction(callback: (action: SidebarAction) => void): void;
  onConfig(callback: (config: SidebarConfig) => void): void;
  onForceCollapse(callback: () => void): void;
  onBlur(callback: () => void): void;
  onModeChange(callback: (enabled: boolean) => void): void;
  onRequestState(callback: () => void): void;
  removeAllListeners(): void;
}

interface ElectronAPI {
  isElectron: true;
  notifyIncomingCall(caller: { number: string; name?: string }): void;
  notifyCallAnswered(): void;
  notifyCallEnded(): void;
  showCallOverlay(caller: { number: string; name?: string }): void;
  hideCallOverlay(): void;
  onAnswerCall(callback: () => void): void;
  onDeclineCall(callback: () => void): void;
  showCallPip(state: CallPipState): void;
  updateCallPip(state: CallPipState): void;
  hideCallPip(): void;
  onPipAction(callback: (action: string) => void): void;
  removePipActionListeners(): void;
  /** Send the saved note body into the floating card's notes drawer. */
  sendPipNote(text: string): void;
  /** Receive edits made in the floating card's notes drawer. */
  onPipNoteChange(callback: (text: string) => void): void;
  sidebar?: SidebarAPI;
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI;
  }
}
