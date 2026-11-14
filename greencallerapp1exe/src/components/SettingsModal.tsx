import { useEffect, useState } from "react";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { User, Mic, Music, Clock, Slack, Headset } from "lucide-react";
import { ProfileSettings } from "@/components/ProfileSettings";
import { AudioSettings } from "@/components/AudioSettings";
import { RingtoneSettings } from "@/components/RingtoneSettings";
import { OpeningHours } from "@/components/OpeningHours";
import { SlackIntegration } from "@/components/SlackIntegration";
import { DeskPhoneSettings } from "@/components/DeskPhoneSettings";
import { supabase } from "@/integrations/supabase/client";
import { cn } from "@/lib/utils";

type SettingsTab = "profile" | "audio" | "ringtone" | "hours" | "integrations" | "deskphone";

interface SettingsModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  userId?: string;
  /** Called when the profile is saved/closed so the parent can refresh name/avatar. */
  onProfileSaved?: () => void;
  /** Enterprise users get the Integrations tab (Slack, etc.). */
  isEnterprise?: boolean;
}

const BASE_TABS: { id: SettingsTab; label: string; icon: typeof User }[] = [
  { id: "profile", label: "Profile", icon: User },
  { id: "audio", label: "Audio Settings", icon: Mic },
  { id: "ringtone", label: "Ringtone", icon: Music },
  { id: "hours", label: "Opening Hours", icon: Clock },
];

export const SettingsModal = ({ open, onOpenChange, userId, onProfileSaved, isEnterprise }: SettingsModalProps) => {
  const [activeTab, setActiveTab] = useState<SettingsTab>("profile");

  // The Desk phone tab only exists for users whose number has a physical
  // handset provisioned (desk_phones row). Cheap head-count query per open.
  const [hasDeskPhone, setHasDeskPhone] = useState(false);
  useEffect(() => {
    if (!open || !userId) return;
    let cancelled = false;
    supabase
      .from("desk_phones")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .eq("is_active", true)
      .then(({ count }) => {
        if (!cancelled) setHasDeskPhone((count ?? 0) > 0);
      });
    return () => {
      cancelled = true;
    };
  }, [open, userId]);

  const TABS = [
    ...BASE_TABS,
    ...(hasDeskPhone ? [{ id: "deskphone" as SettingsTab, label: "Desk Phone", icon: Headset }] : []),
    ...(isEnterprise ? [{ id: "integrations" as SettingsTab, label: "Integrations", icon: Slack }] : []),
  ];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl p-0 gap-0 overflow-hidden">
        <div className="flex h-[560px]">
          {/* Left tab rail */}
          <div className="w-52 shrink-0 border-r bg-muted/30 p-3">
            <h2 className="px-3 py-2 text-lg font-semibold font-display">Settings</h2>
            <nav className="mt-2 space-y-1">
              {TABS.map((tab) => {
                const Icon = tab.icon;
                return (
                  <button
                    key={tab.id}
                    onClick={() => setActiveTab(tab.id)}
                    className={cn(
                      "flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm transition-colors",
                      activeTab === tab.id
                        ? "bg-primary/10 text-primary font-medium"
                        : "text-foreground hover:bg-muted",
                    )}
                  >
                    <Icon className="h-4 w-4 shrink-0" />
                    {tab.label}
                  </button>
                );
              })}
            </nav>
          </div>

          {/* Right content */}
          <div className="flex-1 overflow-y-auto">
            {activeTab === "profile" && (
              <ProfileSettings
                userId={userId}
                onClose={() => {
                  onOpenChange(false);
                  onProfileSaved?.();
                }}
              />
            )}
            {activeTab === "audio" && (
              <div className="p-6">
                <h2 className="text-2xl font-display font-semibold mb-1">Audio Settings</h2>
                <p className="text-sm text-muted-foreground mb-6">
                  Choose your microphone and speaker for calls.
                </p>
                <AudioSettings />
              </div>
            )}
            {activeTab === "ringtone" && (
              <div className="p-6">
                <h2 className="text-2xl font-display font-semibold mb-4">Ringtone</h2>
                <RingtoneSettings />
              </div>
            )}
            {activeTab === "hours" && (
              <div className="p-6">
                <h2 className="text-2xl font-display font-semibold mb-1">Opening Hours</h2>
                <p className="text-sm text-muted-foreground mb-6">
                  Optionally send calls to voicemail outside your opening hours.
                </p>
                <OpeningHours userId={userId} />
              </div>
            )}
            {activeTab === "deskphone" && (
              <div className="p-6">
                <h2 className="text-2xl font-display font-semibold mb-1">Desk Phone</h2>
                <p className="text-sm text-muted-foreground mb-6">
                  Your physical handset rings together with the apps on your number. Choose whether its
                  calls are recorded.
                </p>
                <DeskPhoneSettings userId={userId} />
              </div>
            )}
            {activeTab === "integrations" && (
              <div className="p-6">
                <h2 className="text-2xl font-display font-semibold mb-1">Integrations</h2>
                <p className="text-sm text-muted-foreground mb-6">
                  Connect Greencaller to the tools your team already uses.
                </p>
                <SlackIntegration />
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};
