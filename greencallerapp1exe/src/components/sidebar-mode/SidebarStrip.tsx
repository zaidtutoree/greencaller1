import { GripHorizontal, GripVertical, Maximize2 } from "lucide-react";
import { cn } from "@/lib/utils";
import type { SidebarDockEdge } from "./types";

export interface StripItem {
  id: string;
  label: string;
  icon: React.ElementType;
  /** Small green dot when > 0 (missed calls, unheard voicemail, unread SMS). */
  badge?: number;
  /** Pulse the icon in bright green — used for an inbound call. */
  pulse?: boolean;
}

interface SidebarStripProps {
  items: StripItem[];
  activeId: string | null;
  dockEdge: SidebarDockEdge;
  /** Strip thickness in px (matches the main-process geometry). */
  thickness: number;
  onSelect: (id: string) => void;
  onExpandApp: () => void;
}

/**
 * The always-on-top icon rail. Vertical when docked left/right, horizontal when
 * docked top. The rail body is an OS drag region so the strip feels native;
 * every button opts back out with `.gc-sb-nodrag`.
 */
export const SidebarStrip = ({
  items,
  activeId,
  dockEdge,
  thickness,
  onSelect,
  onExpandApp,
}: SidebarStripProps) => {
  const isVertical = dockEdge !== "top";
  const Grip = isVertical ? GripHorizontal : GripVertical;

  return (
    <div
      className={cn(
        "gc-sb-glass gc-sb-strip gc-sb-drag flex items-center",
        isVertical ? "flex-col py-3 gap-2" : "flex-row px-3 gap-2",
      )}
      style={isVertical ? { width: thickness, height: "100%" } : { height: thickness, width: "100%" }}
    >
      {/* Grab handle — the explicit "drag me" affordance. */}
      <div
        className={cn(
          "flex items-center justify-center text-white/35 shrink-0",
          isVertical ? "h-5 w-full" : "w-5 h-full",
        )}
        title="Drag to move · drop near an edge to dock"
      >
        <Grip className="w-4 h-4" />
      </div>

      <div
        className={cn(
          "gc-sb-rail flex items-center gap-1.5 min-h-0 min-w-0",
          isVertical ? "flex-col flex-1 overflow-y-auto overflow-x-hidden" : "flex-row flex-1 overflow-x-auto overflow-y-hidden",
        )}
      >
        {items.map((item) => {
          const Icon = item.icon;
          const isActive = activeId === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => onSelect(item.id)}
              title={item.label}
              aria-label={item.label}
              aria-pressed={isActive}
              data-active={isActive}
              className={cn("gc-sb-icon gc-sb-nodrag shrink-0", item.pulse && "gc-sb-pulse")}
            >
              <Icon className="w-[18px] h-[18px]" />
              {(item.badge ?? 0) > 0 && <span className="gc-sb-dot" aria-hidden />}
            </button>
          );
        })}
      </div>

      {/* Divider + "back to the full app" */}
      <div
        className={cn("bg-white/10 shrink-0", isVertical ? "h-px w-7" : "w-px h-7")}
        aria-hidden
      />
      <button
        type="button"
        onClick={onExpandApp}
        title="Expand to full app"
        aria-label="Expand to full app"
        className="gc-sb-icon gc-sb-nodrag shrink-0"
      >
        <Maximize2 className="w-[18px] h-[18px]" />
      </button>
    </div>
  );
};
