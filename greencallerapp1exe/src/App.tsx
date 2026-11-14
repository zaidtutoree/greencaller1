import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { HashRouter, Routes, Route, Navigate } from "react-router-dom";
import Auth from "./pages/Auth";
import Dashboard from "./pages/Dashboard";
import Admin from "./pages/Admin";
import AdminAuth from "./pages/AdminAuth";
import AdminDash from "./pages/AdminDash";
import ControlDashboard from "./pages/ControlDashboard";
import Crm from "./pages/Crm";
import SidebarApp from "./pages/SidebarApp";
import NotFound from "./pages/NotFound";

const queryClient = new QueryClient();

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <Toaster />
      <Sonner />
      <HashRouter>
        <Routes>
          <Route path="/" element={<Navigate to="/auth" replace />} />
          <Route path="/auth" element={<Auth />} />
          <Route path="/dashboard/*" element={<Dashboard />} />
          <Route path="/admin" element={<Admin />} />
          <Route path="/adminauth" element={<AdminAuth />} />
          <Route path="/admindash" element={<AdminDash />} />
          {/* Company-admin dashboard: one company's users, IVR and AI assistants. */}
          <Route path="/control" element={<ControlDashboard />} />
          {/* Cold-calling CRM: CSV upload + editable table, single-account access. */}
          <Route path="/crm" element={<Crm />} />
          {/* Sidebar Mode window (Electron). Renders the docked strip only —
              it never mounts a call provider, so there is no second SIP
              registration; the hidden main window still owns the session. */}
          <Route path="/sidebar" element={<SidebarApp />} />
          {/* ADD ALL CUSTOM ROUTES ABOVE THE CATCH-ALL "*" ROUTE */}
          <Route path="*" element={<NotFound />} />
        </Routes>
      </HashRouter>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;
