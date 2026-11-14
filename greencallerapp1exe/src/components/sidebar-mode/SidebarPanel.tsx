import { ExternalLink, X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { SidebarDockEdge } from "./types";

interface SidebarPanelProps {
  title: string;
  dockEdge: SidebarDockEdge;
  /** Plays the exit animation instead of the enter one. */
  closing?: boolean;
  /** Hidden for call panels, which must not be dismissed by a stray click. */
  onClose?: () => void;
  /** Restores the full window on this tab. */
  onOpenFullApp?: () => void;
  /** Optional extra control rendered left of "Open in full app". */
  action?: React.ReactNode;
  children: React.ReactNode;
}

/**
 * The compact panel that slides out of the strip toward the screen centre.
 * It lives in the SAME window as the strip (the window's bounds grow), which
 * keeps z-order and focus behaviour identical to the strip itself.
 */
export const SidebarPanel = ({
  title,
  dockEdge,
  closing,
  onClose,
  onOpenFullApp,
  action,
  children,
}: SidebarPanelProps) => {
  // Slide in from the docked edge: right-docked panels come from the right,
  // left-docked from the left, top-docked drop down.
  const slide =
    dockEdge === "right"
      ? { "--gc-sb-slide-x": "18px" }
      : dockEdge === "left"
        ? { "--gc-sb-slide-x": "-18px" }
        : { "--gc-sb-slide-y": "-18px" };

  return (
    <div
      className={cn(
        "gc-sb-glass gc-sb-panel flex flex-col h-full w-full min-h-0",
        closing ? "gc-sb-panel-exit" : "gc-sb-panel-enter",
      )}
      style={slide as React.CSSProperties}
    >
      {/*
        Header — title, optional action, close. No back/forward affordances.

        Deliberately NOT an app-region drag handle: inside the panel's animated
        (transformed) subtree, Chromium mis-maps the no-drag rects of the child
        buttons and the drag region swallows their clicks. The strip's grab
        handle is the drag affordance; the panel just rides along with it.
      */}
      <header className="flex items-center gap-2 px-3 py-2.5 shrink-0 border-b border-white/10">
        <h2 className="flex-1 min-w-0 truncate text-[13px] font-semibold text-white font-display">
          {title}
        </h2>

        {action}

        {onOpenFullApp && (
          <button
            type="button"
            onClick={onOpenFullApp}
            title="Open in full app"
            aria-label="Open in full app"
            className="gc-sb-nodrag flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] font-medium text-white/70 hover:text-white hover:bg-white/12 transition-colors"
          >
            <ExternalLink className="w-3.5 h-3.5" />
            Open in full app
          </button>
        )}

        {onClose && (
          <button
            type="button"
            onClick={onClose}
            title="Close"
            aria-label="Close panel"
            className="gc-sb-nodrag flex items-center justify-center h-6 w-6 rounded-md text-white/70 hover:text-white hover:bg-white/12 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        )}
      </header>

      <div className="gc-sb-panel-body flex-1 min-h-0 overflow-hidden select-text">
        {children}
      </div>
    </div>
  );
};
