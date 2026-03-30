import { useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Search, User, Building2, Phone, ArrowRight } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { cn } from "@/lib/utils";

interface TransferCallDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onTransfer: (targetId: string, targetType: "user" | "department") => void;
  userId?: string;
}

interface TeamMember {
  id: string;
  full_name: string;
  email: string;
  company_name: string | null;
}

interface Department {
  id: string;
  name: string;
  company_name: string;
  phone_number: string | null;
}

export const TransferCallDialog = ({
  open,
  onOpenChange,
  onTransfer,
  userId,
}: TransferCallDialogProps) => {
  const [searchQuery, setSearchQuery] = useState("");
  const [teamMembers, setTeamMembers] = useState<TeamMember[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [selectedTarget, setSelectedTarget] = useState<{
    id: string;
    type: "user" | "department";
  } | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    if (open && userId) {
      fetchTransferTargets();
    }
  }, [open, userId]);

  const fetchTransferTargets = async () => {
    setIsLoading(true);
    try {
      // Get current user's company
      const { data: profile } = await supabase
        .from("profiles")
        .select("company_name")
        .eq("id", userId)
        .single();

      if (!profile?.company_name) return;

      // Fetch team members from the same company
      const { data: members } = await supabase
        .from("profiles")
        .select("id, full_name, email, company_name")
        .eq("company_name", profile.company_name)
        .neq("id", userId);

      if (members) {
        setTeamMembers(members);
      }

      // Fetch departments
      const { data: depts } = await supabase
        .from("departments")
        .select(`
          id,
          name,
          company_name,
          phone_numbers:phone_number_id (phone_number)
        `)
        .eq("company_name", profile.company_name);

      if (depts) {
        setDepartments(
          depts.map((d: any) => ({
            id: d.id,
            name: d.name,
            company_name: d.company_name,
            phone_number: d.phone_numbers?.phone_number || null,
          }))
        );
      }
    } catch (error) {
      console.error("Error fetching transfer targets:", error);
    } finally {
      setIsLoading(false);
    }
  };

  const filteredMembers = teamMembers.filter(
    (m) =>
      m.full_name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      m.email.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const filteredDepartments = departments.filter((d) =>
    d.name.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const handleTransfer = () => {
    if (selectedTarget) {
      onTransfer(selectedTarget.id, selectedTarget.type);
      onOpenChange(false);
      setSelectedTarget(null);
      setSearchQuery("");
    }
  };

  const getInitials = (name: string) => {
    return name
      .split(" ")
      .map((n) => n[0])
      .join("")
      .toUpperCase()
      .slice(0, 2);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ArrowRight className="w-5 h-5 text-primary" />
            Transfer Call
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {/* Search */}
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              placeholder="Search users or departments..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-9"
            />
          </div>

          {/* Tabs */}
          <Tabs defaultValue="users" className="w-full">
            <TabsList className="w-full">
              <TabsTrigger value="users" className="flex-1">
                <User className="w-4 h-4 mr-2" />
                Team Members
              </TabsTrigger>
              <TabsTrigger value="departments" className="flex-1">
                <Building2 className="w-4 h-4 mr-2" />
                Departments
              </TabsTrigger>
            </TabsList>

            <TabsContent value="users" className="mt-4">
              <ScrollArea className="h-64">
                {isLoading ? (
                  <div className="space-y-2">
                    {[1, 2, 3].map((i) => (
                      <div key={i} className="h-16 bg-muted rounded-lg animate-pulse" />
                    ))}
                  </div>
                ) : filteredMembers.length === 0 ? (
                  <div className="text-center py-8 text-muted-foreground">
                    No team members found
                  </div>
                ) : (
                  <div className="space-y-2">
                    {filteredMembers.map((member) => (
                      <button
                        key={member.id}
                        onClick={() =>
                          setSelectedTarget({ id: member.id, type: "user" })
                        }
                        className={cn(
                          "w-full flex items-center gap-3 p-3 rounded-lg transition-colors text-left",
                          selectedTarget?.id === member.id && selectedTarget?.type === "user"
                            ? "bg-primary/10 border-2 border-primary"
                            : "bg-muted/50 hover:bg-muted border-2 border-transparent"
                        )}
                      >
                        <Avatar>
                          <AvatarFallback className="bg-primary/10 text-primary">
                            {getInitials(member.full_name)}
                          </AvatarFallback>
                        </Avatar>
                        <div className="flex-1 min-w-0">
                          <p className="font-medium truncate">{member.full_name}</p>
                          <p className="text-sm text-muted-foreground truncate">
                            {member.email}
                          </p>
                        </div>
                        <Badge variant="secondary" className="shrink-0">
                          <span className="w-1.5 h-1.5 rounded-full bg-success mr-1.5" />
                          Online
                        </Badge>
                      </button>
                    ))}
                  </div>
                )}
              </ScrollArea>
            </TabsContent>

            <TabsContent value="departments" className="mt-4">
              <ScrollArea className="h-64">
                {isLoading ? (
                  <div className="space-y-2">
                    {[1, 2, 3].map((i) => (
                      <div key={i} className="h-16 bg-muted rounded-lg animate-pulse" />
                    ))}
                  </div>
                ) : filteredDepartments.length === 0 ? (
                  <div className="text-center py-8 text-muted-foreground">
                    No departments found
                  </div>
                ) : (
                  <div className="space-y-2">
                    {filteredDepartments.map((dept) => (
                      <button
                        key={dept.id}
                        onClick={() =>
                          setSelectedTarget({ id: dept.id, type: "department" })
                        }
                        className={cn(
                          "w-full flex items-center gap-3 p-3 rounded-lg transition-colors text-left",
                          selectedTarget?.id === dept.id && selectedTarget?.type === "department"
                            ? "bg-primary/10 border-2 border-primary"
                            : "bg-muted/50 hover:bg-muted border-2 border-transparent"
                        )}
                      >
                        <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center">
                          <Building2 className="w-5 h-5 text-primary" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="font-medium truncate">{dept.name}</p>
                          {dept.phone_number && (
                            <p className="text-sm text-muted-foreground flex items-center gap-1">
                              <Phone className="w-3 h-3" />
                              {dept.phone_number}
                            </p>
                          )}
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </ScrollArea>
            </TabsContent>
          </Tabs>

          {/* Transfer Button */}
          <Button
            onClick={handleTransfer}
            disabled={!selectedTarget}
            className="w-full"
          >
            <ArrowRight className="w-4 h-4 mr-2" />
            Transfer Call
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
};
