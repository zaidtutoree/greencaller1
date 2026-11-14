import {
  app,
  BrowserWindow,
  ipcMain,
  Notification,
  Tray,
  Menu,
  nativeImage,
  screen,
  powerSaveBlocker,
  globalShortcut,
} from "electron";
import path from "path";
import fs from "fs";

// Set app identity BEFORE anything else — Windows uses this for taskbar & notifications.
// In dev the executable is the unbranded node_modules electron.exe ("Electron"); give it
// a SEPARATE id so dev runs never share the shipped app's taskbar identity / jump list
// (which is what made an "Electron" entry show up when right-clicking the taskbar button).
app.name = "Greencaller";
if (process.platform === "win32") {
  app.setAppUserModelId(app.isPackaged ? "com.greencaller.desktop" : "com.greencaller.desktop.dev");
}

// Defensive: never expose a custom Jump List (tasks/recent) for the app.
app.whenReady().then(() => {
  try {
    app.setJumpList?.(null);
  } catch {
    // setJumpList can throw if the shell rejects it; safe to ignore.
  }
});

let mainWindow: BrowserWindow | null = null;
let overlayWindow: BrowserWindow | null = null;
let pipWindow: BrowserWindow | null = null;
let latestPipState: PipCallState | null = null;
let sidebarWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let powerSaveId: number | null = null;
let isQuitting = false;

// In dev mode we load from localhost; in preview/packaged mode we load from dist/
// Check if a dev server is actually running by looking for the ELECTRON_DEV env var
const isDev = !app.isPackaged && process.argv.includes("--dev");
const iconPath = isDev
  ? path.join(__dirname, "..", "public", "app-icon.ico")
  : path.join(process.resourcesPath, "app-icon.ico");

// Pre-load the icon as a nativeImage for use everywhere
// Try multiple paths — extraResources copies to resources/, but in some builds
// the ico may also live next to the exe or inside the asar.
const iconCandidates = isDev
  ? [path.join(__dirname, "..", "public", "app-icon.ico")]
  : [
      path.join(process.resourcesPath, "app-icon.ico"),
      path.join(path.dirname(app.getPath("exe")), "app-icon.ico"),
      path.join(__dirname, "..", "public", "app-icon.ico"),
      path.join(__dirname, "..", "dist", "app-icon.ico"),
    ];

let appIcon: Electron.NativeImage = nativeImage.createEmpty();
for (const candidate of iconCandidates) {
  try {
    if (fs.existsSync(candidate)) {
      const loaded = nativeImage.createFromPath(candidate);
      if (!loaded.isEmpty()) {
        appIcon = loaded;
        console.log("Loaded app icon from:", candidate);
        break;
      }
    }
  } catch {
    // try next
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────

/** Bring the main window to the foreground no matter what state it's in. */
function bringWindowToFront() {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.setAlwaysOnTop(true);   // force above other windows
  mainWindow.focus();
  mainWindow.setAlwaysOnTop(false);  // then release so it behaves normally
}

// ── Window creation ───────────────────────────────────────────────────────

function createMainWindow() {
  // Try to load icon from multiple locations
  let windowIcon = appIcon;
  if (windowIcon.isEmpty()) {
    const extraPaths = [
      path.join(__dirname, "..", "public", "app-icon.ico"),
      path.join(process.resourcesPath || "", "app-icon.ico"),
      path.join(path.dirname(app.getPath("exe")), "resources", "app-icon.ico"),
    ];
    for (const p of extraPaths) {
      try {
        if (fs.existsSync(p)) {
          const img = nativeImage.createFromPath(p);
          if (!img.isEmpty()) { windowIcon = img; break; }
        }
      } catch {}
    }
  }

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: "Greencaller",
    icon: windowIcon,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });

  // Force set the icon after creation as well
  if (!windowIcon.isEmpty()) {
    mainWindow.setIcon(windowIcon);
    // Reapply once the page is ready — Windows occasionally drops the taskbar
    // (big) icon if it's set before the window is fully realised.
    mainWindow.once("ready-to-show", () => {
      if (mainWindow && !windowIcon.isEmpty()) mainWindow.setIcon(windowIcon);
    });
  }

  // Remove the menu bar entirely
  mainWindow.setMenuBarVisibility(false);
  Menu.setApplicationMenu(null);

  // Keep WebSocket / WebRTC alive when hidden or minimized
  mainWindow.webContents.setBackgroundThrottling(false);

  if (isDev) {
    mainWindow.loadURL("http://localhost:8081");
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  }

  // ── Close → hide to tray (don't destroy) ──────────────────────────────
  mainWindow.on("close", (e) => {
    if (!isQuitting) {
      e.preventDefault();
      mainWindow?.hide();
    }
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  // Prevent the OS from suspending the process (keeps SIP registered)
  if (powerSaveId === null) {
    powerSaveId = powerSaveBlocker.start("prevent-app-suspension");
  }
}

// ── System Tray ───────────────────────────────────────────────────────────

function buildTrayMenu() {
  const p = loadPrefs();
  return Menu.buildFromTemplate([
    {
      label: "Show Greencaller",
      click: () => exitSidebarMode(),
    },
    { type: "separator" },
    {
      label: "Sidebar mode",
      type: "checkbox",
      checked: p.sidebarMode,
      click: () => {
        if (isSidebarMode()) exitSidebarMode();
        else enterSidebarMode();
      },
    },
    {
      label: "Dock to",
      submenu: [
        { label: "Left", type: "radio", checked: p.dockEdge === "left", click: () => setDockEdge("left") },
        { label: "Top", type: "radio", checked: p.dockEdge === "top", click: () => setDockEdge("top") },
        { label: "Right", type: "radio", checked: p.dockEdge === "right", click: () => setDockEdge("right") },
      ],
    },
    { type: "separator" },
    {
      label: "Quit",
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);
}

function refreshTrayMenu() {
  tray?.setContextMenu(buildTrayMenu());
}

function createTray() {
  const trayIcon = appIcon.resize({ width: 16, height: 16 });
  tray = new Tray(trayIcon);
  tray.setToolTip("Greencaller");

  tray.setContextMenu(buildTrayMenu());

  // Single-click on tray icon → show whichever surface the user is in.
  tray.on("click", () => {
    if (isSidebarMode()) alertSidebar();
    else bringWindowToFront();
  });
}

// ── IPC Handlers ──────────────────────────────────────────────────────────

let activeNotification: Electron.Notification | null = null;

function dismissNotification() {
  if (activeNotification) {
    activeNotification.close();
    activeNotification = null;
  }
}

ipcMain.on("incoming-call", (_event, caller: { number: string; name?: string }) => {
  if (!mainWindow) return;

  // Dismiss any previous notification
  dismissNotification();

  if (isSidebarMode()) {
    // Docked: surface the strip (which extends its own Incoming Call panel)
    // instead of restoring the full app. Deliberately does NOT steal focus.
    alertSidebar();
  } else {
    // Flash taskbar
    mainWindow.flashFrame(true);

    // Always bring window to front on incoming call (even from tray)
    bringWindowToFront();
  }

  // Show native Windows notification with action buttons
  const title = caller.name || caller.number || "Unknown Caller";
  activeNotification = new Notification({
    title: "Incoming Call",
    body: `${title} is calling...`,
    icon: appIcon,
    urgency: "critical",
    actions: [
      { type: "button", text: "Answer" },
      { type: "button", text: "Decline" },
    ],
  });

  activeNotification.on("action", (_event, index) => {
    if (index === 0) {
      mainWindow?.webContents.send("answer-call");
    } else if (index === 1) {
      mainWindow?.webContents.send("decline-call");
    }
    dismissNotification();
  });

  activeNotification.on("click", () => {
    if (isSidebarMode()) alertSidebar();
    else bringWindowToFront();
    dismissNotification();
  });

  activeNotification.on("close", () => {
    activeNotification = null;
  });

  activeNotification.show();
});

ipcMain.on("call-answered", () => {
  if (!mainWindow) return;
  dismissNotification();
  mainWindow.flashFrame(false);
});

ipcMain.on("call-ended", () => {
  dismissNotification();
  mainWindow?.flashFrame(false);
  hideCallOverlay();
  hideCallPip();
});

// ── Mini Call Overlay ─────────────────────────────────────────────────────

function createCallOverlay(caller: { number: string; name?: string }) {
  if (overlayWindow) {
    overlayWindow.close();
    overlayWindow = null;
  }

  const { width, height } = screen.getPrimaryDisplay().workAreaSize;

  overlayWindow = new BrowserWindow({
    width: 320,
    height: 100,
    x: width - 340,
    y: height - 120,
    frame: false,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    transparent: true,
    webPreferences: {
      contextIsolation: false,
      nodeIntegration: true,
    },
  });

  const callerLabel = caller.name || caller.number || "Unknown";
  const overlayHtml = `data:text/html;charset=utf-8,${encodeURIComponent(`
    <!DOCTYPE html>
    <html>
    <head>
      <style>
        body {
          margin: 0; font-family: system-ui, sans-serif;
          background: rgba(30,30,30,0.95); color: #fff;
          border-radius: 12px; padding: 16px; display: flex;
          align-items: center; gap: 12px; user-select: none;
          -webkit-app-region: drag;
        }
        .info { flex: 1; overflow: hidden; }
        .info .label { font-size: 11px; color: #aaa; }
        .info .name { font-size: 14px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        button { -webkit-app-region: no-drag; border: none; border-radius: 50%; width: 36px; height: 36px; cursor: pointer; display: flex; align-items: center; justify-content: center; font-size: 16px; }
        .answer { background: #22c55e; color: #fff; }
        .decline { background: #ef4444; color: #fff; }
      </style>
    </head>
    <body>
      <div class="info">
        <div class="label">Incoming Call</div>
        <div class="name">${callerLabel}</div>
      </div>
      <button class="answer" onclick="require('electron').ipcRenderer.send('overlay-answer')">&#9742;</button>
      <button class="decline" onclick="require('electron').ipcRenderer.send('overlay-decline')">&#10005;</button>
    </body>
    </html>
  `)}`;

  overlayWindow.loadURL(overlayHtml);
  overlayWindow.on("closed", () => {
    overlayWindow = null;
  });
}

function hideCallOverlay() {
  if (overlayWindow) {
    overlayWindow.close();
    overlayWindow = null;
  }
}

ipcMain.on("show-call-overlay", (_event, caller: { number: string; name?: string }) => {
  createCallOverlay(caller);
});

ipcMain.on("hide-call-overlay", () => {
  hideCallOverlay();
});

ipcMain.on("overlay-answer", () => {
  mainWindow?.webContents.send("answer-call");
  hideCallOverlay();
});

ipcMain.on("overlay-decline", () => {
  mainWindow?.webContents.send("decline-call");
  hideCallOverlay();
});

// ── Picture-in-Picture Call Window ─────────────────────────────────────────
// A native always-on-top mini call card (à la Google Meet) that stays visible
// over other apps while a call is active. It does NOT own the call — every
// button is forwarded to the renderer (which owns the WebRTC session) via
// `pip-action`, and the renderer pushes state back in with `update-call-pip`.

interface PipCallState {
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

/** Floating card geometry. The keypad grows the window rather than overlaying. */
const PIP_WIDTH = 304;
const PIP_HEIGHT = 140;
const PIP_KEYPAD_EXTRA = 172;
const PIP_NOTES_EXTRA = 166;

function renderPipHtml(state: PipCallState): string {
  // The initial state is embedded so the window paints correctly on first load;
  // subsequent updates arrive over the `pip-state` channel.
  const initial = JSON.stringify(state).replace(/</g, "\\u003c");
  return `data:text/html;charset=utf-8,${encodeURIComponent(`
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8" />
      <style>
        * { box-sizing: border-box; }
        html, body { margin: 0; height: 100%; overflow: hidden; }
        body {
          font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
          background: transparent; user-select: none;
        }
        .card {
          height: 100%;
          background: linear-gradient(145deg, rgba(22,101,52,0.97), rgba(20,83,45,0.99));
          border: 1px solid rgba(255,255,255,0.18);
          border-radius: 14px;
          box-shadow: 0 18px 40px -12px rgba(0,0,0,0.6);
          color: #fff; display: flex; flex-direction: column;
          -webkit-app-region: drag; overflow: hidden;
        }
        .top { display: flex; align-items: center; gap: 10px; padding: 12px 14px 4px; }
        .dot { width: 9px; height: 9px; border-radius: 50%; background: #4ade80; flex: 0 0 auto;
               box-shadow: 0 0 0 0 rgba(74,222,128,0.6); animation: pulse 1.8s infinite; }
        @keyframes pulse { 0%{box-shadow:0 0 0 0 rgba(74,222,128,0.5);} 70%{box-shadow:0 0 0 7px rgba(74,222,128,0);} 100%{box-shadow:0 0 0 0 rgba(74,222,128,0);} }
        .info { flex: 1; min-width: 0; }
        .name { font-size: 13px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .meta { font-size: 11px; color: rgba(255,255,255,0.7); margin-top: 1px;
                white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .max { -webkit-app-region: no-drag; cursor: pointer; flex: 0 0 auto;
               width: 26px; height: 26px; border: none; border-radius: 8px;
               background: rgba(255,255,255,0.14); color: #fff; display: flex;
               align-items: center; justify-content: center; }
        .max:hover { background: rgba(255,255,255,0.26); }
        .row { display: flex; gap: 6px; padding: 8px 14px 14px; -webkit-app-region: no-drag; }
        .btn { flex: 1; height: 38px; border: none; border-radius: 10px; cursor: pointer;
               background: rgba(255,255,255,0.14); color: #fff; display: flex;
               align-items: center; justify-content: center; transition: background .15s, transform .1s; }
        .btn:hover { background: rgba(255,255,255,0.24); }
        .btn:active { transform: scale(0.94); }
        .btn.active { background: #fff; color: #166534; }
        .btn.rec { background: #ef4444; }
        .btn.end { background: #ef4444; }
        .btn.end:hover { background: #dc2626; }
        svg { width: 17px; height: 17px; }
        /* DTMF keypad — expands the window rather than covering the controls. */
        .pad { display: none; padding: 0 14px 14px; -webkit-app-region: no-drag; }
        .pad.open { display: block; }
        .padgrid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; }
        .key { height: 34px; border: none; border-radius: 9px; cursor: pointer;
               background: rgba(255,255,255,0.12); color: #fff; font-size: 15px;
               font-weight: 600; font-family: inherit; transition: background .12s, transform .1s; }
        .key:hover { background: rgba(255,255,255,0.22); }
        .key:active, .key.hit { background: #fff; color: #166534; transform: scale(0.94); }
        /* Notes drawer — edits the call note in place, no need for the app. */
        .notes { display: none; padding: 0 14px 14px; -webkit-app-region: no-drag; }
        .notes.open { display: block; }
        .notes textarea {
          width: 100%; height: 120px; resize: none; box-sizing: border-box;
          background: rgba(0,0,0,0.22); border: 1px solid rgba(255,255,255,0.16);
          border-radius: 10px; color: #fff; font-family: inherit; font-size: 12px;
          line-height: 1.45; padding: 8px 10px; outline: none;
        }
        .notes textarea::placeholder { color: rgba(255,255,255,0.45); }
        .notes textarea:focus { border-color: rgba(255,255,255,0.34); }
        .noterow { display: flex; align-items: center; justify-content: space-between;
                   margin-top: 6px; font-size: 10px; color: rgba(255,255,255,0.6); }
      </style>
    </head>
    <body>
      <div class="card">
        <div class="top">
          <span class="dot"></span>
          <div class="info">
            <div class="name" id="name">Connecting…</div>
            <div class="meta"><span id="num"></span> · <span id="time">0:00</span></div>
          </div>
          <button class="max" id="note" title="Add note" style="display:none">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
          </button>
          <button class="max" id="max" title="Back to app">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>
          </button>
        </div>
        <div class="row">
          <button class="btn" id="mute" title="Mute"></button>
          <button class="btn" id="hold" title="Hold"></button>
          <button class="btn" id="keypad" title="Keypad">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>
          </button>
          <button class="btn" id="transfer" title="Transfer call" style="display:none">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>
          </button>
          <button class="btn" id="record" title="Record" style="display:none"></button>
          <button class="btn end" id="end" title="End call">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7 2 2 0 0 1 1.72 2v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.42 19.42 0 0 1-3.33-2.67m-2.67-3.34a19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91"/><line x1="23" y1="1" x2="1" y2="23"/></svg>
          </button>
        </div>
        <div class="pad" id="pad">
          <div class="padgrid">
            <button class="key">1</button><button class="key">2</button><button class="key">3</button>
            <button class="key">4</button><button class="key">5</button><button class="key">6</button>
            <button class="key">7</button><button class="key">8</button><button class="key">9</button>
            <button class="key">*</button><button class="key">0</button><button class="key">#</button>
          </div>
        </div>
        <div class="notes" id="notes">
          <textarea id="notetext" placeholder="Write notes about this call…"></textarea>
          <div class="noterow"><span id="notestatus">Saves automatically</span></div>
        </div>
      </div>
      <script>
        const { ipcRenderer } = require('electron');
        const MIC = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>';
        const MIC_OFF = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="1" y1="1" x2="23" y2="23"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"/><path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>';
        const PAUSE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>';
        const PLAY = '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><polygon points="5 3 19 12 5 21 5 3"/></svg>';
        const DOT = '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><circle cx="12" cy="12" r="7"/></svg>';
        const DOT_O = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="7"/></svg>';
        function fmt(s){ s = s||0; const m=Math.floor(s/60), x=s%60; return m+':'+String(x).padStart(2,'0'); }
        function render(st){
          document.getElementById('name').textContent = st.callerName || st.callerNumber || 'Unknown';
          document.getElementById('num').textContent = st.callerName ? (st.callerNumber||'') : '';
          document.getElementById('time').textContent = fmt(st.duration);
          const mute = document.getElementById('mute');
          mute.classList.toggle('active', !!st.isMuted);
          mute.innerHTML = st.isMuted ? MIC_OFF : MIC;
          const hold = document.getElementById('hold');
          hold.classList.toggle('active', !!st.isOnHold);
          hold.innerHTML = st.isOnHold ? PLAY : PAUSE;
          document.getElementById('note').style.display = st.canNote ? 'flex' : 'none';
          // Transfer and Record mirror the in-app card's account gating.
          document.getElementById('transfer').style.display = st.canTransfer ? 'flex' : 'none';
          const rec = document.getElementById('record');
          rec.style.display = st.canRecord ? 'flex' : 'none';
          const recOn = !!st.isRecording && !st.isPaused;
          rec.classList.toggle('rec', recOn);
          rec.innerHTML = recOn ? DOT : DOT_O;
          rec.title = st.isRecording ? (st.isPaused ? 'Resume recording' : 'Pause recording') : 'Record';
        }
        document.getElementById('mute').onclick = () => ipcRenderer.send('pip-action', 'mute');
        document.getElementById('hold').onclick = () => ipcRenderer.send('pip-action', 'hold');
        document.getElementById('end').onclick  = () => ipcRenderer.send('pip-action', 'end');
        document.getElementById('max').onclick  = () => ipcRenderer.send('pip-action', 'maximize');
        document.getElementById('record').onclick = () => ipcRenderer.send('pip-action', 'record');
        document.getElementById('transfer').onclick = () => ipcRenderer.send('pip-action', 'transfer');

        // Keypad: grows the window instead of covering the controls, so the
        // call info and Hang Up stay reachable while sending DTMF.
        const pad = document.getElementById('pad');
        const keypadBtn = document.getElementById('keypad');
        keypadBtn.onclick = () => {
          const open = !pad.classList.contains('open');
          pad.classList.toggle('open', open);
          keypadBtn.classList.toggle('active', open);
          ipcRenderer.send('pip-keypad', open);
        };
        document.querySelectorAll('.key').forEach((k) => {
          k.onclick = () => {
            ipcRenderer.send('pip-action', 'dtmf:' + k.textContent);
            k.classList.add('hit');
            setTimeout(() => k.classList.remove('hit'), 140);
          };
        });

        // Notes drawer: edits the call note right here rather than restoring the
        // whole app. The text travels over IPC to the window that owns the
        // Supabase session, which upserts it against the same call_ref.
        const notesEl = document.getElementById('notes');
        const noteBtn = document.getElementById('note');
        const noteText = document.getElementById('notetext');
        const noteStatus = document.getElementById('notestatus');
        let saveTimer = null;

        noteBtn.onclick = () => {
          const open = !notesEl.classList.contains('open');
          notesEl.classList.toggle('open', open);
          noteBtn.classList.toggle('active', open);
          ipcRenderer.send('pip-notes', open);
          if (open) {
            ipcRenderer.send('pip-note-load');
            setTimeout(() => noteText.focus(), 60);
          } else {
            flush();
          }
        };

        function flush() {
          if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
          ipcRenderer.send('pip-note-change', noteText.value);
          noteStatus.textContent = 'Saved';
        }

        noteText.addEventListener('input', () => {
          noteStatus.textContent = 'Saving…';
          if (saveTimer) clearTimeout(saveTimer);
          saveTimer = setTimeout(flush, 600);
        });

        // The note body arrives on its own channel, never inside pip-state —
        // state updates tick every second and would clobber what's being typed.
        ipcRenderer.on('pip-note-load', (_e, text) => {
          noteText.value = text || '';
          noteStatus.textContent = 'Saves automatically';
        });

        ipcRenderer.on('pip-state', (_e, st) => render(st));
        render(${initial});
      </script>
    </body>
    </html>
  `)}`;
}

function createCallPip(state: PipCallState) {
  latestPipState = state;
  if (pipWindow) {
    pipWindow.webContents.send("pip-state", state);
    pipWindow.show();
    return;
  }

  const { width } = screen.getPrimaryDisplay().workAreaSize;
  pipWindow = new BrowserWindow({
    width: PIP_WIDTH,
    height: PIP_HEIGHT,
    x: width - PIP_WIDTH - 20,
    y: 24,
    frame: false,
    alwaysOnTop: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    transparent: true,
    hasShadow: false,
    fullscreenable: false,
    webPreferences: {
      contextIsolation: false,
      nodeIntegration: true,
    },
  });

  // Float above full-screen apps too (matches the incoming-call overlay).
  pipWindow.setAlwaysOnTop(true, "screen-saver");
  pipWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  pipWindow.loadURL(renderPipHtml(state));
  // Re-push the latest state once the card's script is ready, in case it
  // changed between window creation and first paint.
  pipWindow.webContents.on("did-finish-load", () => {
    if (latestPipState) pipWindow?.webContents.send("pip-state", latestPipState);
  });
  pipWindow.on("closed", () => {
    pipWindow = null;
  });
}

function hideCallPip() {
  latestPipState = null;
  pipKeypadOpen = false;
  pipNotesOpen = false;
  if (pipWindow) {
    pipWindow.close();
    pipWindow = null;
  }
}

// The card's two drawers (DTMF keypad, notes) grow the window instead of
// covering the controls. Only one is open at a time on the page, so tracking a
// single extra-height value here is enough.
let pipKeypadOpen = false;
let pipNotesOpen = false;

function resizePip() {
  if (!pipWindow || pipWindow.isDestroyed()) return;
  const b = pipWindow.getBounds();
  const extra =
    (pipKeypadOpen ? PIP_KEYPAD_EXTRA : 0) + (pipNotesOpen ? PIP_NOTES_EXTRA : 0);
  const height = PIP_HEIGHT + extra;
  const wa = screen.getDisplayNearestPoint({ x: b.x + b.width / 2, y: b.y }).workArea;
  // Keep the whole card on-screen when it grows downward.
  const y = Math.min(b.y, wa.y + wa.height - height - 8);
  pipWindow.setBounds({ x: b.x, y: Math.max(wa.y + 8, y), width: b.width, height });
}

/** Grow/shrink the floating card when its DTMF keypad is toggled. */
ipcMain.on("pip-keypad", (_e, open: boolean) => {
  pipKeypadOpen = !!open;
  resizePip();
});

/** Grow/shrink the floating card when its notes drawer is toggled. */
ipcMain.on("pip-notes", (_e, open: boolean) => {
  pipNotesOpen = !!open;
  resizePip();
});

/** The card wants the existing note for this call — only the app can read it. */
ipcMain.on("pip-note-load", () => {
  mainWindow?.webContents.send("pip-action", "note-load");
});

/** The card's note text changed — the app owns the Supabase session, so it saves. */
ipcMain.on("pip-note-change", (_e, text: string) => {
  mainWindow?.webContents.send("pip-note-change", typeof text === "string" ? text : "");
});

/** App → card: the note body, on its own channel so state ticks can't clobber it. */
ipcMain.on("pip-note-text", (_e, text: string) => {
  pipWindow?.webContents.send("pip-note-load", typeof text === "string" ? text : "");
});

ipcMain.on("show-call-pip", (_event, state: PipCallState) => {
  createCallPip(state || {});
});

ipcMain.on("update-call-pip", (_event, state: PipCallState) => {
  latestPipState = state;
  pipWindow?.webContents.send("pip-state", state);
});

ipcMain.on("hide-call-pip", () => {
  hideCallPip();
});

ipcMain.on("pip-action", (_event, action: string) => {
  // "maximize" returns the call to whichever surface the user came from: the
  // docked strip if they popped out from there, otherwise the full window.
  if (action === "maximize") {
    mainWindow?.webContents.send("pip-action", action);
    hideCallPip();
    if (isSidebarMode()) alertSidebar();
    else bringWindowToFront();
    return;
  }
  // Transfer needs a target picker, so it's the one action that restores the
  // full app. (Notes are edited in the card's own drawer.)
  if (action === "transfer") {
    if (isSidebarMode()) exitSidebarMode();
    bringWindowToFront();
    mainWindow?.webContents.send("pip-action", action);
    hideCallPip();
    return;
  }
  // mute / hold / record / dtmf:<digit> / end → let the renderer drive the
  // actual call; the card stays open and re-renders from the pushed state.
  mainWindow?.webContents.send("pip-action", action);
});

// ── Sidebar Mode ──────────────────────────────────────────────────────────
// A slim, always-on-top, frameless glass strip docked to a screen edge. It is a
// SECOND window, but NOT a second telephony client: the sidebar renderer mounts
// the `#/sidebar` route, which never mounts `useCallProvider`. The main window
// stays alive (hidden) and remains the sole owner of the WebRTC/SIP session —
// the sidebar mirrors its state and forwards button presses back over IPC,
// exactly like the floating PiP card above. Call architecture is untouched.

type DockEdge = "left" | "top" | "right";

/** Slim strip thickness. */
const STRIP = 56;
/** Strip length. Matched to PANEL_H on vertical docks so the strip never
 *  shifts when a panel opens — only the window's docked-edge axis grows. */
const STRIP_LEN_V = 520;
/** Long enough for the full icon set laid out left-to-right without scrolling. */
const STRIP_LEN_H = 520;
const PANEL_W = 380;
const PANEL_H = 520;
/** Secondary panel (call notes) that extends alongside an open panel. */
const AUX_W = 300;
/** Visual gap drawn between the strip and the panel (inside the window). */
const PANEL_GAP = 10;
/** Distance kept from the display's work-area edge. */
const EDGE_MARGIN = 12;

interface SidebarPrefs {
  sidebarMode: boolean;
  dockEdge: DockEdge;
  /** Top-left of the COLLAPSED strip, in screen coordinates. */
  stripX: number | null;
  stripY: number | null;
}

const DEFAULT_PREFS: SidebarPrefs = {
  sidebarMode: false,
  dockEdge: "right",
  stripX: null,
  stripY: null,
};

let prefs: SidebarPrefs = { ...DEFAULT_PREFS };
let prefsLoaded = false;
let sidebarExpanded = false;
/** A secondary panel (call notes) is extended alongside the open panel. */
let sidebarAux = false;
/** Bounds of the main window before we hid it, so "expand" restores exactly. */
let mainWindowBounds: Electron.Rectangle | null = null;
/** Launch restore is deferred until the renderer's call shell reports ready. */
let pendingSidebarRestore = false;

function prefsPath() {
  return path.join(app.getPath("userData"), "sidebar-mode.json");
}

function loadPrefs(): SidebarPrefs {
  if (prefsLoaded) return prefs;
  prefsLoaded = true;
  try {
    // Strip a UTF-8 BOM if the file was ever written by another tool.
    const raw = fs.readFileSync(prefsPath(), "utf-8").replace(/^﻿/, "");
    const parsed = JSON.parse(raw) as Partial<SidebarPrefs>;
    prefs = {
      sidebarMode: !!parsed.sidebarMode,
      dockEdge:
        parsed.dockEdge === "left" || parsed.dockEdge === "top" || parsed.dockEdge === "right"
          ? parsed.dockEdge
          : "right",
      stripX: typeof parsed.stripX === "number" ? parsed.stripX : null,
      stripY: typeof parsed.stripY === "number" ? parsed.stripY : null,
    };
  } catch {
    prefs = { ...DEFAULT_PREFS };
  }
  return prefs;
}

function savePrefs() {
  try {
    fs.writeFileSync(prefsPath(), JSON.stringify(prefs, null, 2), "utf-8");
  } catch (err) {
    console.error("Failed to persist sidebar prefs:", err);
  }
}

const clamp = (value: number, min: number, max: number) =>
  Math.round(Math.max(min, Math.min(max, value)));

/** The collapsed strip rect for the current dock edge, clamped on-screen. */
function computeStripRect(): Electron.Rectangle {
  const p = loadPrefs();
  const isVertical = p.dockEdge !== "top";
  const len = isVertical ? STRIP_LEN_V : STRIP_LEN_H;

  // Resolve the display from the last known anchor (multi-monitor safe).
  const anchor =
    p.stripX !== null && p.stripY !== null
      ? { x: p.stripX + STRIP / 2, y: p.stripY + STRIP / 2 }
      : null;
  const display = anchor
    ? screen.getDisplayNearestPoint(anchor)
    : screen.getPrimaryDisplay();
  const wa = display.workArea;

  if (p.dockEdge === "top") {
    return {
      x: clamp(p.stripX ?? wa.x + (wa.width - len) / 2, wa.x + EDGE_MARGIN, wa.x + wa.width - len - EDGE_MARGIN),
      y: wa.y + EDGE_MARGIN,
      width: len,
      height: STRIP,
    };
  }

  const x =
    p.dockEdge === "left"
      ? wa.x + EDGE_MARGIN
      : wa.x + wa.width - STRIP - EDGE_MARGIN;

  return {
    x,
    y: clamp(p.stripY ?? wa.y + (wa.height - len) / 2, wa.y + EDGE_MARGIN, wa.y + wa.height - len - EDGE_MARGIN),
    width: STRIP,
    height: len,
  };
}

/**
 * Window bounds for the current dock edge. The window is the strip when
 * collapsed and strip + gap + panel when expanded; it always stays inside the
 * display's work area.
 */
function computeWindowBounds(expanded: boolean, aux = false): Electron.Rectangle {
  const p = loadPrefs();
  const strip = computeStripRect();
  if (!expanded) return strip;

  const display = screen.getDisplayNearestPoint({
    x: strip.x + strip.width / 2,
    y: strip.y + strip.height / 2,
  });
  const wa = display.workArea;
  // The notes panel extends alongside the open panel, further from the edge.
  const auxSpan = aux ? PANEL_GAP + AUX_W : 0;

  if (p.dockEdge === "top") {
    const width = Math.min(
      Math.max(STRIP_LEN_H, PANEL_W + auxSpan),
      wa.width - EDGE_MARGIN * 2,
    );
    const height = Math.min(STRIP + PANEL_GAP + PANEL_H, wa.height - EDGE_MARGIN * 2);
    return {
      x: clamp(strip.x + (strip.width - width) / 2, wa.x + EDGE_MARGIN, wa.x + wa.width - width - EDGE_MARGIN),
      y: strip.y,
      width,
      height,
    };
  }

  const width = Math.min(STRIP + PANEL_GAP + PANEL_W + auxSpan, wa.width - EDGE_MARGIN * 2);
  const height = strip.height; // STRIP_LEN_V === PANEL_H → no vertical shift
  const x = p.dockEdge === "left" ? strip.x : strip.x + strip.width - width;

  return {
    x: clamp(x, wa.x + EDGE_MARGIN, wa.x + wa.width - width - EDGE_MARGIN),
    y: clamp(strip.y, wa.y + EDGE_MARGIN, wa.y + wa.height - height - EDGE_MARGIN),
    width,
    height,
  };
}

function sidebarConfig() {
  const p = loadPrefs();
  return {
    dockEdge: p.dockEdge,
    expanded: sidebarExpanded,
    aux: sidebarAux,
    strip: STRIP,
    panelWidth: PANEL_W,
    panelHeight: PANEL_H,
    auxWidth: AUX_W,
    gap: PANEL_GAP,
  };
}

function pushSidebarConfig() {
  sidebarWindow?.webContents.send("sidebar:config", sidebarConfig());
}

function applySidebarBounds(expanded: boolean, aux = false) {
  if (!sidebarWindow || sidebarWindow.isDestroyed()) return;
  sidebarExpanded = expanded;
  sidebarAux = expanded && aux;
  suppressSnap = true;
  sidebarWindow.setBounds(computeWindowBounds(expanded, sidebarAux));
  // The bounds change fires `moved`; don't treat it as a user drag.
  setTimeout(() => {
    suppressSnap = false;
  }, 120);
  pushSidebarConfig();
}

// ── Drag → snap to nearest edge ───────────────────────────────────────────

let suppressSnap = false;
let snapTimer: NodeJS.Timeout | null = null;
let dragCollapsed = false;

/** Called (debounced) after the user drops the strip. */
function snapToNearestEdge() {
  if (!sidebarWindow || sidebarWindow.isDestroyed()) return;

  const b = sidebarWindow.getBounds();
  const center = { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) };
  const display = screen.getDisplayNearestPoint(center);
  const wa = display.workArea;

  // Bottom docking is intentionally not offered.
  const distances: { edge: DockEdge; d: number }[] = [
    { edge: "left", d: center.x - wa.x },
    { edge: "right", d: wa.x + wa.width - center.x },
    { edge: "top", d: center.y - wa.y },
  ];
  distances.sort((a, z) => a.d - z.d);
  const edge = distances[0].edge;

  prefs.dockEdge = edge;
  if (edge === "top") {
    prefs.stripX = b.x;
    prefs.stripY = wa.y + EDGE_MARGIN;
  } else {
    prefs.stripX = edge === "left" ? wa.x + EDGE_MARGIN : wa.x + wa.width - STRIP - EDGE_MARGIN;
    prefs.stripY = b.y;
  }
  savePrefs();

  applySidebarBounds(false);
}

function scheduleSnap() {
  if (suppressSnap) return;
  if (snapTimer) clearTimeout(snapTimer);
  snapTimer = setTimeout(() => {
    snapTimer = null;
    dragCollapsed = false;
    snapToNearestEdge();
  }, 160);
}

// ── Sidebar window ────────────────────────────────────────────────────────

function createSidebarWindow() {
  if (sidebarWindow && !sidebarWindow.isDestroyed()) return sidebarWindow;

  loadPrefs();
  sidebarExpanded = false;

  sidebarWindow = new BrowserWindow({
    ...computeWindowBounds(false),
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    // Draw the shadow in CSS so the rounded corners stay clean on Windows.
    hasShadow: false,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    // Click-through is deliberately NOT enabled — the strip must accept clicks.
    show: false,
    title: "Greencaller Sidebar",
    icon: appIcon.isEmpty() ? undefined : appIcon,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });

  sidebarWindow.setAlwaysOnTop(true, "floating");
  sidebarWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  sidebarWindow.setMenuBarVisibility(false);
  sidebarWindow.webContents.setBackgroundThrottling(false);

  if (isDev) {
    sidebarWindow.loadURL("http://localhost:8081/#/sidebar");
  } else {
    sidebarWindow.loadFile(path.join(__dirname, "..", "dist", "index.html"), { hash: "/sidebar" });
  }

  sidebarWindow.webContents.on("did-finish-load", () => {
    pushSidebarConfig();
    // Ask the main renderer to re-send the current call snapshot.
    mainWindow?.webContents.send("sidebar:request-state");
  });

  // Drag handling: collapse any open panel the moment a drag starts, then snap
  // to the nearest edge once the window stops moving.
  sidebarWindow.on("will-move", () => {
    if (suppressSnap) return;
    if (!dragCollapsed) {
      dragCollapsed = true;
      if (sidebarExpanded) {
        sidebarExpanded = false;
        sidebarWindow?.webContents.send("sidebar:force-collapse");
      }
    }
  });

  sidebarWindow.on("moved", () => scheduleSnap());

  // Clicking outside the window collapses the open panel (call panels excluded
  // — the renderer decides).
  sidebarWindow.on("blur", () => {
    sidebarWindow?.webContents.send("sidebar:blur");
  });

  sidebarWindow.on("closed", () => {
    sidebarWindow = null;
    sidebarExpanded = false;
  });

  return sidebarWindow;
}

function enterSidebarMode() {
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) {
    // Remember where the full app was so "expand" restores it exactly.
    mainWindowBounds = mainWindow.getBounds();
  }

  const win = createSidebarWindow();
  // Drop any stale panel from a previous docked session; a live call re-opens
  // its own panel as soon as the state snapshot lands.
  win.webContents.send("sidebar:force-collapse");
  applySidebarBounds(false);
  win.showInactive();
  win.setAlwaysOnTop(true, "floating");

  // Hide (never destroy) the main window — the SIP/WebRTC session lives there.
  mainWindow?.hide();

  prefs.sidebarMode = true;
  savePrefs();
  refreshTrayMenu();
  mainWindow?.webContents.send("sidebar:mode", true);
  // Ask for a fresh snapshot so an in-progress call shows its Active Call
  // panel immediately (the window may already have been loaded).
  mainWindow?.webContents.send("sidebar:request-state");
  pushSidebarConfig();
}

function exitSidebarMode() {
  prefs.sidebarMode = false;
  savePrefs();

  if (sidebarWindow && !sidebarWindow.isDestroyed()) {
    sidebarWindow.hide();
  }

  if (!mainWindow || mainWindow.isDestroyed()) {
    createMainWindow();
  } else if (mainWindowBounds) {
    mainWindow.setBounds(mainWindowBounds);
  }

  bringWindowToFront();
  refreshTrayMenu();
  mainWindow?.webContents.send("sidebar:mode", false);
}

function setDockEdge(edge: DockEdge) {
  prefs.dockEdge = edge;
  // Re-centre along the free axis so the strip lands somewhere sensible.
  prefs.stripX = null;
  prefs.stripY = null;
  savePrefs();
  applySidebarBounds(false);
  refreshTrayMenu();
}

const isSidebarMode = () =>
  loadPrefs().sidebarMode && !!sidebarWindow && !sidebarWindow.isDestroyed();

/** Pull attention to the strip without stealing keyboard focus. */
function alertSidebar() {
  if (!sidebarWindow || sidebarWindow.isDestroyed()) return;
  if (!sidebarWindow.isVisible()) sidebarWindow.showInactive();
  sidebarWindow.setAlwaysOnTop(true, "screen-saver");
  sidebarWindow.moveTop();
  // Drop back to the normal floating level once it's on top.
  setTimeout(() => {
    if (sidebarWindow && !sidebarWindow.isDestroyed()) {
      sidebarWindow.setAlwaysOnTop(true, "floating");
    }
  }, 400);
}

// ── Sidebar IPC ───────────────────────────────────────────────────────────

ipcMain.handle("sidebar:get-mode", () => loadPrefs().sidebarMode);

/**
 * The renderer's call shell (Dashboard / EnterprisePlatform) has mounted, so
 * there is now a session to mirror and someone to receive strip actions. This
 * is where a persisted sidebarMode is finally honoured.
 */
ipcMain.on("sidebar:shell-ready", () => {
  if (!pendingSidebarRestore) return;
  pendingSidebarRestore = false;
  enterSidebarMode();
});

ipcMain.on("sidebar:enter", () => enterSidebarMode());
ipcMain.on("sidebar:exit", () => exitSidebarMode());
ipcMain.on("sidebar:toggle", () => {
  if (isSidebarMode()) exitSidebarMode();
  else enterSidebarMode();
});

/** Renderer asks the window to grow/shrink around the panel. */
ipcMain.on("sidebar:set-expanded", (_e, expanded: boolean, aux?: boolean) => {
  applySidebarBounds(!!expanded, !!aux);
});

ipcMain.on("sidebar:dock", (_e, edge: DockEdge) => {
  if (edge === "left" || edge === "top" || edge === "right") setDockEdge(edge);
});

/** Main renderer → sidebar renderer: live call + badge snapshot. */
ipcMain.on("sidebar:state", (_e, state: unknown) => {
  sidebarWindow?.webContents.send("sidebar:state", state);
});

/**
 * Main renderer → sidebar renderer: a toast. The full window is hidden while
 * docked, so without this every toast-driven message (recording errors, call
 * failures, dialpad validation) would fire into a window nobody can see.
 */
ipcMain.on("sidebar:toast", (_e, payload: unknown) => {
  sidebarWindow?.webContents.send("sidebar:toast", payload);
});

/** Sidebar renderer → main renderer: a call/UI action to perform. */
ipcMain.on("sidebar:action", (_e, action: { type: string; payload?: unknown }) => {
  mainWindow?.webContents.send("sidebar:action", action);
});

/** Incoming call while docked — surface the strip without taking focus. */
ipcMain.on("sidebar:alert", () => alertSidebar());

// ── App lifecycle ─────────────────────────────────────────────────────────

app.whenReady().then(() => {
  loadPrefs();
  createTray();
  createMainWindow();

  // Restore whichever mode the user was last in — but only once the call shell
  // has actually mounted (the app launches on the sign-in screen, and docking
  // before then would hide the login form with no session to mirror).
  pendingSidebarRestore = prefs.sidebarMode;

  // Allow opening DevTools in production with Ctrl+Shift+F12
  globalShortcut.register("Ctrl+Shift+F12", () => {
    if (isSidebarMode()) sidebarWindow?.webContents.openDevTools({ mode: "detach" });
    else mainWindow?.webContents.openDevTools();
  });
});

// On macOS "before-quit" also sets the flag so the close handler lets go
app.on("before-quit", () => {
  isQuitting = true;
  globalShortcut.unregisterAll();
  if (powerSaveId !== null) {
    powerSaveBlocker.stop(powerSaveId);
    powerSaveId = null;
  }
});

app.on("window-all-closed", () => {
  // On Windows the tray keeps the app alive; only quit when isQuitting is true
  if (isQuitting) app.quit();
});

app.on("activate", () => {
  if (mainWindow) {
    bringWindowToFront();
  } else {
    createMainWindow();
  }
});
