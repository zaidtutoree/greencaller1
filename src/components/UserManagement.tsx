import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { UserPlus, Phone as PhoneIcon, RefreshCw, UserMinus, Trash2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";

interface Profile {
  id: string;
  full_name: string;
  email: string;
  created_at: string;
  account_type: 'basic' | 'premium' | 'enterprise';
  company_name: string | null;
}

interface PhoneNumber {
  id: string;
  phone_number: string;
  assigned_to: string | null;
  provider: string;
}

interface Department {
  id: string;
  name: string;
  company_name: string;
  phone_number_id: string | null;
}

const UserManagement = () => {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [phoneNumbers, setPhoneNumbers] = useState<PhoneNumber[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [newPhoneNumber, setNewPhoneNumber] = useState("");
  const [selectedUser, setSelectedUser] = useState("");
  const [selectedPhone, setSelectedPhone] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [phoneDialogOpen, setPhoneDialogOpen] = useState(false);
  const [createUserDialogOpen, setCreateUserDialogOpen] = useState(false);
  const [newUserFullName, setNewUserFullName] = useState("");
  const [newUserEmail, setNewUserEmail] = useState("");
  const [newUserPassword, setNewUserPassword] = useState("");
  const [creatingUser, setCreatingUser] = useState(false);
  const [syncingTwilio, setSyncingTwilio] = useState(false);
  const [syncingTelnyx, setSyncingTelnyx] = useState(false);
  const { toast } = useToast();

  useEffect(() => {
    fetchProfiles();
    fetchPhoneNumbers();
    fetchDepartments();
  }, []);

  const fetchProfiles = async () => {
    const { data, error } = await supabase
      .from("profiles")
      .select("*")
      .order("created_at", { ascending: false });

    if (error) {
      console.error("Error fetching profiles:", error);
    } else {
      setProfiles(data || []);
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

  const handleAddPhoneNumber = async (e: React.FormEvent) => {
    e.preventDefault();

    const { error } = await supabase.from("phone_numbers").insert({
      phone_number: newPhoneNumber,
    });

    if (error) {
      toast({
        title: "Error",
        description: "Failed to add phone number",
        variant: "destructive",
      });
    } else {
      toast({
        title: "Success",
        description: "Phone number added successfully",
      });
      setNewPhoneNumber("");
      setPhoneDialogOpen(false);
      fetchPhoneNumbers();
    }
  };

  const handleAssignPhone = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!selectedPhone || !selectedUser) {
      toast({
        title: "Missing selection",
        description: "Please select both a phone number and a user.",
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

    try {
      const { data, error } = await supabase.functions.invoke("admin-assign-phone", {
        body: {
          action: "assign",
          phoneId: selectedPhone,
          userId: selectedUser,
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
        description: "Phone number assigned successfully",
      });
      setDialogOpen(false);
      setSelectedPhone("");
      setSelectedUser("");
      fetchPhoneNumbers();
    } catch (err: any) {
      toast({
        title: "Error",
        description: err?.message || "Failed to assign phone number",
        variant: "destructive",
      });
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

  // Check if phone is assigned to a department
  const getDepartmentForPhone = (phoneId: string) => {
    return departments.find((d) => d.phone_number_id === phoneId);
  };

  // Get the assignment display info for a phone number
  const getAssignmentInfo = (phone: PhoneNumber) => {
    // First check if assigned to a user
    if (phone.assigned_to) {
      const profile = profiles.find((p) => p.id === phone.assigned_to);
      return {
        assignedTo: profile?.full_name || "Unknown User",
        companyName: profile?.company_name || "-",
        isAssigned: true,
        type: "user" as const,
      };
    }

    // Check if assigned to a department
    const department = getDepartmentForPhone(phone.id);
    if (department) {
      return {
        assignedTo: department.name,
        companyName: department.company_name || "-",
        isAssigned: true,
        type: "department" as const,
      };
    }

    // Not assigned to anyone
    return {
      assignedTo: "Unassigned",
      companyName: "-",
      isAssigned: false,
      type: null,
    };
  };

  const getUserName = (userId: string | null) => {
    if (!userId) return "Unassigned";
    const profile = profiles.find((p) => p.id === userId);
    return profile?.full_name || "Unknown";
  };

  const handleUnassignPhone = async (phoneId: string) => {
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
      const { data, error } = await supabase.functions.invoke("admin-assign-phone", {
        body: {
          action: "unassign",
          phoneId,
        },
        headers: {
          "x-admin-token": token,
        },
      });

      if (error || !data?.success) {
        throw new Error(data?.error || error?.message || "Failed to unassign phone number");
      }

      toast({
        title: "Success",
        description: "Phone number unassigned successfully",
      });
      fetchPhoneNumbers();
    } catch (err: any) {
      toast({
        title: "Error",
        description: err?.message || "Failed to unassign phone number",
        variant: "destructive",
      });
    }
  };

  const handleAccountTypeChange = async (userId: string, accountType: 'basic' | 'premium' | 'enterprise') => {
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
      const { data, error } = await supabase.functions.invoke("admin-user", {
        body: {
          action: "update",
          userId,
          updates: { account_type: accountType }
        },
        headers: { "x-admin-token": token },
      });

      if (error || !data?.success) {
        throw new Error(data?.error || error?.message || "Failed to update account type");
      }

      toast({
        title: "Success",
        description: "Account type updated successfully",
      });
      fetchProfiles();
    } catch (err: any) {
      toast({
        title: "Error",
        description: err.message || "Failed to update account type",
        variant: "destructive",
      });
    }
  };

  const handleCompanyNameChange = async (userId: string, companyName: string) => {
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
      const { data, error } = await supabase.functions.invoke("admin-user", {
        body: {
          action: "update",
          userId,
          updates: { company_name: companyName }
        },
        headers: { "x-admin-token": token },
      });

      if (error || !data?.success) {
        throw new Error(data?.error || error?.message || "Failed to update company name");
      }

      toast({
        title: "Success",
        description: "Company name updated successfully",
      });
      fetchProfiles();
    } catch (err: any) {
      toast({
        title: "Error",
        description: err.message || "Failed to update company name",
        variant: "destructive",
      });
    }
  };

  const handleSyncTwilioNumbers = async () => {
    setSyncingTwilio(true);
    try {
      const { data, error } = await supabase.functions.invoke('sync-twilio-numbers');

      if (error) throw error;

      const result = await data;

      if (!result.success) {
        throw new Error(result.error || 'Failed to sync phone numbers');
      }

      toast({
        title: "Success",
        description: result.message,
      });

      fetchPhoneNumbers();
    } catch (error) {
      console.error("Error syncing Twilio numbers:", error);
      toast({
        title: "Error",
        description: error.message || "Failed to sync phone numbers from Twilio",
        variant: "destructive",
      });
    } finally {
      setSyncingTwilio(false);
    }
  };

  const handleSyncTelnyxNumbers = async () => {
    setSyncingTelnyx(true);
    try {
      const { data, error } = await supabase.functions.invoke('sync-telnyx-numbers');

      if (error) throw error;

      const result = await data;

      if (!result.success) {
        throw new Error(result.error || 'Failed to sync Telnyx phone numbers');
      }

      toast({
        title: "Success",
        description: result.message,
      });

      fetchPhoneNumbers();
    } catch (error) {
      console.error("Error syncing Telnyx numbers:", error);
      toast({
        title: "Error",
        description: error.message || "Failed to sync phone numbers from Telnyx",
        variant: "destructive",
      });
    } finally {
      setSyncingTelnyx(false);
    }
  };

  const handleCreateUser = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreatingUser(true);

    const token = localStorage.getItem("admin_session_token");
    if (!token) {
      toast({
        title: "Error",
        description: "Admin session not found",
        variant: "destructive",
      });
      setCreatingUser(false);
      return;
    }

    try {
      const { data, error } = await supabase.functions.invoke("admin-user", {
        body: {
          action: "create",
          email: newUserEmail,
          password: newUserPassword,
          fullName: newUserFullName,
        },
        headers: { "x-admin-token": token },
      });

      if (error || !data?.success) {
        throw new Error(data?.error || error?.message || "Failed to create user");
      }

      toast({
        title: "Success",
        description: `User ${newUserFullName} created successfully`,
      });

      setNewUserFullName("");
      setNewUserEmail("");
      setNewUserPassword("");
      setCreateUserDialogOpen(false);
      fetchProfiles();
    } catch (error: any) {
      toast({
        title: "Error",
        description: error.message || "Failed to create user",
        variant: "destructive",
      });
    } finally {
      setCreatingUser(false);
    }
  };

  const handleDeleteUser = async (userId: string, userName: string) => {
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
      const { data, error } = await supabase.functions.invoke("admin-user", {
        body: { action: "delete", userId },
        headers: { "x-admin-token": token },
      });

      if (error || !data?.success) {
        throw new Error(data?.error || error?.message || "Failed to delete user");
      }

      toast({
        title: "Success",
        description: `User ${userName} deleted successfully`,
      });
      fetchProfiles();
    } catch (err: any) {
      toast({
        title: "Error",
        description: err.message || "Failed to delete user",
        variant: "destructive",
      });
    }
  };

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>Users</CardTitle>
          <Dialog open={createUserDialogOpen} onOpenChange={setCreateUserDialogOpen}>
            <DialogTrigger asChild>
              <Button size="sm">
                <UserPlus className="w-4 h-4 mr-2" />
                Create User
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Create New User</DialogTitle>
                <DialogDescription>
                  Add a new user to the system
                </DialogDescription>
              </DialogHeader>
              <form onSubmit={handleCreateUser} className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="newUserFullName">Full Name</Label>
                  <Input
                    id="newUserFullName"
                    value={newUserFullName}
                    onChange={(e) => setNewUserFullName(e.target.value)}
                    placeholder="Enter full name"
                    required
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="newUserEmail">Email</Label>
                  <Input
                    id="newUserEmail"
                    type="email"
                    value={newUserEmail}
                    onChange={(e) => setNewUserEmail(e.target.value)}
                    placeholder="Enter email address"
                    required
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="newUserPassword">Password</Label>
                  <Input
                    id="newUserPassword"
                    type="password"
                    value={newUserPassword}
                    onChange={(e) => setNewUserPassword(e.target.value)}
                    placeholder="Enter password"
                    minLength={6}
                    required
                  />
                </div>
                <Button type="submit" className="w-full" disabled={creatingUser}>
                  {creatingUser ? "Creating..." : "Create User"}
                </Button>
              </form>
            </DialogContent>
          </Dialog>
        </CardHeader>
        <CardContent>
          {profiles.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              No users yet
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Email</TableHead>
                  <TableHead>Company</TableHead>
                  <TableHead>Account Type</TableHead>
                  <TableHead>Joined</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {profiles.map((profile) => (
                  <TableRow key={profile.id}>
                    <TableCell className="font-medium">{profile.full_name}</TableCell>
                    <TableCell>{profile.email}</TableCell>
                    <TableCell>
                      <Input
                        value={profile.company_name || ""}
                        onChange={(e) => {
                          const updatedProfiles = profiles.map(p =>
                            p.id === profile.id ? { ...p, company_name: e.target.value } : p
                          );
                          setProfiles(updatedProfiles);
                        }}
                        onBlur={(e) => handleCompanyNameChange(profile.id, e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.currentTarget.blur();
                          }
                        }}
                        placeholder="Enter company name"
                        className="w-48"
                      />
                    </TableCell>
                    <TableCell>
                      <Select
                        value={profile.account_type}
                        onValueChange={(value) => handleAccountTypeChange(profile.id, value as 'basic' | 'premium' | 'enterprise')}
                      >
                        <SelectTrigger className="w-32">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="basic">Basic</SelectItem>
                          <SelectItem value="premium">Premium</SelectItem>
                          <SelectItem value="enterprise">Enterprise</SelectItem>
                        </SelectContent>
                      </Select>
                    </TableCell>
                    <TableCell>
                      {new Date(profile.created_at).toLocaleDateString()}
                    </TableCell>
                    <TableCell className="text-right">
                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <Button size="sm" variant="ghost" className="text-destructive hover:text-destructive hover:bg-destructive/10">
                            <Trash2 className="w-4 h-4" />
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>Delete User</AlertDialogTitle>
                            <AlertDialogDescription>
                              Are you sure you want to delete <strong>{profile.full_name}</strong>? This action cannot be undone and will permanently remove the user and all associated data.
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>Cancel</AlertDialogCancel>
                            <AlertDialogAction
                              onClick={() => handleDeleteUser(profile.id, profile.full_name)}
                              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                            >
                              Delete
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>Phone Numbers</CardTitle>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={handleSyncTwilioNumbers}
              disabled={syncingTwilio}
            >
              <RefreshCw className={`w-4 h-4 mr-2 ${syncingTwilio ? 'animate-spin' : ''}`} />
              Sync Twilio
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={handleSyncTelnyxNumbers}
              disabled={syncingTelnyx}
            >
              <RefreshCw className={`w-4 h-4 mr-2 ${syncingTelnyx ? 'animate-spin' : ''}`} />
              Sync Telnyx
            </Button>
            <Dialog open={phoneDialogOpen} onOpenChange={setPhoneDialogOpen}>
              <DialogTrigger asChild>
                <Button size="sm">
                  <PhoneIcon className="w-4 h-4 mr-2" />
                  Add Number
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Add Phone Number</DialogTitle>
                  <DialogDescription>
                    Add a new business phone number to the system
                  </DialogDescription>
                </DialogHeader>
                <form onSubmit={handleAddPhoneNumber} className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="phoneNumber">Phone Number</Label>
                    <Input
                      id="phoneNumber"
                      value={newPhoneNumber}
                      onChange={(e) => setNewPhoneNumber(e.target.value)}
                      placeholder="+1 (555) 123-4567"
                      required
                    />
                  </div>
                  <Button type="submit" className="w-full">Add Phone Number</Button>
                </form>
              </DialogContent>
            </Dialog>

            <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
              <DialogTrigger asChild>
                <Button size="sm" variant="outline">
                  <UserPlus className="w-4 h-4 mr-2" />
                  Assign Number
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Assign Phone Number</DialogTitle>
                  <DialogDescription>
                    Assign a phone number to a user
                  </DialogDescription>
                </DialogHeader>
                <form onSubmit={handleAssignPhone} className="space-y-4">
                  <div className="space-y-2">
                    <Label>Phone Number</Label>
                    <Select value={selectedPhone} onValueChange={setSelectedPhone} required>
                      <SelectTrigger>
                        <SelectValue placeholder="Select phone number" />
                      </SelectTrigger>
                      <SelectContent>
                        {phoneNumbers.map((phone) => {
                          const info = getAssignmentInfo(phone);
                          return (
                            <SelectItem key={phone.id} value={phone.id}>
                              {phone.phone_number} ({info.assignedTo}{info.type === "department" ? " - Dept" : ""})
                            </SelectItem>
                          );
                        })}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label>User</Label>
                    <Select value={selectedUser} onValueChange={setSelectedUser} required>
                      <SelectTrigger>
                        <SelectValue placeholder="Select user" />
                      </SelectTrigger>
                      <SelectContent>
                        {profiles.map((profile) => (
                          <SelectItem key={profile.id} value={profile.id}>
                            {profile.full_name} ({profile.email})
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <Button type="submit" className="w-full" disabled={!selectedPhone || !selectedUser}>
                    Assign
                  </Button>
                </form>
              </DialogContent>
            </Dialog>
          </div>
        </CardHeader>
        <CardContent>
          {phoneNumbers.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              No phone numbers yet. Add one above!
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Phone Number</TableHead>
                  <TableHead>Provider</TableHead>
                  <TableHead>Assigned To</TableHead>
                  <TableHead>Company Name</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {phoneNumbers.map((phone) => {
                  const assignmentInfo = getAssignmentInfo(phone);
                  return (
                    <TableRow key={phone.id}>
                      <TableCell className="font-medium">{phone.phone_number}</TableCell>
                      <TableCell>
                        <span
                          className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${phone.provider === 'telnyx'
                            ? "bg-blue-500/10 text-blue-500"
                            : "bg-red-500/10 text-red-500"
                            }`}
                        >
                          {phone.provider?.charAt(0).toUpperCase() + phone.provider?.slice(1) || 'Twilio'}
                        </span>
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          {assignmentInfo.assignedTo}
                          {assignmentInfo.type === "department" && (
                            <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-blue-500/10 text-blue-500">
                              Dept
                            </span>
                          )}
                        </div>
                      </TableCell>
                      <TableCell>{assignmentInfo.companyName}</TableCell>
                      <TableCell>
                        <span
                          className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${assignmentInfo.isAssigned
                            ? "bg-success/10 text-success"
                            : "bg-muted text-muted-foreground"
                            }`}
                        >
                          {assignmentInfo.isAssigned ? "Assigned" : "Available"}
                        </span>
                      </TableCell>
                      <TableCell className="text-right">
                        {phone.assigned_to && (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => handleUnassignPhone(phone.id)}
                          >
                            <UserMinus className="w-4 h-4 mr-2" />
                            Unassign
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
};

export default UserManagement;
