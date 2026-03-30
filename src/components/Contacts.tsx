import { useEffect, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Building2, Search, Phone, Users, MoreHorizontal, ArrowRight, X } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

interface Profile {
  id: string;
  full_name: string;
  email: string;
  company_name: string | null;
}

interface Department {
  id: string;
  name: string;
}

interface ContactsByDepartment {
  [departmentId: string]: {
    name: string;
    members: Profile[];
  };
}

interface ContactsProps {
  userId?: string;
  onCall?: (phoneNumber: string) => void;
}

export const Contacts = ({ userId, onCall }: ContactsProps) => {
  const [contacts, setContacts] = useState<Profile[]>([]);
  const [contactsByDept, setContactsByDept] = useState<ContactsByDepartment>({});
  const [departments, setDepartments] = useState<Department[]>([]);
  const [selectedContact, setSelectedContact] = useState<Profile | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [userCompany, setUserCompany] = useState<string | null>(null);
  const [accountType, setAccountType] = useState<string>("");
  const [isCompanyAdmin, setIsCompanyAdmin] = useState(false);
  const [contactPhones, setContactPhones] = useState<Record<string, string>>({});
  const [onlineUsers, setOnlineUsers] = useState<Set<string>>(new Set());
  const { toast } = useToast();

  useEffect(() => {
    if (userId) {
      fetchUserProfile();
    }
  }, [userId]);

  useEffect(() => {
    if (userCompany && accountType === "enterprise") {
      fetchCompanyContacts();
    }
  }, [userCompany, accountType]);

  // Presence tracking
  useEffect(() => {
    if (!userCompany || !userId) return;

    const channel = supabase.channel(`contacts-presence-${userCompany}`);

    channel
      .on('presence', { event: 'sync' }, () => {
        const state = channel.presenceState();
        const online = new Set<string>();
        Object.values(state).forEach((presences: any) => {
          presences.forEach((p: any) => {
            if (p.user_id) online.add(p.user_id);
          });
        });
        setOnlineUsers(online);
      })
      .on('presence', { event: 'join' }, ({ newPresences }) => {
        setOnlineUsers(prev => {
          const updated = new Set(prev);
          newPresences.forEach((p: any) => {
            if (p.user_id) updated.add(p.user_id);
          });
          return updated;
        });
      })
      .on('presence', { event: 'leave' }, ({ leftPresences }) => {
        setOnlineUsers(prev => {
          const updated = new Set(prev);
          leftPresences.forEach((p: any) => {
            if (p.user_id) updated.delete(p.user_id);
          });
          return updated;
        });
      })
      .subscribe(async (status) => {
        if (status === 'SUBSCRIBED') {
          await channel.track({ user_id: userId, online_at: new Date().toISOString() });
        }
      });

    return () => {
      supabase.removeChannel(channel);
    };
  }, [userCompany, userId]);

  const fetchUserProfile = async () => {
    const { data, error } = await supabase
      .from("profiles")
      .select("*")
      .eq("id", userId)
      .single();

    if (error) {
      console.error("Error fetching user profile:", error);
    } else {
      setUserCompany(data.company_name);
      setAccountType(data.account_type);
      setIsCompanyAdmin((data as any).is_company_admin ?? false);
    }
  };

  const fetchCompanyContacts = async () => {
    if (!userCompany) return;

    const { data: profilesData, error: profilesError } = await supabase
      .from("profiles")
      .select("id, full_name, email, company_name")
      .eq("company_name", userCompany);

    if (profilesError) {
      console.error("Error fetching contacts:", profilesError);
      toast({
        title: "Error",
        description: "Failed to fetch contacts",
        variant: "destructive",
      });
      return;
    }

    setContacts(profilesData || []);
    if (profilesData && profilesData.length > 0) {
      setSelectedContact(profilesData[0]);

      // Fetch phone numbers for all contacts
      const userIds = profilesData.map(p => p.id);
      const { data: phoneData } = await supabase
        .from("phone_numbers")
        .select("assigned_to, phone_number")
        .in("assigned_to", userIds)
        .eq("is_active", true);

      if (phoneData) {
        const phoneMap: Record<string, string> = {};
        phoneData.forEach(p => {
          if (p.assigned_to) {
            phoneMap[p.assigned_to] = p.phone_number;
          }
        });
        setContactPhones(phoneMap);
      }
    }

    // Fetch departments and organize contacts by department
    const { data: deptData } = await supabase
      .from("departments")
      .select("id, name")
      .eq("company_name", userCompany);

    if (deptData) {
      setDepartments(deptData);
      const organized: ContactsByDepartment = {};

      for (const dept of deptData) {
        const { data: members } = await supabase
          .from("department_members")
          .select(`
            user_id,
            profiles (
              id,
              full_name,
              email,
              company_name
            )
          `)
          .eq("department_id", dept.id);

        if (members) {
          organized[dept.id] = {
            name: dept.name,
            members: members.map(m => m.profiles as any).filter(Boolean),
          };
        }
      }

      setContactsByDept(organized);
    }
  };

  const assignToDepartment = async (contactId: string, departmentId: string) => {
    const { error } = await supabase
      .from("department_members")
      .insert({ user_id: contactId, department_id: departmentId });

    if (error) {
      toast({
        title: "Error",
        description: "Failed to assign contact to department",
        variant: "destructive",
      });
      return;
    }

    toast({ title: "Success", description: "Contact assigned to department" });
    fetchCompanyContacts();
  };

  const removeFromDepartment = async (contactId: string, departmentId: string) => {
    const { error } = await supabase
      .from("department_members")
      .delete()
      .eq("user_id", contactId)
      .eq("department_id", departmentId);

    if (error) {
      toast({
        title: "Error",
        description: "Failed to remove contact from department",
        variant: "destructive",
      });
      return;
    }

    toast({ title: "Success", description: "Contact removed from department" });
    fetchCompanyContacts();
  };

  const moveToDepartment = async (contactId: string, fromDeptId: string, toDeptId: string) => {
    // Remove from current department, then add to new one
    const { error: removeError } = await supabase
      .from("department_members")
      .delete()
      .eq("user_id", contactId)
      .eq("department_id", fromDeptId);

    if (removeError) {
      toast({
        title: "Error",
        description: "Failed to move contact",
        variant: "destructive",
      });
      return;
    }

    const { error: addError } = await supabase
      .from("department_members")
      .insert({ user_id: contactId, department_id: toDeptId });

    if (addError) {
      toast({
        title: "Error",
        description: "Failed to move contact",
        variant: "destructive",
      });
      return;
    }

    toast({ title: "Success", description: "Contact moved to department" });
    fetchCompanyContacts();
  };

  const getInitials = (name: string) => {
    return name
      .split(" ")
      .map(n => n[0])
      .join("")
      .toUpperCase()
      .slice(0, 2);
  };

  // Compute set of user IDs that are in any department
  const usersInDepartments = new Set<string>();
  Object.values(contactsByDept).forEach(dept => {
    dept.members.forEach(m => usersInDepartments.add(m.id));
  });

  const hasDepartments = departments.length > 0;

  // Filter "All Contacts" / "Unassigned" to exclude users already in a department
  const unassignedContacts = contacts.filter(c => !usersInDepartments.has(c.id));

  const filteredUnassigned = unassignedContacts.filter(
    contact =>
      contact.full_name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      contact.email.toLowerCase().includes(searchQuery.toLowerCase())
  );

  // Filter department members by search
  const filteredDepts: ContactsByDepartment = {};
  Object.entries(contactsByDept).forEach(([deptId, dept]) => {
    const filtered = dept.members.filter(
      m =>
        m.full_name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        m.email.toLowerCase().includes(searchQuery.toLowerCase())
    );
    if (filtered.length > 0) {
      filteredDepts[deptId] = { name: dept.name, members: filtered };
    }
  });

  const totalVisible = filteredUnassigned.length +
    Object.values(filteredDepts).reduce((sum, d) => sum + d.members.length, 0);

  if (accountType !== "enterprise") {
    return (
      <div className="flex items-center justify-center h-full p-6">
        <Card className="w-full max-w-md">
          <CardContent className="pt-6">
            <div className="text-center space-y-4">
              <div className="w-16 h-16 mx-auto rounded-full bg-muted flex items-center justify-center">
                <Building2 className="w-8 h-8 text-muted-foreground" />
              </div>
              <h3 className="text-xl font-display font-semibold">Enterprise Feature</h3>
              <p className="text-muted-foreground">
                Contacts are only available for enterprise accounts.
              </p>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  const renderContactItem = (
    contact: Profile,
    options?: { departmentId?: string; departmentName?: string }
  ) => {
    const isSelected = selectedContact?.id === contact.id;
    const hasPhone = contactPhones[contact.id];

    return (
      <div
        key={contact.id}
        className={cn(
          "w-full flex items-center gap-3 px-3 py-2.5 rounded-xl transition-all duration-200",
          isSelected ? "bg-accent shadow-sm" : "hover:bg-muted/50"
        )}
      >
        <button
          onClick={() => setSelectedContact(contact)}
          className="flex items-center gap-3 flex-1 min-w-0"
        >
          <div className="relative">
            <Avatar className="h-10 w-10 border-2 border-background">
              <AvatarFallback className={cn(
                "text-sm",
                isSelected ? "bg-primary/20 text-primary" : "bg-muted"
              )}>
                {getInitials(contact.full_name)}
              </AvatarFallback>
            </Avatar>
            {onlineUsers.has(contact.id) && (
              <span className="absolute bottom-0 right-0 w-2.5 h-2.5 bg-success border-2 border-card rounded-full" />
            )}
          </div>
          <div className="flex-1 text-left min-w-0">
            <p className="font-medium truncate">{contact.full_name}</p>
            <p className="text-xs text-muted-foreground truncate">
              {hasPhone ? contactPhones[contact.id] : contact.email}
            </p>
          </div>
        </button>
        {hasPhone && onCall && (
          <Button
            size="icon"
            variant="ghost"
            className="h-8 w-8 text-success hover:text-success hover:bg-success/10 shrink-0"
            onClick={(e) => {
              e.stopPropagation();
              onCall(contactPhones[contact.id]);
            }}
          >
            <Phone className="h-4 w-4" />
          </Button>
        )}
        {isCompanyAdmin && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                size="icon"
                variant="ghost"
                className="h-8 w-8 shrink-0"
                onClick={(e) => e.stopPropagation()}
              >
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {options?.departmentId ? (
                <>
                  <DropdownMenuItem
                    onClick={() => removeFromDepartment(contact.id, options.departmentId!)}
                  >
                    <X className="h-4 w-4 mr-2" />
                    Remove from {options.departmentName}
                  </DropdownMenuItem>
                  {departments.filter(d => d.id !== options.departmentId).length > 0 && (
                    <DropdownMenuSub>
                      <DropdownMenuSubTrigger>
                        <ArrowRight className="h-4 w-4 mr-2" />
                        Move to Department
                      </DropdownMenuSubTrigger>
                      <DropdownMenuSubContent>
                        {departments
                          .filter(d => d.id !== options.departmentId)
                          .map(dept => (
                            <DropdownMenuItem
                              key={dept.id}
                              onClick={() => moveToDepartment(contact.id, options.departmentId!, dept.id)}
                            >
                              {dept.name}
                            </DropdownMenuItem>
                          ))}
                      </DropdownMenuSubContent>
                    </DropdownMenuSub>
                  )}
                </>
              ) : (
                departments.length > 0 && (
                  <DropdownMenuSub>
                    <DropdownMenuSubTrigger>
                      <ArrowRight className="h-4 w-4 mr-2" />
                      Assign to Department
                    </DropdownMenuSubTrigger>
                    <DropdownMenuSubContent>
                      {departments.map(dept => (
                        <DropdownMenuItem
                          key={dept.id}
                          onClick={() => assignToDepartment(contact.id, dept.id)}
                        >
                          {dept.name}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                )
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
    );
  };

  return (
    <div className="flex h-full">
      {/* Left Sidebar - Contact List */}
      <div className="w-80 border-r border-border bg-card flex flex-col">
        <div className="p-5 border-b border-border space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="font-display text-lg font-semibold flex items-center gap-2">
              <Users className="w-5 h-5 text-primary" />
              Contacts
            </h2>
            <Badge variant="secondary" className="text-xs">
              {contacts.length} people
            </Badge>
          </div>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              placeholder="Search contacts..."
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              className="pl-9 bg-background"
            />
          </div>
        </div>

        <ScrollArea className="flex-1">
          <div className="p-3 space-y-4">
            {/* Unassigned / All Contacts Section */}
            {filteredUnassigned.length > 0 && (
              <div>
                <div className="px-3 py-2 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                  {hasDepartments ? "Unassigned" : "All Contacts"}
                </div>
                <div className="space-y-1">
                  {filteredUnassigned.map(contact => renderContactItem(contact))}
                </div>
              </div>
            )}

            {/* Departments Sections */}
            {Object.entries(filteredDepts).map(([deptId, dept]) => (
              <div key={deptId}>
                <div className="px-3 py-2 text-xs font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-2">
                  <Building2 className="w-3 h-3" />
                  {dept.name}
                </div>
                <div className="space-y-1">
                  {dept.members.map(member =>
                    renderContactItem(member, {
                      departmentId: deptId,
                      departmentName: dept.name,
                    })
                  )}
                </div>
              </div>
            ))}

            {totalVisible === 0 && searchQuery && (
              <div className="text-center py-4 text-sm text-muted-foreground">
                No contacts match your search
              </div>
            )}
          </div>
        </ScrollArea>
      </div>

      {/* Right Panel - Contact Details */}
      <div className="flex-1 flex flex-col bg-background-subtle">
        {selectedContact ? (
          <>
            {/* Contact Header */}
            <div className="border-b border-border bg-card p-6">
              <div className="flex items-center gap-4">
                <div className="relative">
                  <Avatar className="h-16 w-16 border-4 border-background shadow-md">
                    <AvatarFallback className="text-xl bg-primary/10 text-primary font-semibold">
                      {getInitials(selectedContact.full_name)}
                    </AvatarFallback>
                  </Avatar>
                  {onlineUsers.has(selectedContact.id) && (
                    <span className="absolute bottom-1 right-1 w-4 h-4 bg-success border-2 border-card rounded-full" />
                  )}
                </div>
                <div>
                  <h2 className="text-2xl font-display font-semibold">{selectedContact.full_name}</h2>
                  <div className="flex items-center gap-2 mt-1">
                    <Badge className={cn(
                      "border-0 text-xs",
                      onlineUsers.has(selectedContact.id)
                        ? "bg-success/10 text-success"
                        : "bg-muted text-muted-foreground"
                    )}>
                      <span className={cn(
                        "w-1.5 h-1.5 rounded-full mr-1",
                        onlineUsers.has(selectedContact.id) ? "bg-success" : "bg-muted-foreground"
                      )} />
                      {onlineUsers.has(selectedContact.id) ? "Available" : "Offline"}
                    </Badge>
                    {contactPhones[selectedContact.id] && (
                      <>
                        <span className="text-sm font-mono text-muted-foreground">
                          {contactPhones[selectedContact.id]}
                        </span>
                        {onCall && (
                          <Button
                            size="sm"
                            className="bg-success hover:bg-success/90 text-success-foreground"
                            onClick={() => onCall(contactPhones[selectedContact.id])}
                          >
                            <Phone className="h-4 w-4 mr-2" />
                            Call
                          </Button>
                        )}
                      </>
                    )}
                  </div>
                </div>
              </div>
            </div>

            {/* Contact Info */}
            <div className="flex-1 p-6 overflow-auto">
              <Card>
                <CardContent className="pt-6">
                  <h3 className="font-display text-lg font-semibold mb-6">Contact Information</h3>
                  <div className="space-y-4">
                    <div className="flex justify-between items-center py-3 border-b border-border">
                      <span className="text-sm text-muted-foreground">Email</span>
                      <span className="text-sm font-medium">{selectedContact.email}</span>
                    </div>
                    <div className="flex justify-between items-center py-3 border-b border-border">
                      <span className="text-sm text-muted-foreground">Phone</span>
                      <span className="text-sm font-medium font-mono">
                        {contactPhones[selectedContact.id] || "No phone assigned"}
                      </span>
                    </div>
                    <div className="flex justify-between items-center py-3">
                      <span className="text-sm text-muted-foreground">Company</span>
                      <span className="text-sm font-medium">{selectedContact.company_name || "N/A"}</span>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </div>
          </>
        ) : (
          <div className="flex items-center justify-center h-full">
            <div className="text-center">
              <div className="w-20 h-20 mx-auto rounded-full bg-accent flex items-center justify-center mb-4">
                <Users className="w-10 h-10 text-accent-foreground" />
              </div>
              <h3 className="font-display text-lg font-semibold mb-1">Select a Contact</h3>
              <p className="text-sm text-muted-foreground">
                Choose a contact from the list to view details
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
