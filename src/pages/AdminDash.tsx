import { useEffect, useState } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import AdminDashSidebar from "@/components/admin/AdminDashSidebar";
import AdminDashHeader from "@/components/admin/AdminDashHeader";
import LiveCDR from "@/components/LiveCDR";
import UserManagement from "@/components/UserManagement";
import UserCallUsage from "@/components/UserCallUsage";
import CompanyManagement from "@/components/CompanyManagement";
import DepartmentManagement from "@/components/DepartmentManagement";
import { IVRConfiguration } from "@/components/IVRConfiguration";
import PhoneNumbersManagement from "@/components/admin/PhoneNumbersManagement";
import SubscriptionManagement from "@/components/SubscriptionManagement";

type AdminView = "cdr" | "users" | "usage" | "companies" | "departments" | "phones" | "ivr" | "subscriptions";

const AdminDash = () => {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [adminName, setAdminName] = useState("");
  const [activeView, setActiveView] = useState<AdminView>("cdr");
  const navigate = useNavigate();
  const location = useLocation();
  const { toast } = useToast();

  useEffect(() => {
    validateSession();
  }, []);

  useEffect(() => {
    // Parse view from URL hash
    const hash = location.hash.replace("#", "");
    if (hash && ["cdr", "users", "usage", "companies", "departments", "phones", "ivr", "subscriptions"].includes(hash)) {
      setActiveView(hash as AdminView);
    }
  }, [location.hash]);

  const validateSession = async () => {
    const token = localStorage.getItem("admin_session_token");
    
    if (!token) {
      navigate("/adminauth");
      return;
    }

    try {
      const { data, error } = await supabase.functions.invoke("admin-auth", {
        body: { action: "validate", token },
      });

      if (error || !data?.valid) {
        localStorage.removeItem("admin_session_token");
        navigate("/adminauth");
        return;
      }

      setAdminName(data.admin?.full_name || "Admin");
      setIsAuthenticated(true);
    } catch (err) {
      console.error("Session validation error:", err);
      localStorage.removeItem("admin_session_token");
      navigate("/adminauth");
    } finally {
      setLoading(false);
    }
  };

  const handleLogout = async () => {
    const token = localStorage.getItem("admin_session_token");
    
    if (token) {
      try {
        await supabase.functions.invoke("admin-auth", {
          body: { action: "logout", token },
        });
      } catch (err) {
        console.error("Logout error:", err);
      }
    }
    
    localStorage.removeItem("admin_session_token");
    toast({
      title: "Logged out",
      description: "You have been logged out successfully",
    });
    navigate("/adminauth");
  };

  const handleViewChange = (view: AdminView) => {
    setActiveView(view);
    window.location.hash = view;
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary mx-auto mb-4"></div>
          <p className="text-muted-foreground">Verifying session...</p>
        </div>
      </div>
    );
  }

  if (!isAuthenticated) return null;

  const renderContent = () => {
    switch (activeView) {
      case "cdr":
        return <LiveCDR />;
      case "users":
        return <UserManagement />;
      case "usage":
        return <UserCallUsage />;
      case "companies":
        return <CompanyManagement />;
      case "departments":
        return <DepartmentManagement />;
      case "phones":
        return <PhoneNumbersManagement />;
      case "ivr":
        return <IVRConfiguration />;
      case "subscriptions":
        return <SubscriptionManagement />;
      default:
        return <LiveCDR />;
    }
  };

  return (
    <div className="min-h-screen bg-background flex">
      <AdminDashSidebar 
        activeView={activeView} 
        onViewChange={handleViewChange} 
      />
      <div className="flex-1 flex flex-col min-w-0">
        <AdminDashHeader 
          adminName={adminName} 
          onLogout={handleLogout} 
        />
        <main className="flex-1 p-6 overflow-auto">
          {renderContent()}
        </main>
      </div>
    </div>
  );
};

export default AdminDash;