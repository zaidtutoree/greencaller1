import { useState, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
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
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Eye, Download, FileText } from "lucide-react";
import { format } from "date-fns";
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";

interface UserUsage {
  userId: string;
  fullName: string;
  email: string;
  totalMinutes: number;
}

interface CallDetail {
  id: string;
  from_number: string;
  to_number: string;
  direction: string;
  duration: number;
  created_at: string;
}

const UserCallUsage = () => {
  const [userUsages, setUserUsages] = useState<UserUsage[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedUser, setSelectedUser] = useState<UserUsage | null>(null);
  const [callDetails, setCallDetails] = useState<CallDetail[]>([]);
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);

  useEffect(() => {
    console.log("UserCallUsage component mounted");
    fetchUserUsages();
  }, []);

  const fetchUserUsages = async () => {
    setLoading(true);
    
    // Fetch all profiles
    const { data: profiles } = await supabase
      .from("profiles")
      .select("id, full_name, email");

    if (!profiles) {
      setLoading(false);
      return;
    }

    // Fetch all call history
    const { data: calls } = await supabase
      .from("call_history")
      .select("user_id, duration");

    // Calculate total minutes per user
    const usageMap = new Map<string, number>();
    calls?.forEach((call) => {
      if (call.user_id) {
        const currentMinutes = usageMap.get(call.user_id) || 0;
        usageMap.set(call.user_id, currentMinutes + (call.duration || 0));
      }
    });

    const usages: UserUsage[] = profiles.map((profile) => ({
      userId: profile.id,
      fullName: profile.full_name,
      email: profile.email,
      totalMinutes: Math.round((usageMap.get(profile.id) || 0) / 60 * 100) / 100,
    }));

    setUserUsages(usages);
    setLoading(false);
  };

  const handleViewMore = async (user: UserUsage) => {
    setSelectedUser(user);
    setDialogOpen(true);
    setDetailsLoading(true);

    const { data } = await supabase
      .from("call_history")
      .select("*")
      .eq("user_id", user.userId)
      .order("created_at", { ascending: false });

    setCallDetails(data || []);
    setDetailsLoading(false);
  };

  const formatDuration = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}m ${secs}s`;
  };

  const exportToCSV = () => {
    if (!selectedUser || callDetails.length === 0) return;

    const headers = ["Date", "Time", "From", "To", "Direction", "Duration"];
    const rows = callDetails.map((call) => [
      format(new Date(call.created_at), "yyyy-MM-dd"),
      format(new Date(call.created_at), "HH:mm:ss"),
      call.from_number,
      call.to_number,
      call.direction,
      formatDuration(call.duration || 0),
    ]);

    const csvContent = [headers, ...rows]
      .map((row) => row.map((cell) => `"${cell}"`).join(","))
      .join("\n");

    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `call_usage_${selectedUser.fullName.replace(/\s+/g, "_")}.csv`;
    link.click();
  };

  const exportToPDF = () => {
    if (!selectedUser || callDetails.length === 0) return;

    const doc = new jsPDF();
    
    doc.setFontSize(18);
    doc.text(`Call Usage Report - ${selectedUser.fullName}`, 14, 22);
    
    doc.setFontSize(12);
    doc.text(`Email: ${selectedUser.email}`, 14, 32);
    doc.text(`Total Minutes: ${selectedUser.totalMinutes}`, 14, 40);
    doc.text(`Generated: ${format(new Date(), "yyyy-MM-dd HH:mm")}`, 14, 48);

    const tableData = callDetails.map((call) => [
      format(new Date(call.created_at), "yyyy-MM-dd"),
      format(new Date(call.created_at), "HH:mm:ss"),
      call.from_number,
      call.to_number,
      call.direction,
      formatDuration(call.duration || 0),
    ]);

    autoTable(doc, {
      head: [["Date", "Time", "From", "To", "Direction", "Duration"]],
      body: tableData,
      startY: 55,
      styles: { fontSize: 8 },
      headStyles: { fillColor: [34, 197, 94] },
    });

    doc.save(`call_usage_${selectedUser.fullName.replace(/\s+/g, "_")}.pdf`);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>User Call Usage</CardTitle>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="flex items-center justify-center py-8">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>User</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Total Minutes</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {userUsages.map((user) => (
                <TableRow key={user.userId}>
                  <TableCell className="font-medium">{user.fullName}</TableCell>
                  <TableCell>{user.email}</TableCell>
                  <TableCell>{user.totalMinutes} min</TableCell>
                  <TableCell className="text-right">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleViewMore(user)}
                    >
                      <Eye className="w-4 h-4 mr-2" />
                      View More
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
              {userUsages.length === 0 && (
                <TableRow>
                  <TableCell colSpan={4} className="text-center text-muted-foreground">
                    No users found
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        )}

        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogContent className="max-w-4xl max-h-[80vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>
                Call Details - {selectedUser?.fullName}
              </DialogTitle>
            </DialogHeader>

            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div className="text-sm text-muted-foreground">
                  Total: {selectedUser?.totalMinutes} minutes
                </div>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={exportToCSV}
                    disabled={callDetails.length === 0}
                  >
                    <Download className="w-4 h-4 mr-2" />
                    Export CSV
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={exportToPDF}
                    disabled={callDetails.length === 0}
                  >
                    <FileText className="w-4 h-4 mr-2" />
                    Export PDF
                  </Button>
                </div>
              </div>

              {detailsLoading ? (
                <div className="flex items-center justify-center py-8">
                  <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Date</TableHead>
                      <TableHead>Time</TableHead>
                      <TableHead>From</TableHead>
                      <TableHead>To</TableHead>
                      <TableHead>Direction</TableHead>
                      <TableHead>Duration</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {callDetails.map((call) => (
                      <TableRow key={call.id}>
                        <TableCell>
                          {format(new Date(call.created_at), "MMM dd, yyyy")}
                        </TableCell>
                        <TableCell>
                          {format(new Date(call.created_at), "HH:mm:ss")}
                        </TableCell>
                        <TableCell>{call.from_number}</TableCell>
                        <TableCell>{call.to_number}</TableCell>
                        <TableCell className="capitalize">{call.direction}</TableCell>
                        <TableCell>{formatDuration(call.duration || 0)}</TableCell>
                      </TableRow>
                    ))}
                    {callDetails.length === 0 && (
                      <TableRow>
                        <TableCell colSpan={6} className="text-center text-muted-foreground">
                          No call history found
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              )}
            </div>
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  );
};

export default UserCallUsage;
