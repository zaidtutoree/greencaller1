import { useState } from "react";
import { Mic, Music } from "lucide-react";
import { AudioSettings } from "@/components/AudioSettings";
import { RingtoneSettings } from "@/components/RingtoneSettings";
import { cn } from "@/lib/utils";

/**
 * Compact settings for the docked panel: the two things you actually change
 * mid-shift (input/output device and ringtone), reusing the exact same
 * components the full Settings modal renders. Everything else (profile,
 * opening hours, integrations) is a click away via "Open in full app".
 */
export const SidebarSettings = () => {
  const [tab, setTab] = useState<"audio" | "ringtone">("audio");

  const tabs = [
    { id: "audio" as const, label: "Audio", icon: Mic },
    { id: "ringtone" as const, label: "Ringtone", icon: Music },
  ];

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-1 border-b border-border p-2">
        {tabs.map((t) => {
          const Icon = t.icon;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={cn(
                "flex flex-1 items-center justify-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                tab === t.id
                  ? "bg-primary/10 text-primary"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground",
              )}
            >
              <Icon className="h-4 w-4" />
              {t.label}
            </button>
          );
        })}
      </div>

      <div className="flex-1 overflow-y-auto p-4">
        {tab === "audio" ? <AudioSettings /> : <RingtoneSettings />}
      </div>
    </div>
  );
};
