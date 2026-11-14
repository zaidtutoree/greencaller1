import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Building2, ChevronDown, ChevronRight, Shield, Users } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";

interface Profile {
  id: string;
  full_name: string;
  email: string;
  account_type: 'basic' | 'premium' | 'enterprise';
  company_name: string | null;
  is_company_admin: boolean;
  created_at: string;
}

interface CompanyGroup {
  name: string;
  users: Profile[];
}

const CompanyManagement = () => {
  const [companies, setCompanies] = useState<CompanyGroup[]>([]);
  const [openCompanies, setOpenCompanies] = useState<Set<string>>(new Set());
  const [togglingAdmin, setTogglingAdmin] = useState<string | null>(null);
  const { toast } = useToast();

  useEffect(() => {
    fetchCompanies();
  }, []);

  const fetchCompanies = async () => {
    const { data, error } = await supabase
      .from("profiles")
      .select("*")
      .not("company_name", "is", null)
      .order("company_name", { ascending: true });

    if (error) {
      console.error("Error fetching profiles:", error);
      return;
    }

    // Group users by company
    const companyMap = new Map<string, Profile[]>();

    (data || []).forEach((profile) => {
      if (profile.company_name) {
        const existing = companyMap.get(profile.company_name) || [];
        companyMap.set(profile.company_name, [...existing, profile as Profile]);
      }
    });

    const groupedCompanies: CompanyGroup[] = Array.from(companyMap.entries()).map(
      ([name, users]) => ({ name, users })
    );

    setCompanies(groupedCompanies);
  };

  const toggleCompany = (companyName: string) => {
    setOpenCompanies((prev) => {
      const next = new Set(prev);
      if (next.has(companyName)) {
        next.delete(companyName);
      } else {
        next.add(companyName);
      }
      return next;
    });
  };

  const toggleCompanyAdmin = async (user: Profile, companyUsers: Profile[]) => {
    const token = localStorage.getItem("admin_session_token");
    if (!token) {
      toast({
        title: "Error",
        description: "Admin session not found",
        variant: "destructive",
      });
      return;
    }

    setTogglingAdmin(user.id);
    const newValue = !user.is_company_admin;

    try {
      // If toggling ON, first remove admin from any other user in the same company
      if (newValue) {
        const currentAdmin = companyUsers.find(u => u.is_company_admin && u.id !== user.id);
        if (currentAdmin) {
          const { error: removeError } = await supabase.functions.invoke("admin-user", {
            body: {
              action: "update",
              userId: currentAdmin.id,
              updates: { is_company_admin: false },
            },
            headers: { "x-admin-token": token },
          });
          if (removeError) {
            throw new Error("Failed to remove previous admin");
          }
        }
      }

      const { data, error } = await supabase.functions.invoke("admin-user", {
        body: {
          action: "update",
          userId: user.id,
          updates: { is_company_admin: newValue },
        },
        headers: { "x-admin-token": token },
      });

      if (error || !data?.success) {
        throw new Error(data?.error || error?.message || "Failed to update admin status");
      }

      toast({
        title: "Success",
        description: newValue
          ? `${user.full_name} is now the company admin`
          : `${user.full_name} is no longer a company admin`,
      });
      fetchCompanies();
    } catch (err: any) {
      toast({
        title: "Error",
        description: err.message || "Failed to update admin status",
        variant: "destructive",
      });
    } finally {
      setTogglingAdmin(null);
    }
  };

  const getAccountTypeBadge = (type: string) => {
    switch (type) {
      case 'enterprise':
        return <Badge variant="secondary" className="bg-purple-500/10 text-purple-500">Enterprise</Badge>;
      case 'premium':
        return <Badge variant="secondary" className="bg-success/10 text-success">Premium</Badge>;
      default:
        return <Badge variant="secondary" className="bg-muted text-muted-foreground">Basic</Badge>;
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Building2 className="w-5 h-5" />
          Companies
        </CardTitle>
      </CardHeader>
      <CardContent>
        {companies.length === 0 ? (
          <div className="text-center py-8 text-muted-foreground">
            No companies found. Assign company names to users in the Users section.
          </div>
        ) : (
          <div className="space-y-2">
            {companies.map((company) => (
              <Collapsible
                key={company.name}
                open={openCompanies.has(company.name)}
                onOpenChange={() => toggleCompany(company.name)}
              >
                <CollapsibleTrigger className="w-full">
                  <div className="flex items-center justify-between p-4 rounded-lg border bg-card hover:bg-accent/50 transition-colors">
                    <div className="flex items-center gap-3">
                      {openCompanies.has(company.name) ? (
                        <ChevronDown className="w-4 h-4 text-muted-foreground" />
                      ) : (
                        <ChevronRight className="w-4 h-4 text-muted-foreground" />
                      )}
                      <Building2 className="w-5 h-5 text-primary" />
                      <span className="font-medium">{company.name}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <Users className="w-4 h-4 text-muted-foreground" />
                      <span className="text-sm text-muted-foreground">
                        {company.users.length} {company.users.length === 1 ? 'user' : 'users'}
                      </span>
                    </div>
                  </div>
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <div className="mt-2 ml-6 border rounded-lg overflow-hidden">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Name</TableHead>
                          <TableHead>Email</TableHead>
                          <TableHead>Account Type</TableHead>
                          <TableHead>Company Admin</TableHead>
                          <TableHead>Joined</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {company.users.map((user) => (
                          <TableRow key={user.id}>
                            <TableCell className="font-medium">
                              <div className="flex items-center gap-2">
                                {user.is_company_admin && (
                                  <Shield className="w-4 h-4 text-primary" />
                                )}
                                {user.full_name}
                              </div>
                            </TableCell>
                            <TableCell>{user.email}</TableCell>
                            <TableCell>{getAccountTypeBadge(user.account_type)}</TableCell>
                            <TableCell>
                              <Switch
                                checked={user.is_company_admin}
                                disabled={togglingAdmin !== null}
                                onCheckedChange={() => toggleCompanyAdmin(user, company.users)}
                              />
                            </TableCell>
                            <TableCell>
                              {new Date(user.created_at).toLocaleDateString()}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                </CollapsibleContent>
              </Collapsible>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
};

export default CompanyManagement;
