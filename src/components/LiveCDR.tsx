import { useState, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { format } from "date-fns";
import {
  FileText,
  Phone,
  PhoneIncoming,
  PhoneOutgoing,
  PhoneMissed,
  Search,
  Download,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";

interface CDREntry {
  id: string;
  from_number: string;
  to_number: string;
  direction: string;
  duration: number | null;
  status: string | null;
  created_at: string | null;
  user_id: string | null;
  user_email?: string;
  user_name?: string;
}

const LiveCDR = () => {
  const { toast } = useToast();
  const [cdrEntries, setCdrEntries] = useState<CDREntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const [directionFilter, setDirectionFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [userFilter, setUserFilter] = useState<string>("all");
  const [deleting, setDeleting] = useState(false);

  const fetchCDR = async () => {
    setLoading(true);
    
    // Fetch all call history with user info
    const { data: calls, error } = await supabase
      .from("call_history")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(500);

    if (error) {
      console.error("Error fetching CDR:", error);
      setLoading(false);
      return;
    }

    // Fetch user profiles for mapping
    const { data: profiles } = await supabase
      .from("profiles")
      .select("id, email, full_name");

    const profileMap = new Map(
      profiles?.map((p) => [p.id, { email: p.email, name: p.full_name }]) || []
    );

    const enrichedCalls: CDREntry[] = (calls || []).map((call) => ({
      ...call,
      user_email: call.user_id ? profileMap.get(call.user_id)?.email : undefined,
      user_name: call.user_id ? profileMap.get(call.user_id)?.name : undefined,
    }));

    setCdrEntries(enrichedCalls);
    setLoading(false);
  };

  useEffect(() => {
    fetchCDR();

    // Subscribe to realtime updates
    const channel = supabase
      .channel("cdr-realtime")
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "call_history",
        },
        () => {
          fetchCDR();
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  const formatDuration = (seconds: number | null) => {
    if (!seconds) return "0:00";
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, "0")}`;
  };

  const getStatusBadge = (status: string | null, direction: string) => {
    const isMissed = ["no-answer", "busy", "failed", "missed"].includes(status || "");
    
    if (isMissed && direction === "inbound") {
      return <Badge variant="destructive">Missed</Badge>;
    }
    
    switch (status) {
      case "completed":
        return <Badge className="bg-green-500/10 text-green-500 border-green-500/20">Completed</Badge>;
      case "answered":
        return <Badge className="bg-blue-500/10 text-blue-500 border-blue-500/20">Answered</Badge>;
      case "ringing":
        return <Badge className="bg-yellow-500/10 text-yellow-500 border-yellow-500/20">Ringing</Badge>;
      case "initiated":
        return <Badge variant="secondary">Initiated</Badge>;
      default:
        return <Badge variant="outline">{status || "Unknown"}</Badge>;
    }
  };

  const getDirectionIcon = (direction: string, status: string | null) => {
    const isMissed = ["no-answer", "busy", "failed", "missed"].includes(status || "");
    
    if (isMissed && direction === "inbound") {
      return <PhoneMissed className="h-4 w-4 text-destructive" />;
    }
    
    return direction === "inbound" ? (
      <PhoneIncoming className="h-4 w-4 text-green-500" />
    ) : (
      <PhoneOutgoing className="h-4 w-4 text-blue-500" />
    );
  };

  const filteredEntries = cdrEntries.filter((entry) => {
    const matchesSearch =
      entry.from_number.includes(searchTerm) ||
      entry.to_number.includes(searchTerm) ||
      entry.user_email?.toLowerCase().includes(searchTerm.toLowerCase()) ||
      entry.user_name?.toLowerCase().includes(searchTerm.toLowerCase());

    const matchesDirection =
      directionFilter === "all" || entry.direction === directionFilter;

    const matchesStatus =
      statusFilter === "all" ||
      (statusFilter === "missed" &&
        ["no-answer", "busy", "failed", "missed"].includes(entry.status || "")) ||
      (statusFilter === "completed" && entry.status === "completed") ||
      (statusFilter === "active" &&
        ["initiated", "ringing", "answered"].includes(entry.status || ""));

    const matchesUser = userFilter === "all" || entry.user_id === userFilter;

    return matchesSearch && matchesDirection && matchesStatus && matchesUser;
  });

  const recentEntries = filteredEntries.slice(0, 5);

  const exportToCSV = () => {
    const headers = ["Date", "Time", "User", "From", "To", "Direction", "Duration", "Status"];
    const rows = filteredEntries.map((entry) => [
      entry.created_at ? format(new Date(entry.created_at), "yyyy-MM-dd") : "",
      entry.created_at ? format(new Date(entry.created_at), "HH:mm:ss") : "",
      entry.user_name || entry.user_email || "Unknown",
      entry.from_number,
      entry.to_number,
      entry.direction,
      formatDuration(entry.duration),
      entry.status || "Unknown",
    ]);

    const csvContent = [headers, ...rows].map((row) => row.join(",")).join("\n");
    const blob = new Blob([csvContent], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `cdr-export-${format(new Date(), "yyyy-MM-dd-HHmmss")}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const exportToPDF = () => {
    const doc = new jsPDF();
    doc.setFontSize(16);
    doc.text("Call Detail Records (CDR)", 14, 20);
    doc.setFontSize(10);
    doc.text(`Generated: ${format(new Date(), "PPpp")}`, 14, 28);

    autoTable(doc, {
      startY: 35,
      head: [["Date/Time", "User", "From", "To", "Dir", "Duration", "Status"]],
      body: filteredEntries.map((entry) => [
        entry.created_at ? format(new Date(entry.created_at), "MM/dd HH:mm") : "",
        entry.user_name || entry.user_email?.split("@")[0] || "Unknown",
        entry.from_number,
        entry.to_number,
        entry.direction === "inbound" ? "IN" : "OUT",
        formatDuration(entry.duration),
        entry.status || "Unknown",
      ]),
      styles: { fontSize: 8 },
      headStyles: { fillColor: [34, 197, 94] },
    });

    doc.save(`cdr-export-${format(new Date(), "yyyy-MM-dd-HHmmss")}.pdf`);
  };

  // Get unique users from CDR entries for the user filter
  const uniqueUsers = Array.from(
    new Map(
      cdrEntries
        .filter(e => e.user_id)
        .map(e => [e.user_id!, { id: e.user_id!, name: e.user_name || e.user_email || "Unknown" }])
    ).values()
  ).sort((a, b) => a.name.localeCompare(b.name));

  const handleDeleteUserCDRs = async () => {
    if (userFilter === "all") return;

    const userName = uniqueUsers.find(u => u.id === userFilter)?.name || "this user";
    const count = cdrEntries.filter(e => e.user_id === userFilter).length;

    if (!confirm(`Are you sure you want to delete all ${count} CDR records for ${userName}? This cannot be undone.`)) return;

    setDeleting(true);
    try {
      const { data, error } = await supabase.functions.invoke("update-call-status", {
        body: { action: "delete-user-cdrs", userId: userFilter },
      });

      if (error) throw error;

      toast({
        title: "Success",
        description: `Deleted ${count} CDR records for ${userName}`,
      });
      fetchCDR();
      setUserFilter("all");
    } catch (err: any) {
      toast({
        title: "Error",
        description: err?.message || "Failed to delete CDRs",
        variant: "destructive",
      });
    } finally {
      setDeleting(false);
    }
  };

  return (
    <>
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <div className="flex items-center gap-2">
            <FileText className="h-5 w-5 text-primary" />
            <CardTitle>Live CDR</CardTitle>
            <Badge variant="outline" className="ml-2">
              {cdrEntries.length} records
            </Badge>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="icon" onClick={fetchCDR} disabled={loading}>
              <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
            </Button>
            <Button variant="outline" onClick={() => setModalOpen(true)}>
              <Phone className="h-4 w-4 mr-2" />
              View Full CDR
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <RefreshCw className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : recentEntries.length === 0 ? (
            <p className="text-muted-foreground text-center py-8">No call records found</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Time</TableHead>
                  <TableHead>User</TableHead>
                  <TableHead>From</TableHead>
                  <TableHead>To</TableHead>
                  <TableHead>Duration</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {recentEntries.map((entry) => (
                  <TableRow key={entry.id}>
                    <TableCell className="text-sm text-muted-foreground">
                      {entry.created_at
                        ? format(new Date(entry.created_at), "MMM d, HH:mm")
                        : "-"}
                    </TableCell>
                    <TableCell className="font-medium">
                      {entry.user_name || entry.user_email?.split("@")[0] || "Unknown"}
                    </TableCell>
                    <TableCell className="flex items-center gap-2">
                      {getDirectionIcon(entry.direction, entry.status)}
                      {entry.from_number}
                    </TableCell>
                    <TableCell>{entry.to_number}</TableCell>
                    <TableCell>{formatDuration(entry.duration)}</TableCell>
                    <TableCell>{getStatusBadge(entry.status, entry.direction)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Dialog open={modalOpen} onOpenChange={setModalOpen}>
        <DialogContent className="max-w-5xl max-h-[85vh]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <FileText className="h-5 w-5" />
              Call Detail Records (CDR)
            </DialogTitle>
          </DialogHeader>

          <div className="flex flex-col gap-4">
            {/* Filters */}
            <div className="flex flex-wrap gap-3">
              <div className="relative flex-1 min-w-[200px]">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Search by number, user..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="pl-9"
                />
              </div>
              <Select value={directionFilter} onValueChange={setDirectionFilter}>
                <SelectTrigger className="w-[130px]">
                  <SelectValue placeholder="Direction" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Directions</SelectItem>
                  <SelectItem value="inbound">Inbound</SelectItem>
                  <SelectItem value="outbound">Outbound</SelectItem>
                </SelectContent>
              </Select>
              <Select value={statusFilter} onValueChange={setStatusFilter}>
                <SelectTrigger className="w-[130px]">
                  <SelectValue placeholder="Status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Status</SelectItem>
                  <SelectItem value="completed">Completed</SelectItem>
                  <SelectItem value="missed">Missed</SelectItem>
                  <SelectItem value="active">Active</SelectItem>
                </SelectContent>
              </Select>
              <Select value={userFilter} onValueChange={setUserFilter}>
                <SelectTrigger className="w-[180px]">
                  <SelectValue placeholder="Filter by user" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Users</SelectItem>
                  {uniqueUsers.map((user) => (
                    <SelectItem key={user.id} value={user.id}>
                      {user.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {userFilter !== "all" && (
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={handleDeleteUserCDRs}
                  disabled={deleting}
                >
                  <Trash2 className="h-4 w-4 mr-2" />
                  {deleting ? "Deleting..." : "Delete CDRs"}
                </Button>
              )}
              <Button variant="outline" size="icon" onClick={exportToCSV}>
                <Download className="h-4 w-4" />
              </Button>
              <Button variant="outline" onClick={exportToPDF}>
                <FileText className="h-4 w-4 mr-2" />
                PDF
              </Button>
            </div>

            <div className="text-sm text-muted-foreground">
              Showing {filteredEntries.length} of {cdrEntries.length} records
            </div>

            {/* Table */}
            <ScrollArea className="h-[500px] rounded-md border">
              <Table>
                <TableHeader className="sticky top-0 bg-background">
                  <TableRow>
                    <TableHead>Date/Time</TableHead>
                    <TableHead>User</TableHead>
                    <TableHead>From</TableHead>
                    <TableHead>To</TableHead>
                    <TableHead>Direction</TableHead>
                    <TableHead>Duration</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredEntries.map((entry) => (
                    <TableRow key={entry.id}>
                      <TableCell className="text-sm">
                        {entry.created_at
                          ? format(new Date(entry.created_at), "MMM d, yyyy HH:mm:ss")
                          : "-"}
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-col">
                          <span className="font-medium">
                            {entry.user_name || "Unknown"}
                          </span>
                          {entry.user_email && (
                            <span className="text-xs text-muted-foreground">
                              {entry.user_email}
                            </span>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="font-mono text-sm">
                        {entry.from_number}
                      </TableCell>
                      <TableCell className="font-mono text-sm">
                        {entry.to_number}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          {getDirectionIcon(entry.direction, entry.status)}
                          <span className="capitalize">{entry.direction}</span>
                        </div>
                      </TableCell>
                      <TableCell>{formatDuration(entry.duration)}</TableCell>
                      <TableCell>
                        {getStatusBadge(entry.status, entry.direction)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </ScrollArea>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
};

export default LiveCDR;
