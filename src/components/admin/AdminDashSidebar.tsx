import { cn } from "@/lib/utils";
import {
  FileText,
  Users,
  Clock,
  Building2,
  Layers,
  Phone,
  Settings2,
  CreditCard
} from "lucide-react";
import brandLogo from "@/assets/brand-logo.png";

type AdminView = "cdr" | "users" | "usage" | "companies" | "departments" | "phones" | "ivr" | "subscriptions";

interface AdminDashSidebarProps {
  activeView: AdminView;
  onViewChange: (view: AdminView) => void;
}

const navItems: { id: AdminView; label: string; icon: React.ElementType }[] = [
  { id: "cdr", label: "Live CDR", icon: FileText },
  { id: "users", label: "Users", icon: Users },
  { id: "usage", label: "Call Usage", icon: Clock },
  { id: "companies", label: "Companies", icon: Building2 },
  { id: "departments", label: "Departments", icon: Layers },
  { id: "phones", label: "Phone Numbers", icon: Phone },
  { id: "ivr", label: "IVR Config", icon: Settings2 },
  { id: "subscriptions", label: "Subscriptions", icon: CreditCard },
];

const AdminDashSidebar = ({ activeView, onViewChange }: AdminDashSidebarProps) => {
  return (
    <aside className="w-64 bg-white border-r border-border flex flex-col">
      {/* Logo */}
      <div className="h-16 px-6 flex items-center justify-center border-b border-border bg-white">
        <img src={brandLogo} alt="Logo" className="h-10" />
      </div>

      {/* Navigation */}
      <nav className="flex-1 py-4 px-3 space-y-1">
        {navItems.map((item) => {
          const Icon = item.icon;
          const isActive = activeView === item.id;
          
          return (
            <button
              key={item.id}
              onClick={() => onViewChange(item.id)}
              className={cn(
                "w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors",
                isActive
                  ? "bg-sidebar-accent text-sidebar-accent-foreground sidebar-item-active"
                  : "text-sidebar-muted hover:bg-sidebar-accent/50 hover:text-sidebar-foreground"
              )}
            >
              <Icon className="h-5 w-5 shrink-0" />
              <span>{item.label}</span>
            </button>
          );
        })}
      </nav>

      {/* Footer */}
      <div className="p-4 border-t border-sidebar-border">
        <p className="text-xs text-sidebar-muted text-center">
          Admin Dashboard v1.0
        </p>
      </div>
    </aside>
  );
};

export default AdminDashSidebar;