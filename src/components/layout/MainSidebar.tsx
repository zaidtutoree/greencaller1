import { useState } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { cn } from "@/lib/utils";
import {
  Home,
  MessageSquare,
  History,
  Users,
  Network,
  Settings,
  Grid3x3,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import brandLogo from "@/assets/brand-logo.png";

interface NavItem {
  icon: React.ElementType;
  label: string;
  value: string;
  badge?: number;
  adminOnly?: boolean;
}

interface MainSidebarProps {
  activeTab: string;
  onTabChange: (tab: string) => void;
  isAdmin: boolean;
  queueCount: number;
  unreadMessageCount?: number;
  onDialpadOpen: () => void;
}

export const MainSidebar = ({
  activeTab,
  onTabChange,
  isAdmin,
  queueCount,
  unreadMessageCount = 0,
  onDialpadOpen,
}: MainSidebarProps) => {

  const navItems: NavItem[] = [
    { icon: Home, label: "Home", value: "home" },
    { icon: MessageSquare, label: "Messages", value: "messages", badge: unreadMessageCount },
    { icon: History, label: "Activity", value: "activity" },
    { icon: Users, label: "Contacts", value: "contacts" },
    { icon: Network, label: "Switchboard", value: "departments", badge: queueCount },
    { icon: Settings, label: "Admin", value: "admin", adminOnly: true },
  ];

  const filteredNavItems = navItems.filter(item => !item.adminOnly || isAdmin);

  return (
    <TooltipProvider delayDuration={0}>
      <aside
        className="flex flex-col bg-sidebar border-r border-sidebar-border min-h-0 h-full w-[72px]"
      >
        {/* Logo Section */}
        <div className="flex items-center justify-center h-16 border-b border-sidebar-border px-4">
          <img src={brandLogo} alt="Logo" className="w-8 h-8" />
        </div>

        {/* Navigation */}
        <nav className="flex-1 py-4 px-3 space-y-1">
          {filteredNavItems.map((item) => {
            const Icon = item.icon;
            const isActive = activeTab === item.value;
            const hasBadge = (item.badge ?? 0) > 0;

            const navContent = (
              <button
                onClick={() => onTabChange(item.value)}
                className={cn(
                  "w-full flex flex-col items-center justify-center gap-1 px-3 py-2.5 rounded-lg transition-all duration-200 group relative",
                  isActive
                    ? "bg-sidebar-accent text-sidebar-accent-foreground font-medium shadow-sm"
                    : "text-sidebar-muted hover:text-sidebar-foreground hover:bg-sidebar-accent/50"
                )}
              >
                {isActive && (
                  <div className="absolute left-0 top-1/2 -translate-y-1/2 w-1 h-6 bg-sidebar-primary rounded-r-full" />
                )}
                <div className="relative">
                  <Icon className={cn(
                    "w-5 h-5 flex-shrink-0 transition-colors",
                    hasBadge && !isActive ? "text-yellow-400" : isActive ? "text-sidebar-primary" : "group-hover:text-sidebar-foreground"
                  )} />
                  {hasBadge && (
                    <span className="absolute -top-1.5 -right-1.5 w-4 h-4 bg-yellow-400 text-black text-[9px] font-bold rounded-full flex items-center justify-center">
                      {item.badge! > 9 ? "9+" : item.badge}
                    </span>
                  )}
                </div>
              </button>
            );

            return (
              <Tooltip key={item.value}>
                <TooltipTrigger asChild>{navContent}</TooltipTrigger>
                <TooltipContent side="right" className="font-medium">
                  {item.label}
                  {hasBadge && ` (${item.badge})`}
                </TooltipContent>
              </Tooltip>
            );
          })}
        </nav>

        {/* Bottom Actions */}
        <div className="p-3 border-t border-sidebar-border">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="outline"
                size="icon"
                onClick={onDialpadOpen}
                className="w-full"
              >
                <Grid3x3 className="w-5 h-5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="right">Dialpad</TooltipContent>
          </Tooltip>
        </div>
      </aside>
    </TooltipProvider>
  );
};
