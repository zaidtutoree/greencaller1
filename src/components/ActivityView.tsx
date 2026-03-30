import { useState } from "react";
import { History, PhoneMissed, Voicemail, Mic } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import CallHistory from "./CallHistory";
import { VoicemailList } from "./VoicemailList";
import CallRecordings from "./CallRecordings";
import { cn } from "@/lib/utils";

interface ActivityViewProps {
  userId?: string;
}

type ViewType = "all" | "missed" | "voicemail" | "recordings";

const navigationItems = [
  { id: "all" as ViewType, label: "All", icon: History },
  { id: "missed" as ViewType, label: "Missed", icon: PhoneMissed },
  { id: "voicemail" as ViewType, label: "Voicemail", icon: Voicemail },
  { id: "recordings" as ViewType, label: "Recordings", icon: Mic },
];

export const ActivityView = ({ userId }: ActivityViewProps) => {
  const [activeView, setActiveView] = useState<ViewType>("all");

  return (
    <div className="flex h-full gap-6 p-6">
      {/* Left Sidebar */}
      <div className="w-64 border-r pr-6">
        <h2 className="text-lg font-semibold mb-4">Activity</h2>
        <ScrollArea className="h-[calc(100vh-12rem)]">
          <nav className="space-y-1">
            {navigationItems.map((item) => {
              const Icon = item.icon;
              return (
                <Button
                  key={item.id}
                  variant="ghost"
                  className={cn(
                    "w-full justify-start gap-3",
                    activeView === item.id && "bg-muted"
                  )}
                  onClick={() => setActiveView(item.id)}
                >
                  <Icon className="w-4 h-4" />
                  {item.label}
                </Button>
              );
            })}
          </nav>
        </ScrollArea>
      </div>

      {/* Main Content Area */}
      <div className="flex-1 overflow-auto">
        {activeView === "all" && <CallHistory userId={userId} />}
        {activeView === "missed" && <CallHistory userId={userId} filterMissed />}
        {activeView === "voicemail" && <VoicemailList userId={userId} />}
        {activeView === "recordings" && <CallRecordings userId={userId} />}
      </div>
    </div>
  );
};
