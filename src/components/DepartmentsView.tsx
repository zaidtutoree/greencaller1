import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Building2, UserPlus, Trash2, Users, Plus, Phone, Clock } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Device } from '@twilio/voice-sdk';

interface Department {
  id: string;
  name: string;
  description: string | null;
  company_name: string;
  created_at: string;
}

interface Profile {
  id: string;
  full_name: string;
  email: string;
  company_name: string | null;
}

interface DepartmentMember {
  id: string;
  department_id: string;
  user_id: string;
  profiles: {
    full_name: string;
    email: string;
  };
}

interface QueuedCall {
  id: string;
  call_sid: string;
  from_number: string;
  created_at: string;
  status: string;
  department_id: string;
}

interface DepartmentsViewProps {
  userId?: string;
}

export const DepartmentsView = ({ userId }: DepartmentsViewProps) => {
  const [departments, setDepartments] = useState<Department[]>([]);
  const [selectedDept, setSelectedDept] = useState<Department | null>(null);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [departmentMembers, setDepartmentMembers] = useState<DepartmentMember[]>([]);
  const [queuedCalls, setQueuedCalls] = useState<QueuedCall[]>([]);
  const [twilioDevice, setTwilioDevice] = useState<Device | null>(null);
  const [newDeptName, setNewDeptName] = useState("");
  const [newDeptDescription, setNewDeptDescription] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [addMemberDialogOpen, setAddMemberDialogOpen] = useState(false);
  const [selectedUser, setSelectedUser] = useState("");
  const [userCompany, setUserCompany] = useState<string | null>(null);
  const [accountType, setAccountType] = useState<string>("");
  const { toast } = useToast();

  useEffect(() => {
    if (userId) {
      fetchUserProfile();
      initializeTwilio();
    }
  }, [userId]);

  useEffect(() => {
    if (userCompany && accountType === 'enterprise') {
      fetchDepartments();
      fetchCompanyProfiles();
    }
  }, [userCompany, accountType]);

  useEffect(() => {
    if (selectedDept) {
      fetchDepartmentMembers(selectedDept.id);
      fetchQueuedCalls();
    }
  }, [selectedDept]);

  useEffect(() => {
    if (!selectedDept) return;

    const channel = supabase
      .channel('call-queue-changes')
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'call_queue',
          filter: `department_id=eq.${selectedDept.id}`
        },
        () => {
          fetchQueuedCalls();
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [selectedDept]);

  const initializeTwilio = async () => {
    try {
      const { data: session } = await supabase.auth.getSession();
      if (!session.session) return;

      const { data, error } = await supabase.functions.invoke('generate-token', {
        body: { userId: session.session.user.id }
      });

      if (error) throw error;

      const device = new Device(data.token);
      setTwilioDevice(device);
    } catch (error) {
      console.error('Error initializing Twilio:', error);
    }
  };

  const fetchUserProfile = async () => {
    const { data, error } = await supabase
      .from("profiles")
      .select("company_name, account_type")
      .eq("id", userId)
      .single();

    if (error) {
      console.error("Error fetching user profile:", error);
    } else {
      setUserCompany(data.company_name);
      setAccountType(data.account_type);
    }
  };

  const fetchDepartments = async () => {
    if (!userCompany) return;

    const { data, error } = await supabase
      .from("departments")
      .select("*")
      .eq("company_name", userCompany)
      .order("created_at", { ascending: false });

    if (error) {
      console.error("Error fetching departments:", error);
      toast({
        title: "Error",
        description: "Failed to fetch departments",
        variant: "destructive",
      });
    } else {
      setDepartments(data || []);
      if (data && data.length > 0 && !selectedDept) {
        setSelectedDept(data[0]);
      }
    }
  };

  const fetchDepartmentMembers = async (departmentId: string) => {
    const { data, error } = await supabase
      .from("department_members")
      .select(`
        id,
        department_id,
        user_id,
        profiles (
          full_name,
          email
        )
      `)
      .eq("department_id", departmentId);

    if (error) {
      console.error("Error fetching department members:", error);
    } else {
      setDepartmentMembers(data as any || []);
    }
  };

  const fetchQueuedCalls = async () => {
    if (!selectedDept) return;

    try {
      const { data, error } = await supabase
        .from('call_queue')
        .select('*')
        .eq('department_id', selectedDept.id)
        .eq('status', 'waiting')
        .order('created_at', { ascending: true });

      if (error) throw error;
      setQueuedCalls(data || []);
    } catch (error) {
      console.error('Error fetching queued calls:', error);
    }
  };

  const fetchCompanyProfiles = async () => {
    if (!userCompany) return;

    const { data, error } = await supabase
      .from("profiles")
      .select("id, full_name, email, company_name")
      .eq("company_name", userCompany);

    if (error) {
      console.error("Error fetching profiles:", error);
    } else {
      setProfiles(data || []);
    }
  };

  const handleCreateDepartment = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!userCompany || !userId) {
      toast({
        title: "Error",
        description: "User company information not found",
        variant: "destructive",
      });
      return;
    }

    const { error } = await supabase.from("departments").insert({
      name: newDeptName,
      description: newDeptDescription,
      company_name: userCompany,
      created_by: userId,
    });

    if (error) {
      toast({
        title: "Error",
        description: "Failed to create department",
        variant: "destructive",
      });
    } else {
      toast({
        title: "Success",
        description: "Department created successfully",
      });
      setNewDeptName("");
      setNewDeptDescription("");
      setDialogOpen(false);
      fetchDepartments();
    }
  };

  const handleAddMember = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!selectedDept) return;

    const { error } = await supabase.from("department_members").insert({
      department_id: selectedDept.id,
      user_id: selectedUser,
    });

    if (error) {
      if (error.code === '23505') {
        toast({
          title: "Error",
          description: "This user is already in the department",
          variant: "destructive",
        });
      } else {
        toast({
          title: "Error",
          description: "Failed to add member",
          variant: "destructive",
        });
      }
    } else {
      toast({
        title: "Success",
        description: "Member added successfully",
      });
      setAddMemberDialogOpen(false);
      setSelectedUser("");
      fetchDepartmentMembers(selectedDept.id);
    }
  };

  const handleRemoveMember = async (memberId: string) => {
    const { error } = await supabase
      .from("department_members")
      .delete()
      .eq("id", memberId);

    if (error) {
      toast({
        title: "Error",
        description: "Failed to remove member",
        variant: "destructive",
      });
    } else {
      toast({
        title: "Success",
        description: "Member removed successfully",
      });
      if (selectedDept) {
        fetchDepartmentMembers(selectedDept.id);
      }
    }
  };

  const handleDeleteDepartment = async (departmentId: string) => {
    const { error } = await supabase
      .from("departments")
      .delete()
      .eq("id", departmentId);

    if (error) {
      toast({
        title: "Error",
        description: "Failed to delete department",
        variant: "destructive",
      });
    } else {
      toast({
        title: "Success",
        description: "Department deleted successfully",
      });
      setSelectedDept(null);
      fetchDepartments();
    }
  };

  const handleTakeCall = async (queueId: string) => {
    try {
      const { data: session } = await supabase.auth.getSession();
      if (!session.session) {
        toast({
          title: 'Error',
          description: 'You must be logged in',
          variant: 'destructive',
        });
        return;
      }

      toast({
        title: 'Connecting...',
        description: 'Picking up the call',
      });

      const { data, error } = await supabase.functions.invoke('pickup-call', {
        body: {
          queueId,
          userId: session.session.user.id
        }
      });

      if (error) throw error;

      if (twilioDevice && data.conferenceName) {
        await twilioDevice.connect({
          params: {
            To: data.conferenceName,
            conferenceName: data.conferenceName,
            isAgent: 'true'
          }
        });

        toast({
          title: 'Connected',
          description: 'You are now connected to the caller',
        });

        await supabase
          .from('call_queue')
          .update({ status: 'connected', connected_at: new Date().toISOString() })
          .eq('id', queueId);
      }
    } catch (error) {
      console.error('Error picking up call:', error);
      toast({
        title: 'Error',
        description: 'Failed to pick up call',
        variant: 'destructive',
      });
    }
  };

  const getInitials = (name: string) => {
    return name
      .split(" ")
      .map(n => n[0])
      .join("")
      .toUpperCase()
      .slice(0, 2);
  };

  const formatWaitTime = (createdAt: string) => {
    const now = new Date();
    const created = new Date(createdAt);
    const diffMs = now.getTime() - created.getTime();
    const diffSecs = Math.floor(diffMs / 1000);
    const diffMins = Math.floor(diffSecs / 60);
    
    if (diffMins < 1) return `${diffSecs}s`;
    if (diffMins < 60) return `${diffMins}m ${diffSecs % 60}s`;
    const diffHours = Math.floor(diffMins / 60);
    return `${diffHours}h ${diffMins % 60}m`;
  };

  if (accountType !== 'enterprise') {
    return (
      <div className="flex items-center justify-center h-full">
        <Card className="w-full max-w-md">
          <CardContent className="pt-6">
            <div className="text-center space-y-4">
              <Building2 className="w-12 h-12 mx-auto text-muted-foreground" />
              <h3 className="text-lg font-semibold">Enterprise Feature</h3>
              <p className="text-muted-foreground">
                Departments are only available for enterprise accounts.
              </p>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex h-[calc(100vh-12rem)]">
      {/* Left Sidebar - Departments List */}
      <div className="w-80 border-r bg-card flex flex-col">
        <div className="p-4 border-b">
          <h3 className="text-lg font-semibold text-foreground">Departments</h3>
          <p className="text-sm text-muted-foreground">Select to view queue</p>
        </div>

        <ScrollArea className="flex-1">
          <div className="p-3 space-y-2">
            {departments.length === 0 ? (
              <div className="text-center py-8 px-4 text-sm text-muted-foreground">
                No departments yet. Create one to get started!
              </div>
            ) : (
              departments.map((dept) => {
                const isSelected = selectedDept?.id === dept.id;
                const memberCount = isSelected ? departmentMembers.length : 0;
                const waitingCount = isSelected ? queuedCalls.length : 0;
                
                return (
                  <button
                    key={dept.id}
                    onClick={() => setSelectedDept(dept)}
                    className={`w-full p-4 rounded-xl transition-all duration-200 text-left ${
                      isSelected 
                        ? 'bg-primary/10 border-2 border-primary/20 shadow-sm' 
                        : 'bg-muted/30 border-2 border-transparent hover:bg-muted/50 hover:border-muted'
                    }`}
                  >
                    <div className="flex items-start gap-3">
                      <div className={`flex items-center justify-center w-10 h-10 rounded-lg ${
                        isSelected ? 'bg-primary/20' : 'bg-muted'
                      }`}>
                        <Users className={`w-5 h-5 ${isSelected ? 'text-primary' : 'text-muted-foreground'}`} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className={`font-semibold truncate ${isSelected ? 'text-primary' : 'text-foreground'}`}>
                          {dept.name}
                        </p>
                        <div className="flex items-center gap-2 mt-1">
                          <span className="flex items-center gap-1 text-xs">
                            <span className={`w-2 h-2 rounded-full ${isSelected && waitingCount > 0 ? 'bg-warning animate-pulse' : 'bg-success'}`} />
                            <span className="text-muted-foreground">
                              {isSelected && waitingCount > 0 ? `${waitingCount} waiting` : 'Active'}
                            </span>
                          </span>
                          {isSelected && memberCount > 0 && (
                            <span className="text-xs text-muted-foreground">
                              • {memberCount} members
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </ScrollArea>

        <div className="p-3 border-t">
          <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
            <DialogTrigger asChild>
              <Button variant="outline" className="w-full">
                <Plus className="w-4 h-4 mr-2" />
                New Department
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Create New Department</DialogTitle>
                <DialogDescription>
                  Add a new department to your organization
                </DialogDescription>
              </DialogHeader>
              <form onSubmit={handleCreateDepartment} className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="deptName">Department Name</Label>
                  <Input
                    id="deptName"
                    value={newDeptName}
                    onChange={(e) => setNewDeptName(e.target.value)}
                    placeholder="Engineering"
                    required
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="deptDescription">Description</Label>
                  <Textarea
                    id="deptDescription"
                    value={newDeptDescription}
                    onChange={(e) => setNewDeptDescription(e.target.value)}
                    placeholder="Department description (optional)"
                    rows={3}
                  />
                </div>
                <Button type="submit" className="w-full">Create Department</Button>
              </form>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      {/* Right Panel - Department Details */}
      <div className="flex-1 flex flex-col">
        {selectedDept ? (
          <>
            <div className="border-b bg-card p-6">
              <div className="flex items-center justify-between">
                <div>
                    <h2 className="text-2xl font-semibold flex items-center gap-2">
                      {selectedDept.name}
                      <Badge variant="secondary">
                        <Users className="w-3 h-3 mr-1" />
                        {departmentMembers.length}
                      </Badge>
                      {queuedCalls.length > 0 && (
                        <Badge variant="default" className="bg-warning text-warning-foreground">
                          <Phone className="w-3 h-3 mr-1" />
                          {queuedCalls.length} waiting
                        </Badge>
                      )}
                    </h2>
                  {selectedDept.description && (
                    <p className="text-muted-foreground mt-1">{selectedDept.description}</p>
                  )}
                </div>
                <div className="flex gap-2">
                  <Dialog open={addMemberDialogOpen} onOpenChange={setAddMemberDialogOpen}>
                    <DialogTrigger asChild>
                      <Button>
                        <UserPlus className="w-4 h-4 mr-2" />
                        Add Member
                      </Button>
                    </DialogTrigger>
                    <DialogContent>
                      <DialogHeader>
                        <DialogTitle>Add Member to {selectedDept.name}</DialogTitle>
                        <DialogDescription>
                          Select a user from your company to add to this department
                        </DialogDescription>
                      </DialogHeader>
                      <form onSubmit={handleAddMember} className="space-y-4">
                        <div className="space-y-2">
                          <Label>User</Label>
                          <Select value={selectedUser} onValueChange={setSelectedUser} required>
                            <SelectTrigger>
                              <SelectValue placeholder="Select user" />
                            </SelectTrigger>
                            <SelectContent>
                              {profiles
                                .filter(profile => 
                                  !departmentMembers.some(m => m.user_id === profile.id)
                                )
                                .map((profile) => (
                                  <SelectItem key={profile.id} value={profile.id}>
                                    {profile.full_name} ({profile.email})
                                  </SelectItem>
                                ))}
                            </SelectContent>
                          </Select>
                        </div>
                        <Button type="submit" className="w-full">Add Member</Button>
                      </form>
                    </DialogContent>
                  </Dialog>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => handleDeleteDepartment(selectedDept.id)}
                  >
                    <Trash2 className="w-4 h-4" />
                  </Button>
                </div>
              </div>
            </div>

            <ScrollArea className="flex-1 p-6">
              <div className="space-y-6">
                {queuedCalls.length > 0 && (
                  <div>
                    <h3 className="text-lg font-semibold mb-4">Call Queue</h3>
                    <div className="space-y-3">
                      {queuedCalls.map((call) => (
                        <Card key={call.id} className="bg-warning/5 border-warning/20">
                          <CardContent className="p-4">
                            <div className="flex items-center justify-between">
                              <div className="flex items-center gap-3">
                                <div className="flex items-center justify-center w-10 h-10 rounded-full bg-warning/10">
                                  <Phone className="w-5 h-5 text-warning" />
                                </div>
                                <div>
                                  <p className="font-medium">{call.from_number}</p>
                                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                                    <Clock className="w-3 h-3" />
                                    <span>Waiting {formatWaitTime(call.created_at)}</span>
                                  </div>
                                </div>
                              </div>
                              <Button onClick={() => handleTakeCall(call.id)} size="sm">
                                <Phone className="w-4 h-4 mr-2" />
                                Take Call
                              </Button>
                            </div>
                          </CardContent>
                        </Card>
                      ))}
                    </div>
                  </div>
                )}

                <div>
                  <h3 className="text-lg font-semibold mb-4">Team Members</h3>
                  <div className="space-y-4">
                {departmentMembers.length === 0 ? (
                  <Card>
                    <CardContent className="py-12">
                      <div className="text-center text-muted-foreground">
                        <Users className="w-12 h-12 mx-auto mb-4" />
                        <p>No members in this department yet</p>
                        <p className="text-sm mt-2">Click "Add Member" to add users</p>
                      </div>
                    </CardContent>
                  </Card>
                ) : (
                  departmentMembers.map((member) => (
                    <Card key={member.id}>
                      <CardContent className="p-4">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-3">
                            <Avatar className="h-10 w-10">
                              <AvatarFallback>
                                {getInitials(member.profiles.full_name)}
                              </AvatarFallback>
                            </Avatar>
                            <div>
                              <p className="font-medium">{member.profiles.full_name}</p>
                              <p className="text-sm text-muted-foreground">{member.profiles.email}</p>
                            </div>
                          </div>
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => handleRemoveMember(member.id)}
                          >
                            <Trash2 className="w-4 h-4" />
                          </Button>
                        </div>
                      </CardContent>
                    </Card>
                  ))
                )}
                  </div>
                </div>
              </div>
            </ScrollArea>
          </>
        ) : (
          <div className="flex items-center justify-center h-full">
            <div className="text-center text-muted-foreground">
              <Building2 className="w-12 h-12 mx-auto mb-4" />
              <p>Select a department to view details</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
