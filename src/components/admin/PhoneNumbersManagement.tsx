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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Phone as PhoneIcon, RefreshCw, Plus, UserMinus } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import { Badge } from "@/components/ui/badge";

interface Profile {
  id: string;
  full_name: string;
  email: string;
  company_name: string | null;
}

interface Department {
  id: string;
  name: string;
  company_name: string;
  phone_number_id: string | null;
}

interface IvrConfig {
  id: string;
  company_name: string;
  phone_number_id: string | null;
}

interface PhoneNumber {
  id: string;
  phone_number: string;
  assigned_to: string | null;
  provider: string;
  is_active: boolean;
  company_name: string | null;
  created_at: string;
}

const PhoneNumbersManagement = () => {
  const [phoneNumbers, setPhoneNumbers] = useState<PhoneNumber[]>([]);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [ivrConfigs, setIvrConfigs] = useState<IvrConfig[]>([]);
  const [newPhoneNumber, setNewPhoneNumber] = useState("");
  const [selectedUser, setSelectedUser] = useState("");
  const [selectedPhone, setSelectedPhone] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [phoneDialogOpen, setPhoneDialogOpen] = useState(false);
  const [assignDialogOpen, setAssignDialogOpen] = useState(false);
  const [syncingTwilio, setSyncingTwilio] = useState(false);
  const [syncingTelnyx, setSyncingTelnyx] = useState(false);
  const { toast } = useToast();

  useEffect(() => {
    fetchPhoneNumbers();
    fetchProfiles();
    fetchDepartments();
    fetchIvrConfigs();
  }, []);

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
      .select("id, full_name, email, company_name");

    if (error) {
      console.error("Error fetching profiles:", error);
    } else {
      setProfiles(data || []);
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

  const fetchIvrConfigs = async () => {
    const token = localStorage.getItem("admin_session_token");
    if (!token) return;

    try {
      const { data, error } = await supabase.functions.invoke("admin-ivr", {
        body: { action: "list" },
        headers: { "x-admin-token": token },
      });

      if (error || !data?.success) {
        console.error("Error fetching IVR configs:", error || data?.error);
      } else {
        setIvrConfigs(data.configs || []);
      }
    } catch (err) {
      console.error("Error fetching IVR configs:", err);
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

    if (!selectedUser) {
      toast({
        title: "Select a user",
        description: "Please choose a user before assigning this number.",
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
          userId: selectedUser
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
      setAssignDialogOpen(false);
      setSelectedUser("");
      setSelectedPhone("");
      fetchPhoneNumbers();
    } catch (err: any) {
      console.error("Error assigning phone:", err);
      toast({
        title: "Error",
        description: err.message || "Failed to assign phone number",
        variant: "destructive",
      });
    }
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
          phoneId: phoneId 
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
      console.error("Error unassigning phone:", err);
      toast({
        title: "Error",
        description: err.message || "Failed to unassign phone number",
        variant: "destructive",
      });
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

    // Check if assigned to an IVR configuration
    const ivrConfig = ivrConfigs.find((c) => c.phone_number_id === phone.id);
    if (ivrConfig) {
      return {
        assignedTo: ivrConfig.company_name,
        companyName: ivrConfig.company_name || "-",
        isAssigned: true,
        type: "ivr" as const,
      };
    }

    // Not assigned to anyone
    return {
      assignedTo: "Unassigned",
      companyName: phone.company_name || "-",
      isAssigned: false,
      type: null,
    };
  };

  const getUserName = (userId: string | null) => {
    if (!userId) return "Unassigned";
    const profile = profiles.find((p) => p.id === userId);
    return profile?.full_name || "Unknown";
  };

  const handleSyncTwilioNumbers = async () => {
    setSyncingTwilio(true);
    try {
      const { data, error } = await supabase.functions.invoke("sync-twilio-numbers");

      if (error) throw error;

      if (!data.success) {
        throw new Error(data.error || "Failed to sync phone numbers");
      }

      toast({
        title: "Success",
        description: data.message,
      });

      fetchPhoneNumbers();
    } catch (error: any) {
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
      const { data, error } = await supabase.functions.invoke("sync-telnyx-numbers");

      if (error) throw error;

      if (!data.success) {
        throw new Error(data.error || "Failed to sync Telnyx phone numbers");
      }

      toast({
        title: "Success",
        description: data.message,
      });

      fetchPhoneNumbers();
    } catch (error: any) {
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

  const openAssignDialog = (phoneId: string, currentAssignee: string | null) => {
    setSelectedPhone(phoneId);
    setSelectedUser(currentAssignee || "");
    setAssignDialogOpen(true);
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="flex items-center gap-2">
          <PhoneIcon className="w-5 h-5" />
          Phone Numbers
        </CardTitle>
        <div className="flex gap-2">
          <Button 
            size="sm" 
            variant="outline" 
            onClick={handleSyncTwilioNumbers}
            disabled={syncingTwilio}
          >
            <RefreshCw className={`w-4 h-4 mr-2 ${syncingTwilio ? "animate-spin" : ""}`} />
            Sync Twilio
          </Button>
          <Button 
            size="sm" 
            variant="outline" 
            onClick={handleSyncTelnyxNumbers}
            disabled={syncingTelnyx}
          >
            <RefreshCw className={`w-4 h-4 mr-2 ${syncingTelnyx ? "animate-spin" : ""}`} />
            Sync Telnyx
          </Button>
          <Dialog open={phoneDialogOpen} onOpenChange={setPhoneDialogOpen}>
            <DialogTrigger asChild>
              <Button size="sm">
                <Plus className="w-4 h-4 mr-2" />
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
        </div>
      </CardHeader>
      <CardContent>
        {phoneNumbers.length === 0 ? (
          <div className="text-center py-8 text-muted-foreground">
            No phone numbers yet. Add one or sync from your provider.
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
                    <TableCell className="font-mono font-medium">
                      {phone.phone_number}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className="capitalize">
                        {phone.provider || "Manual"}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        {assignmentInfo.assignedTo}
                        {assignmentInfo.type === "department" && (
                          <Badge variant="secondary" className="text-xs">
                            Dept
                          </Badge>
                        )}
                        {assignmentInfo.type === "ivr" && (
                          <Badge variant="secondary" className="text-xs">
                            IVR
                          </Badge>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>{assignmentInfo.companyName}</TableCell>
                    <TableCell>
                      <Badge
                        variant={assignmentInfo.isAssigned ? "default" : "secondary"}
                        className={assignmentInfo.isAssigned ? "bg-success/10 text-success border-success/20" : ""}
                      >
                        {assignmentInfo.isAssigned ? "Assigned" : "Unassigned"}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-2">
                        {!assignmentInfo.type && (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => openAssignDialog(phone.id, phone.assigned_to)}
                          >
                            Assign
                          </Button>
                        )}
                        {phone.assigned_to && (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => handleUnassignPhone(phone.id)}
                          >
                            <UserMinus className="w-4 h-4" />
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}

        {/* Assign Dialog */}
        <Dialog open={assignDialogOpen} onOpenChange={setAssignDialogOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Assign Phone Number</DialogTitle>
              <DialogDescription>
                Select a user to assign this phone number to
              </DialogDescription>
            </DialogHeader>
            <form onSubmit={handleAssignPhone} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="user">User</Label>
                <Select value={selectedUser} onValueChange={setSelectedUser}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select a user" />
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
              <Button type="submit" className="w-full" disabled={!selectedUser}>
                Assign
              </Button>
            </form>
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  );
};

export default PhoneNumbersManagement;