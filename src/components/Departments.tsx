import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
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
import { Building2, UserPlus, Trash2, Users } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import { Badge } from "@/components/ui/badge";

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

interface DepartmentsProps {
  userId?: string;
}

const Departments = ({ userId }: DepartmentsProps) => {
  const [departments, setDepartments] = useState<Department[]>([]);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [departmentMembers, setDepartmentMembers] = useState<Record<string, DepartmentMember[]>>({});
  const [newDeptName, setNewDeptName] = useState("");
  const [newDeptDescription, setNewDeptDescription] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [addMemberDialogOpen, setAddMemberDialogOpen] = useState(false);
  const [selectedDepartment, setSelectedDepartment] = useState("");
  const [selectedUser, setSelectedUser] = useState("");
  const [userCompany, setUserCompany] = useState<string | null>(null);
  const [accountType, setAccountType] = useState<string>("");
  const { toast } = useToast();

  useEffect(() => {
    if (userId) {
      fetchUserProfile();
    }
  }, [userId]);

  useEffect(() => {
    if (userCompany && accountType === 'enterprise') {
      fetchDepartments();
      fetchCompanyProfiles();
    }
  }, [userCompany, accountType]);

  const fetchUserProfile = async () => {
    const { data, error } = await supabase
      .from("profiles")
      .select("company_name, account_type")
      .eq("id", userId)
      .single();

    if (error) {
      console.error("Error fetching user profile:", error);
      if (data?.account_type !== 'enterprise') {
        toast({
          title: "Access Denied",
          description: "This feature is only available for enterprise accounts",
          variant: "destructive",
        });
      }
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
      // Fetch members for each department
      data?.forEach(dept => fetchDepartmentMembers(dept.id));
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
      setDepartmentMembers(prev => ({
        ...prev,
        [departmentId]: data as any || []
      }));
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

    const { error } = await supabase.from("department_members").insert({
      department_id: selectedDepartment,
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
      fetchDepartmentMembers(selectedDepartment);
    }
  };

  const handleRemoveMember = async (memberId: string, departmentId: string) => {
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
      fetchDepartmentMembers(departmentId);
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
      fetchDepartments();
    }
  };

  if (accountType !== 'enterprise') {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <Card className="w-full max-w-md">
          <CardContent className="pt-6">
            <div className="text-center space-y-4">
              <Building2 className="w-12 h-12 mx-auto text-muted-foreground" />
              <h3 className="text-lg font-semibold">Enterprise Feature</h3>
              <p className="text-muted-foreground">
                Departments are only available for enterprise accounts. Please upgrade your account to access this feature.
              </p>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!userCompany) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <Card className="w-full max-w-md">
          <CardContent className="pt-6">
            <div className="text-center space-y-4">
              <Building2 className="w-12 h-12 mx-auto text-muted-foreground" />
              <h3 className="text-lg font-semibold">Company Name Required</h3>
              <p className="text-muted-foreground">
                Please set your company name in your profile to use departments.
              </p>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  const totalMembers = Object.values(departmentMembers).reduce(
    (sum, members) => sum + members.length,
    0
  );
  const avgMembersPerDept = departments.length > 0 
    ? (totalMembers / departments.length).toFixed(1) 
    : 0;

  return (
    <div className="space-y-6">
      {/* Analytics Section */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Total Departments</p>
                <p className="text-3xl font-bold">{departments.length}</p>
              </div>
              <Building2 className="w-8 h-8 text-primary" />
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Total Members</p>
                <p className="text-3xl font-bold">{totalMembers}</p>
              </div>
              <Users className="w-8 h-8 text-primary" />
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Avg Members/Dept</p>
                <p className="text-3xl font-bold">{avgMembersPerDept}</p>
              </div>
              <UserPlus className="w-8 h-8 text-primary" />
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <div>
            <CardTitle>Departments</CardTitle>
            <p className="text-sm text-muted-foreground mt-1">
              Company: {userCompany}
            </p>
          </div>
          <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
            <DialogTrigger asChild>
              <Button>
                <Building2 className="w-4 h-4 mr-2" />
                Create Department
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
        </CardHeader>
        <CardContent>
          {departments.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              No departments yet. Create one to get started!
            </div>
          ) : (
            <div className="space-y-6">
              {departments.map((dept) => (
                <Card key={dept.id}>
                  <CardHeader>
                    <div className="flex items-start justify-between">
                      <div className="flex-1">
                        <div className="flex items-center gap-2">
                          <CardTitle className="text-lg">{dept.name}</CardTitle>
                          <Badge variant="secondary">
                            <Users className="w-3 h-3 mr-1" />
                            {departmentMembers[dept.id]?.length || 0}
                          </Badge>
                        </div>
                        {dept.description && (
                          <p className="text-sm text-muted-foreground mt-1">
                            {dept.description}
                          </p>
                        )}
                      </div>
                      <div className="flex gap-2">
                        <Dialog 
                          open={addMemberDialogOpen && selectedDepartment === dept.id}
                          onOpenChange={(open) => {
                            setAddMemberDialogOpen(open);
                            if (open) setSelectedDepartment(dept.id);
                          }}
                        >
                          <DialogTrigger asChild>
                            <Button size="sm" variant="outline">
                              <UserPlus className="w-4 h-4 mr-2" />
                              Add Member
                            </Button>
                          </DialogTrigger>
                          <DialogContent>
                            <DialogHeader>
                              <DialogTitle>Add Member to {dept.name}</DialogTitle>
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
                                        !departmentMembers[dept.id]?.some(m => m.user_id === profile.id)
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
                          size="sm"
                          variant="ghost"
                          onClick={() => handleDeleteDepartment(dept.id)}
                        >
                          <Trash2 className="w-4 h-4" />
                        </Button>
                      </div>
                    </div>
                  </CardHeader>
                  <CardContent>
                    {!departmentMembers[dept.id] || departmentMembers[dept.id].length === 0 ? (
                      <div className="text-center py-4 text-muted-foreground text-sm">
                        No members yet
                      </div>
                    ) : (
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>Name</TableHead>
                            <TableHead>Email</TableHead>
                            <TableHead className="text-right">Actions</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {departmentMembers[dept.id].map((member) => (
                            <TableRow key={member.id}>
                              <TableCell className="font-medium">
                                {member.profiles.full_name}
                              </TableCell>
                              <TableCell>{member.profiles.email}</TableCell>
                              <TableCell className="text-right">
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  onClick={() => handleRemoveMember(member.id, dept.id)}
                                >
                                  <Trash2 className="w-4 h-4" />
                                </Button>
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    )}
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
};

export default Departments;