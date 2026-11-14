import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("electronAPI", {
  isElectron: true,

  notifyIncomingCall(caller: { number: string; name?: string }) {
    ipcRenderer.send("incoming-call", caller);
  },

  notifyCallAnswered() {
    ipcRenderer.send("call-answered");
  },

  notifyCallEnded() {
    ipcRenderer.send("call-ended");
  },

  showCallOverlay(caller: { number: string; name?: string }) {
    ipcRenderer.send("show-call-overlay", caller);
  },

  hideCallOverlay() {
    ipcRenderer.send("hide-call-overlay");
  },

  onAnswerCall(callback: () => void) {
    ipcRenderer.on("answer-call", () => callback());
  },

  onDeclineCall(callback: () => void) {
    ipcRenderer.on("decline-call", () => callback());
  },

  // ── Picture-in-Picture call card ──────────────────────────────────────
  showCallPip(state: CallPipState) {
    ipcRenderer.send("show-call-pip", state);
  },

  updateCallPip(state: CallPipState) {
    ipcRenderer.send("update-call-pip", state);
  },

  hideCallPip() {
    ipcRenderer.send("hide-call-pip");
  },

  // Forwards mute/hold/end/maximize presses from the floating card. Only one
  // handler is kept active to avoid stacking listeners across re-mounts.
  onPipAction(callback: (action: string) => void) {
    ipcRenderer.removeAllListeners("pip-action");
    ipcRenderer.on("pip-action", (_e, action: string) => callback(action));
  },

  removePipActionListeners() {
    ipcRenderer.removeAllListeners("pip-action");
    ipcRenderer.removeAllListeners("pip-note-change");
  },

  /** Send the saved note body into the floating card's notes drawer. */
  sendPipNote(text: string) {
    ipcRenderer.send("pip-note-text", text);
  },

  /** Receive edits made in the floating card's notes drawer. */
  onPipNoteChange(callback: (text: string) => void) {
    ipcRenderer.removeAllListeners("pip-note-change");
    ipcRenderer.on("pip-note-change", (_e, text: string) => callback(text));
  },

  // ── Sidebar Mode ──────────────────────────────────────────────────────
  // UI-only bridge. The main window keeps the single WebRTC/SIP session; the
  // sidebar window mirrors its state and posts actions back to it.
  sidebar: {
    /** True inside the docked sidebar window (hash route #/sidebar). */
    isSidebarWindow: String(
      (globalThis as { location?: { hash?: string } }).location?.hash ?? "",
    ).startsWith("#/sidebar"),

    getMode(): Promise<boolean> {
      return ipcRenderer.invoke("sidebar:get-mode");
    },
    enter() {
      ipcRenderer.send("sidebar:enter");
    },
    exit() {
      ipcRenderer.send("sidebar:exit");
    },
    toggle() {
      ipcRenderer.send("sidebar:toggle");
    },
    /** The call shell has mounted; a persisted sidebar mode may now restore. */
    shellReady() {
      ipcRenderer.send("sidebar:shell-ready");
    },
    dock(edge: "left" | "top" | "right") {
      ipcRenderer.send("sidebar:dock", edge);
    },
    /**
     * Grow/shrink the docked window around the slide-out panel. `aux` extends a
     * second panel (call notes) alongside it.
     */
    setExpanded(expanded: boolean, aux?: boolean) {
      ipcRenderer.send("sidebar:set-expanded", expanded, !!aux);
    },
    /** Pull attention to the strip without stealing keyboard focus. */
    alert() {
      ipcRenderer.send("sidebar:alert");
    },

    // Main window → sidebar window
    pushState(state: unknown) {
      ipcRenderer.send("sidebar:state", state);
    },
    onState(callback: (state: unknown) => void) {
      ipcRenderer.removeAllListeners("sidebar:state");
      ipcRenderer.on("sidebar:state", (_e, state) => callback(state));
    },

    /** Relay a toast to the strip — the full window is hidden while docked. */
    pushToast(payload: unknown) {
      ipcRenderer.send("sidebar:toast", payload);
    },
    onToast(callback: (payload: unknown) => void) {
      ipcRenderer.removeAllListeners("sidebar:toast");
      ipcRenderer.on("sidebar:toast", (_e, payload) => callback(payload));
    },

    // Sidebar window → main window
    sendAction(action: { type: string; payload?: unknown }) {
      ipcRenderer.send("sidebar:action", action);
    },
    onAction(callback: (action: { type: string; payload?: unknown }) => void) {
      ipcRenderer.removeAllListeners("sidebar:action");
      ipcRenderer.on("sidebar:action", (_e, action) => callback(action));
    },

    onConfig(callback: (config: unknown) => void) {
      ipcRenderer.removeAllListeners("sidebar:config");
      ipcRenderer.on("sidebar:config", (_e, config) => callback(config));
    },
    onForceCollapse(callback: () => void) {
      ipcRenderer.removeAllListeners("sidebar:force-collapse");
      ipcRenderer.on("sidebar:force-collapse", () => callback());
    },
    onBlur(callback: () => void) {
      ipcRenderer.removeAllListeners("sidebar:blur");
      ipcRenderer.on("sidebar:blur", () => callback());
    },
    onModeChange(callback: (enabled: boolean) => void) {
      ipcRenderer.removeAllListeners("sidebar:mode");
      ipcRenderer.on("sidebar:mode", (_e, enabled: boolean) => callback(enabled));
    },
    onRequestState(callback: () => void) {
      ipcRenderer.removeAllListeners("sidebar:request-state");
      ipcRenderer.on("sidebar:request-state", () => callback());
    },
    removeAllListeners() {
      [
        "sidebar:state",
        "sidebar:action",
        "sidebar:config",
        "sidebar:force-collapse",
        "sidebar:blur",
        "sidebar:mode",
        "sidebar:request-state",
        "sidebar:toast",
      ].forEach((c) => ipcRenderer.removeAllListeners(c));
    },
  },
});

interface CallPipState {
  callerName?: string;
  callerNumber?: string;
  duration?: number;
  isMuted?: boolean;
  isOnHold?: boolean;
}
