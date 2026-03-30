import { NavLink } from "@/components/NavLink";
import { useLocation, useNavigate } from "react-router-dom";
import { useEffect, useState } from "react";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarHeader,
  SidebarFooter,
  useSidebar,
} from "@/components/ui/sidebar";
import { Phone, MessageSquare, History, Settings, LogOut, User, Voicemail, Home, Mic, Building2 } from "lucide-react";
import brandLogo from "@/assets/brand-logo.png";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";

interface AppSidebarProps {
  userEmail?: string;
}

const navigationItems = [
  {
    title: "Home",
    url: "/dashboard",
    icon: Home,
  },
  {
    title: "Dial Pad",
    url: "/dashboard/dialpad",
    icon: Phone,
  },
  {
    title: "Messages",
    url: "/dashboard/messages",
    icon: MessageSquare,
    requiresAccount: 'enterprise' as const,
  },
  {
    title: "Voicemails",
    url: "/dashboard/voicemails",
    icon: Voicemail,
  },
  {
    title: "Call History",
    url: "/dashboard/history",
    icon: History,
  },
  {
    title: "Recordings",
    url: "/dashboard/recordings",
    icon: Mic,
    requiresAccount: 'premium' as const,
  },
];

export function AppSidebar({ userEmail }: AppSidebarProps) {
  const { state } = useSidebar();
  const location = useLocation();
  const navigate = useNavigate();
  const { toast } = useToast();
  const [accountType, setAccountType] = useState<'basic' | 'premium' | 'enterprise'>('basic');
  const [isAdmin, setIsAdmin] = useState(false);

  useEffect(() => {
    const fetchAccountTypeAndRole = async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (user) {
        // Fetch account type
        const { data: profileData } = await supabase
          .from('profiles')
          .select('account_type')
          .eq('id', user.id)
          .single();
        
        if (profileData) {
          setAccountType(profileData.account_type);
        }

        // Check if user is the admin email
        setIsAdmin(user.email === 'admin@gmail.com');
      }
    };

    fetchAccountTypeAndRole();
  }, []);

  const handleLogout = async () => {
    await supabase.auth.signOut();
    toast({ title: "Logged out successfully" });
    navigate("/auth");
  };

  const isActive = (path: string) => location.pathname === path;
  const isCollapsed = state === "collapsed";

  // Filter navigation items based on account type
  const filteredNavItems = navigationItems.filter(item => {
    if (item.requiresAccount === 'premium' && accountType === 'basic') {
      return false;
    }
    if (item.requiresAccount === 'enterprise' && accountType !== 'enterprise') {
      return false;
    }
    return true;
  });

  return (
    <Sidebar collapsible="icon" className={isCollapsed ? "w-16" : "w-64"}>
      <SidebarHeader className="border-b border-sidebar-border">
        <div className="flex items-center justify-center px-3 py-4">
          <img src={brandLogo} alt="Logo" className={isCollapsed ? "w-4 h-4" : "w-8 h-8"} />
        </div>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Navigation</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {filteredNavItems.map((item) => (
                <SidebarMenuItem key={item.title}>
                  <SidebarMenuButton asChild isActive={isActive(item.url)}>
                    <NavLink
                      to={item.url}
                      end={item.url === "/dashboard"}
                      className="flex items-center gap-3"
                      activeClassName="bg-sidebar-accent text-sidebar-accent-foreground font-medium"
                    >
                      <item.icon className="w-5 h-5 flex-shrink-0" />
                      {!isCollapsed && <span>{item.title}</span>}
                    </NavLink>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter className="border-t border-sidebar-border">
        <SidebarMenu>
          {isAdmin && (
            <SidebarMenuItem>
              <SidebarMenuButton asChild>
                <button
                  onClick={() => navigate("/admin")}
                  className="flex items-center gap-3 w-full"
                >
                  <Settings className="w-5 h-5 flex-shrink-0" />
                  {!isCollapsed && <span>Admin</span>}
                </button>
              </SidebarMenuButton>
            </SidebarMenuItem>
          )}
          <SidebarMenuItem>
            <SidebarMenuButton asChild>
              <button onClick={handleLogout} className="flex items-center gap-3 w-full">
                <LogOut className="w-5 h-5 flex-shrink-0" />
                {!isCollapsed && <span>Logout</span>}
              </button>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
}
