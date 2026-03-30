import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Building2, PhoneIcon, Plus, Users, UserPlus, UserMinus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";

interface Department {
  id: string;
  name: string;
  company_name: string;
  phone_number_id: string | null;
  created_at: string;
}

interface PhoneNumber {
  id: string;
  phone_number: string;
  assigned_to: string | null;
}

interface Profile {
  id: string;
  full_name: string;
  email: string;
}

interface DepartmentMember {
  id: string;
  user_id: string;
  added_at: string;
  profiles: Profile;
}

const DepartmentManagement = () => {
  const [departments, setDepartments] = useState<Department[]>([]);
  const [phoneNumbers, setPhoneNumbers] = useState<PhoneNumber[]>([]);
  const [companyNames, setCompanyNames] = useState<string[]>([]);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [departmentMembers, setDepartmentMembers] = useState<Record<string, DepartmentMember[]>>({});
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [isUserDialogOpen, setIsUserDialogOpen] = useState(false);
  const [selectedDeptForUsers, setSelectedDeptForUsers] = useState<Department | null>(null);
  const [selectedUserId, setSelectedUserId] = useState("");
  const [newDeptName, setNewDeptName] = useState("");
  const [newDeptCompany, setNewDeptCompany] = useState("");
  const [isCreating, setIsCreating] = useState(false);
  const [isAssigningUser, setIsAssigningUser] = useState(false);
  const { toast } = useToast();

  useEffect(() => {
    fetchDepartments();
    fetchPhoneNumbers();
    fetchCompanyNames();
    fetchProfiles();
  }, []);

  // Fetch members for all departments when departments are loaded
  useEffect(() => {
    departments.forEach(dept => {
      fetchDepartmentMembers(dept.id);
    });
  }, [departments]);

  const fetchCompanyNames = async () => {
    const { data, error } = await supabase
      .from("profiles")
      .select("company_name")
      .not("company_name", "is", null);

    if (error) {
      console.error("Error fetching company names:", error);
    } else {
      // Get unique company names
      const uniqueCompanies = [...new Set(data?.map(p => p.company_name).filter(Boolean) as string[])];
      setCompanyNames(uniqueCompanies);
    }
  };

  const fetchDepartments = async () => {
    const token = localStorage.getItem("admin_session_token");
    if (!token) {
      console.error("Admin session not found");
      return;
    }

    try {
      const { data, error } = await supabase.functions.invoke("admin-department", {
        body: { action: "list" },
        headers: { "x-admin-token": token },
      });

      if (error || !data?.success) {
        console.error("Error fetching departments:", error || data?.error);
      } else {
        setDepartments(data.departments || []);
      }
    } catch (err) {
      console.error("Error fetching departments:", err);
    }
  };

  const fetchPhoneNumbers = async () => {
    const { data, error } = await supabase
      .from("phone_numbers")
      .select("*")
      .order("created_at", { ascending: false });

    if (error) {
      console.error("Error fetching phone numbers:", error);
    } else {
      setPhoneNumbers(data || []);
    }
  };

  const fetchProfiles = async () => {
    const { data, error } = await supabase
      .from("profiles")
      .select("id, full_name, email")
      .order("full_name", { ascending: true });

    if (error) {
      console.error("Error fetching profiles:", error);
    } else {
      setProfiles(data || []);
    }
  };

  const fetchDepartmentMembers = async (departmentId: string) => {
    const token = localStorage.getItem("admin_session_token");
    if (!token) return;

    try {
      const { data, error } = await supabase.functions.invoke("admin-department", {
        body: { action: "list-members", departmentId },
        headers: { "x-admin-token": token },
      });

      if (error || !data?.success) {
        console.error("Error fetching department members:", error || data?.error);
      } else {
        setDepartmentMembers(prev => ({
          ...prev,
          [departmentId]: data.members || []
        }));
      }
    } catch (err) {
      console.error("Error fetching department members:", err);
    }
  };

  const handleAssignUser = async () => {
    if (!selectedDeptForUsers || !selectedUserId) {
      toast({
        title: "Error",
        description: "Please select a user",
        variant: "destructive",
      });
      return;
    }

    const token = localStorage.getItem("admin_session_token");
    if (!token) {
      toast({
        title: "Error",
        description: "Admin session not found",
        variant: "destructive",
      });
      return;
    }

    setIsAssigningUser(true);

    try {
      const { data, error } = await supabase.functions.invoke("admin-department", {
        body: {
          action: "assign-user",
          departmentId: selectedDeptForUsers.id,
          userId: selectedUserId,
        },
        headers: { "x-admin-token": token },
      });

      if (error || !data?.success) {
        throw new Error(data?.error || error?.message || "Failed to assign user");
      }

      toast({
        title: "Success",
        description: "User assigned to department successfully",
      });
      setSelectedUserId("");
      fetchDepartmentMembers(selectedDeptForUsers.id);
    } catch (err: any) {
      toast({
        title: "Error",
        description: err?.message || "Failed to assign user",
        variant: "destructive",
      });
    } finally {
      setIsAssigningUser(false);
    }
  };

  const handleRemoveUser = async (departmentId: string, userId: string) => {
    const token = localStorage.getItem("admin_session_token");
    if (!token) {
      toast({
        title: "Error",
        description: "Admin session not found",
        variant: "destructive",
      });
      return;
    }

    try {
      const { data, error } = await supabase.functions.invoke("admin-department", {
        body: {
          action: "remove-user",
          departmentId,
          userId,
        },
        headers: { "x-admin-token": token },
      });

      if (error || !data?.success) {
        throw new Error(data?.error || error?.message || "Failed to remove user");
      }

      toast({
        title: "Success",
        description: "User removed from department",
      });
      fetchDepartmentMembers(departmentId);
    } catch (err: any) {
      toast({
        title: "Error",
        description: err?.message || "Failed to remove user",
        variant: "destructive",
      });
    }
  };

  const openUserDialog = (dept: Department) => {
    setSelectedDeptForUsers(dept);
    setSelectedUserId("");
    setIsUserDialogOpen(true);
    fetchDepartmentMembers(dept.id);
  };

  const getAvailableUsersForDepartment = (departmentId: string) => {
    const currentMembers = departmentMembers[departmentId] || [];
    const memberUserIds = currentMembers.map(m => m.user_id);
    return profiles.filter(p => !memberUserIds.includes(p.id));
  };

  const handleAssignPhone = async (departmentId: string, phoneNumberId: string | null) => {
    const token = localStorage.getItem("admin_session_token");
    if (!token) {
      toast({
        title: "Error",
        description: "Admin session not found",
        variant: "destructive",
      });
      return;
    }

    try {
      const { data, error } = await supabase.functions.invoke("admin-department", {
        body: {
          action: "assign-phone",
          departmentId,
          phoneNumberId,
        },
        headers: {
          "x-admin-token": token,
        },
      });

      if (error || !data?.success) {
        throw new Error(data?.error || error?.message || "Failed to assign phone number");
      }

      toast({
        title: "Success",
        description: phoneNumberId ? "Phone number assigned successfully" : "Phone number unassigned successfully",
      });
      fetchDepartments();
    } catch (err: any) {
      toast({
        title: "Error",
        description: err?.message || "Failed to assign phone number",
        variant: "destructive",
      });
    }
  };

  const getPhoneNumber = (phoneNumberId: string | null) => {
    if (!phoneNumberId) return "Not assigned";
    const phone = phoneNumbers.find((p) => p.id === phoneNumberId);
    return phone?.phone_number || "Unknown";
  };

  // Get available phone numbers (not assigned to users or other departments)
  const getAvailablePhones = (currentPhoneId: string | null) => {
    return phoneNumbers.filter(
      (phone) => 
        !phone.assigned_to && // Not assigned to a user
        (phone.id === currentPhoneId || // Current phone of this department
         !departments.some(d => d.phone_number_id === phone.id)) // Not assigned to any other department
    );
  };

  const handleCreateDepartment = async () => {
    if (!newDeptName.trim() || !newDeptCompany.trim()) {
      toast({
        title: "Error",
        description: "Please fill in all fields",
        variant: "destructive",
      });
      return;
    }

    const token = localStorage.getItem("admin_session_token");
    if (!token) {
      toast({
        title: "Error",
        description: "Admin session not found",
        variant: "destructive",
      });
      return;
    }

    setIsCreating(true);

    try {
      const { data, error } = await supabase.functions.invoke("admin-department", {
        body: {
          action: "create",
          name: newDeptName.trim(),
          companyName: newDeptCompany.trim(),
        },
        headers: {
          "x-admin-token": token,
        },
      });

      if (error || !data?.success) {
        throw new Error(data?.error || error?.message || "Failed to create department");
      }

      toast({
        title: "Success",
        description: "Department created successfully",
      });
      setNewDeptName("");
      setNewDeptCompany("");
      setIsDialogOpen(false);
      fetchDepartments();
    } catch (err: any) {
      console.error("Error creating department:", err);
      toast({
        title: "Error",
        description: err?.message || "Failed to create department",
        variant: "destructive",
      });
    } finally {
      setIsCreating(false);
    }
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="flex items-center gap-2">
          <Building2 className="w-5 h-5" />
          Departments
        </CardTitle>
        <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
          <DialogTrigger asChild>
            <Button size="sm">
              <Plus className="w-4 h-4 mr-2" />
              Create Department
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Create New Department</DialogTitle>
            </DialogHeader>
            <div className="space-y-4 pt-4">
              <div className="space-y-2">
                <Label htmlFor="deptName">Department Name</Label>
                <Input
                  id="deptName"
                  placeholder="e.g. Sales, Support"
                  value={newDeptName}
                  onChange={(e) => setNewDeptName(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="companyName">Company Name</Label>
                <Select value={newDeptCompany} onValueChange={setNewDeptCompany}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select a company" />
                  </SelectTrigger>
                  <SelectContent>
                    {companyNames.map((company) => (
                      <SelectItem key={company} value={company}>
                        {company}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <Button 
                className="w-full" 
                onClick={handleCreateDepartment}
                disabled={isCreating}
              >
                {isCreating ? "Creating..." : "Create Department"}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </CardHeader>
      <CardContent>
        {departments.length === 0 ? (
          <div className="text-center py-8 text-muted-foreground">
            No departments yet. Click "Create Department" to add one.
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Department Name</TableHead>
                <TableHead>Company</TableHead>
                <TableHead>Assigned Phone Number</TableHead>
                <TableHead>Assigned Users</TableHead>
                <TableHead>Created</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {departments.map((department) => {
                const members = departmentMembers[department.id] || [];
                return (
                  <TableRow key={department.id}>
                    <TableCell className="font-medium">{department.name}</TableCell>
                    <TableCell>{department.company_name}</TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <PhoneIcon className="w-4 h-4 text-muted-foreground" />
                        {getPhoneNumber(department.phone_number_id)}
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <Badge variant="secondary" className="gap-1">
                          <Users className="w-3 h-3" />
                          {members.length}
                        </Badge>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => openUserDialog(department)}
                        >
                          <UserPlus className="w-4 h-4" />
                        </Button>
                      </div>
                    </TableCell>
                    <TableCell>
                      {new Date(department.created_at).toLocaleDateString()}
                    </TableCell>
                    <TableCell className="text-right">
                      <Select
                        value={department.phone_number_id || "unassigned"}
                        onValueChange={(value) =>
                          handleAssignPhone(
                            department.id,
                            value === "unassigned" ? null : value
                          )
                        }
                      >
                        <SelectTrigger className="w-40">
                          <SelectValue placeholder="Assign phone" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="unassigned">Unassigned</SelectItem>
                          {getAvailablePhones(department.phone_number_id).map((phone) => (
                            <SelectItem key={phone.id} value={phone.id}>
                              {phone.phone_number}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}

        {/* User Assignment Dialog */}
        <Dialog open={isUserDialogOpen} onOpenChange={setIsUserDialogOpen}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Users className="w-5 h-5" />
                Manage Users - {selectedDeptForUsers?.name}
              </DialogTitle>
            </DialogHeader>
            <div className="space-y-4 pt-4">
              {/* Add User Section */}
              <div className="space-y-2">
                <Label>Add User to Department</Label>
                <div className="flex gap-2">
                  <Select value={selectedUserId} onValueChange={setSelectedUserId}>
                    <SelectTrigger className="flex-1">
                      <SelectValue placeholder="Select a user" />
                    </SelectTrigger>
                    <SelectContent>
                      {selectedDeptForUsers && getAvailableUsersForDepartment(selectedDeptForUsers.id).map((profile) => (
                        <SelectItem key={profile.id} value={profile.id}>
                          {profile.full_name} ({profile.email})
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button
                    onClick={handleAssignUser}
                    disabled={!selectedUserId || isAssigningUser}
                    size="sm"
                  >
                    <UserPlus className="w-4 h-4" />
                  </Button>
                </div>
              </div>

              {/* Current Members List */}
              <div className="space-y-2">
                <Label>Current Members</Label>
                <div className="border rounded-lg divide-y max-h-60 overflow-y-auto">
                  {selectedDeptForUsers && (departmentMembers[selectedDeptForUsers.id] || []).length === 0 ? (
                    <div className="p-4 text-center text-muted-foreground text-sm">
                      No users assigned to this department
                    </div>
                  ) : (
                    selectedDeptForUsers && (departmentMembers[selectedDeptForUsers.id] || []).map((member) => (
                      <div key={member.id} className="flex items-center justify-between p-3">
                        <div>
                          <p className="font-medium text-sm">{member.profiles.full_name}</p>
                          <p className="text-xs text-muted-foreground">{member.profiles.email}</p>
                        </div>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="text-destructive hover:text-destructive"
                          onClick={() => handleRemoveUser(selectedDeptForUsers.id, member.user_id)}
                        >
                          <UserMinus className="w-4 h-4" />
                        </Button>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  );
};

export default DepartmentManagement;
