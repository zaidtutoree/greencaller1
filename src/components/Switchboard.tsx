import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Calendar } from "@/components/ui/calendar";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Building2, Phone, Clock, PhoneIncoming, PhoneOff, CheckCircle2, Download, FileText, FileSpreadsheet, CalendarIcon, Users } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import { Device } from '@twilio/voice-sdk';
import { cn } from "@/lib/utils";
import { format } from "date-fns";
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";

interface Department {
  id: string;
  name: string;
  description: string | null;
  company_name: string;
  phone_number_id: string | null;
}

interface PhoneNumber {
  id: string;
  phone_number: string;
}

interface QueuedCall {
  id: string;
  call_sid: string;
  from_number: string;
  created_at: string;
  status: string;
  department_id: string;
}

interface DepartmentStats {
  avgWaitTime: number;
  departmentNumber: string | null;
  allTimeAnswerRatio: number;
  allTimeTotalCalls: number;
  allTimeAnsweredCalls: number;
}

interface SwitchboardProps {
  userId?: string;
  onPickupCall?: (callInfo: { phoneNumber: string; conferenceName: string; callSid: string; queueId?: string }) => void;
}

export const Switchboard = ({ userId, onPickupCall }: SwitchboardProps) => {
  const [departments, setDepartments] = useState<Department[]>([]);
  const [selectedDept, setSelectedDept] = useState<Department | null>(null);
  const [userCompany, setUserCompany] = useState<string | null>(null);
  const [accountType, setAccountType] = useState<string>("");
  const [phoneNumbers, setPhoneNumbers] = useState<Record<string, PhoneNumber>>({});
  const [deptStats, setDeptStats] = useState<Record<string, DepartmentStats>>({});
  const [queuedCalls, setQueuedCalls] = useState<QueuedCall[]>([]);
  const [twilioDevice, setTwilioDevice] = useState<Device | null>(null);
  const [answerRatioDate, setAnswerRatioDate] = useState<Date | undefined>(undefined);
  const [periodAnswerRatio, setPeriodAnswerRatio] = useState<{ ratio: number; total: number; answered: number }>({ ratio: 0, total: 0, answered: 0 });
  const { toast } = useToast();

  useEffect(() => {
    if (userId) {
      fetchUserProfile();
      initializeTwilio();
    }
  }, [userId]);

  useEffect(() => {
    if (userCompany && accountType === 'enterprise' && userId) {
      fetchDepartments();
    }
  }, [userCompany, accountType, userId]);

  useEffect(() => {
    if (departments.length > 0) {
      fetchPhoneNumbers();
      fetchCallStats();
      
      const interval = setInterval(() => {
        fetchCallStats();
      }, 10000);
      
      return () => clearInterval(interval);
    }
  }, [departments]);

  useEffect(() => {
    if (!userCompany || !selectedDept) return;

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

    fetchQueuedCalls();

    // Poll every 2 seconds as fallback (Realtime can miss events)
    const interval = setInterval(fetchQueuedCalls, 2000);

    return () => {
      clearInterval(interval);
      supabase.removeChannel(channel);
    };
  }, [userCompany, selectedDept]);

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
    if (!userCompany || !userId) return;

    // Only fetch departments the user is explicitly assigned to via department_members
    const { data: membershipData, error: membershipError } = await supabase
      .from("department_members")
      .select("department_id, departments(*)")
      .eq("user_id", userId);

    if (membershipError) {
      console.error("Error fetching user department memberships:", membershipError);
    }

    // Extract departments from memberships - only show departments user is assigned to
    const assignedDepartments = membershipData
      ?.map((m: any) => m.departments)
      .filter(Boolean) || [];

    // Sort by created_at descending
    assignedDepartments.sort((a: any, b: any) =>
      new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    );

    setDepartments(assignedDepartments);
    if (assignedDepartments.length > 0) {
      setSelectedDept(assignedDepartments[0]);
    } else {
      setSelectedDept(null);
    }
  };

  const fetchPhoneNumbers = async () => {
    const numberIds = departments
      .map(d => d.phone_number_id)
      .filter(Boolean) as string[];
    
    if (numberIds.length === 0) return;

    const { data, error } = await supabase
      .from("phone_numbers")
      .select("id, phone_number")
      .in("id", numberIds);

    if (error) {
      console.error("Error fetching phone numbers:", error);
    } else {
      const numbersMap: Record<string, PhoneNumber> = {};
      data?.forEach(num => {
        numbersMap[num.id] = num;
      });
      setPhoneNumbers(numbersMap);
    }
  };

  const fetchQueuedCalls = async () => {
    if (!selectedDept) return;

    try {
      const { data, error } = await supabase
        .from('call_queue')
        .select('*')
        .eq('department_id', selectedDept.id)
        .in('status', ['waiting', 'ringing'])
        .order('created_at', { ascending: true });

      if (error) throw error;

      // Verify each queued call is still alive by checking active calls on the department number
      if ((data || []).length > 0) {
        const callSids = data!.map(q => q.call_sid).filter(Boolean);
        if (callSids.length > 0) {
          supabase.functions.invoke('verify-queue-calls', {
            body: { callSids },
          }).then(({ data: verifyData }) => {
            if (verifyData?.abandoned?.length > 0) {
              console.log('Calls no longer active:', verifyData.abandoned);
              setQueuedCalls(prev => prev.filter(q => !verifyData.abandoned.includes(q.call_sid)));
            }
          }).catch(() => {});
        }
      }

      setQueuedCalls(data || []);
    } catch (error) {
      console.error('Error fetching queued calls:', error);
    }
  };

  const fetchCallStats = async () => {
    const stats: Record<string, DepartmentStats> = {};
    
    for (const dept of departments) {
      const phoneNumber = dept.phone_number_id ? phoneNumbers[dept.phone_number_id] : null;

      // Fetch all-time stats
      const { data: allTimeCalls, error: allTimeError } = await supabase
        .from("call_queue")
        .select("*")
        .eq("department_id", dept.id);

      if (allTimeError) {
        console.error("Error fetching call queue stats:", allTimeError);
        stats[dept.id] = {
          avgWaitTime: 0,
          departmentNumber: phoneNumber?.phone_number || null,
          allTimeAnswerRatio: 0,
          allTimeTotalCalls: 0,
          allTimeAnsweredCalls: 0
        };
        continue;
      }

      const pickedUpCalls = allTimeCalls?.filter(c => c.picked_up_at !== null) || [];
      let avgWaitTime = 0;
      
      if (pickedUpCalls.length > 0) {
        const totalWaitTime = pickedUpCalls.reduce((sum, c) => {
          const waitTime = Math.round(
            (new Date(c.picked_up_at!).getTime() - new Date(c.created_at!).getTime()) / 1000
          );
          return sum + waitTime;
        }, 0);
        avgWaitTime = Math.round(totalWaitTime / pickedUpCalls.length);
      }

      // Calculate all-time stats
      const allTimeTotalCalls = allTimeCalls?.length || 0;
      const allTimeAnsweredCalls = allTimeCalls?.filter(c => c.picked_up_at !== null).length || 0;

      stats[dept.id] = {
        avgWaitTime,
        departmentNumber: phoneNumber?.phone_number || null,
        allTimeAnswerRatio: allTimeTotalCalls > 0 ? Math.round((allTimeAnsweredCalls / allTimeTotalCalls) * 100) : 0,
        allTimeTotalCalls,
        allTimeAnsweredCalls
      };
    }
    
    setDeptStats(stats);
  };

  const fetchPeriodAnswerRatio = async () => {
    if (!selectedDept) return;

    let query = supabase
      .from("call_queue")
      .select("*")
      .eq("department_id", selectedDept.id);
    
    if (answerRatioDate) {
      const startOfDay = new Date(answerRatioDate);
      startOfDay.setHours(0, 0, 0, 0);
      const endOfDay = new Date(answerRatioDate);
      endOfDay.setHours(23, 59, 59, 999);
      query = query.gte("created_at", startOfDay.toISOString()).lte("created_at", endOfDay.toISOString());
    }

    const { data, error } = await query;

    if (error) {
      console.error("Error fetching period answer ratio:", error);
      setPeriodAnswerRatio({ ratio: 0, total: 0, answered: 0 });
      return;
    }

    const total = data?.length || 0;
    const answered = data?.filter(c => c.picked_up_at !== null).length || 0;
    const ratio = total > 0 ? Math.round((answered / total) * 100) : 0;
    
    setPeriodAnswerRatio({ ratio, total, answered });
  };

  useEffect(() => {
    fetchPeriodAnswerRatio();
  }, [selectedDept, answerRatioDate]);

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
  };

  const getExportData = async () => {
    if (!selectedDept) return [];
    
    const { data: calls, error } = await supabase
      .from('call_queue')
      .select('*')
      .eq('department_id', selectedDept.id)
      .order('created_at', { ascending: false });
    
    if (error) {
      console.error('Error fetching calls for export:', error);
      return [];
    }
    
    return (calls || []).map(call => {
      const createdAt = new Date(call.created_at!);
      const pickedUpAt = call.picked_up_at ? new Date(call.picked_up_at) : null;
      const waitTimeSeconds = pickedUpAt 
        ? Math.round((pickedUpAt.getTime() - createdAt.getTime()) / 1000)
        : null;
      
      return {
        fromNumber: call.from_number,
        date: format(createdAt, 'yyyy-MM-dd'),
        timeInQueue: format(createdAt, 'HH:mm:ss'),
        timePickedUp: pickedUpAt ? format(pickedUpAt, 'HH:mm:ss') : 'Not answered',
        waitTime: waitTimeSeconds !== null ? formatTime(waitTimeSeconds) : 'N/A',
        status: call.picked_up_at ? 'Answered' : call.status === 'completed' ? 'Completed' : 'Missed',
      };
    });
  };

  const exportToCSV = async () => {
    const data = await getExportData();
    if (data.length === 0) {
      toast({
        title: 'No Data',
        description: 'No calls to export for this department',
        variant: 'destructive',
      });
      return;
    }
    
    const headers = [
      'Caller Number',
      'Date',
      'Time in Queue',
      'Time Picked Up',
      'Wait Time',
      'Status'
    ];
    
    const csvContent = [
      headers.join(','),
      ...data.map(row => [
        row.fromNumber,
        row.date,
        row.timeInQueue,
        row.timePickedUp,
        row.waitTime,
        row.status
      ].join(','))
    ].join('\n');

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `${selectedDept?.name}-calls-${new Date().toISOString().split('T')[0]}.csv`;
    link.click();
    
    toast({
      title: 'Export Complete',
      description: 'CSV file downloaded successfully',
    });
  };

  const exportToPDF = async () => {
    const data = await getExportData();
    if (data.length === 0) {
      toast({
        title: 'No Data',
        description: 'No calls to export for this department',
        variant: 'destructive',
      });
      return;
    }
    
    const doc = new jsPDF();
    
    // Title
    doc.setFontSize(18);
    doc.text(`${selectedDept?.name} - Call History`, 14, 22);
    
    // Subtitle
    doc.setFontSize(10);
    doc.setTextColor(100);
    doc.text(`Generated on ${new Date().toLocaleDateString()}`, 14, 30);
    doc.text(`Company: ${userCompany || 'N/A'}`, 14, 36);

    // Table
    autoTable(doc, {
      startY: 45,
      head: [[
        'Caller Number',
        'Date',
        'Time in Queue',
        'Time Picked Up',
        'Wait Time',
        'Status'
      ]],
      body: data.map(row => [
        row.fromNumber,
        row.date,
        row.timeInQueue,
        row.timePickedUp,
        row.waitTime,
        row.status
      ]),
      styles: { fontSize: 8 },
      headStyles: { fillColor: [34, 197, 94] },
    });

    doc.save(`${selectedDept?.name}-calls-${new Date().toISOString().split('T')[0]}.pdf`);
    
    toast({
      title: 'Export Complete',
      description: 'PDF file downloaded successfully',
    });
  };

  const handleTakeCall = async (queuedCall: QueuedCall) => {
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

      // Verify caller is still waiting before attempting pickup
      const { data: freshEntry } = await supabase
        .from('call_queue')
        .select('status, updated_at, created_at')
        .eq('id', queuedCall.id)
        .single();

      if (!freshEntry || (freshEntry.status !== 'waiting' && freshEntry.status !== 'ringing')) {
        setQueuedCalls(prev => prev.filter(c => c.id !== queuedCall.id));
        toast({
          title: 'Caller hung up',
          description: 'The caller is no longer waiting',
        });
        return;
      }

      // Also check heartbeat — if hold music hasn't checked in recently, caller is gone
      const lastUpdate = new Date(freshEntry.updated_at || freshEntry.created_at).getTime();
      const heartbeatAge = Date.now() - lastUpdate;
      if (heartbeatAge > 30000) {
        // Mark as abandoned and remove from list
        await supabase
          .from('call_queue')
          .update({ status: 'abandoned' })
          .eq('id', queuedCall.id);
        setQueuedCalls(prev => prev.filter(c => c.id !== queuedCall.id));
        toast({
          title: 'Caller hung up',
          description: 'The caller is no longer waiting',
        });
        return;
      }

      toast({
        title: 'Connecting...',
        description: 'Picking up the call',
      });

      // The conference name follows the pattern: dept-{deptId}-{callSid}
      const conferenceName = `dept-${queuedCall.department_id}-${queuedCall.call_sid}`;

      if (onPickupCall) {
        // Pass queueId so the hook can mark the call as picked up
        onPickupCall({
          phoneNumber: queuedCall.from_number,
          conferenceName: conferenceName,
          callSid: queuedCall.call_sid,
          queueId: queuedCall.id,
        });
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

  const getQueueCount = (deptId: string) => {
    if (!selectedDept || selectedDept.id !== deptId) return 0;
    return queuedCalls.length;
  };

  if (accountType !== 'enterprise') {
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
                Switchboard is only available for enterprise accounts.
              </p>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (departments.length === 0) {
    return (
      <div className="flex items-center justify-center h-full p-6">
        <Card className="w-full max-w-md">
          <CardContent className="pt-6">
            <div className="text-center space-y-4">
              <div className="w-16 h-16 mx-auto rounded-full bg-muted flex items-center justify-center">
                <Building2 className="w-8 h-8 text-muted-foreground" />
              </div>
              <h3 className="text-xl font-display font-semibold">No Departments Assigned</h3>
              <p className="text-muted-foreground">
                You are not assigned to any departments. Contact your administrator to be added to a department.
              </p>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  const currentStats = selectedDept ? deptStats[selectedDept.id] : null;

  return (
    <div className="flex h-full">
      {/* Departments Sidebar */}
      <div className="w-72 border-r border-border bg-card flex flex-col">
        <div className="p-5 border-b border-border">
          <h2 className="font-display text-lg font-semibold">Departments</h2>
          <p className="text-sm text-muted-foreground mt-1">Select to view queue</p>
        </div>

        <ScrollArea className="flex-1">
          <div className="p-3 space-y-1.5">
            {departments.map((dept) => {
              const queueCount = getQueueCount(dept.id);
              const hasNumber = dept.phone_number_id && phoneNumbers[dept.phone_number_id];
              const isActive = selectedDept?.id === dept.id;
              const stats = deptStats[dept.id];
              
              return (
                <button
                  key={dept.id}
                  onClick={() => setSelectedDept(dept)}
                  className={cn(
                    "w-full flex items-center gap-3 px-3 py-3 rounded-xl transition-all duration-200 text-left group",
                    isActive
                      ? "bg-accent shadow-sm"
                      : "hover:bg-muted/50"
                  )}
                >
                  <div className={cn(
                    "flex items-center justify-center w-10 h-10 rounded-lg transition-colors",
                    isActive 
                      ? "bg-primary/15" 
                      : hasNumber ? "bg-muted" : "bg-muted/50"
                  )}>
                    <Users className={cn(
                      "w-5 h-5 transition-colors",
                      isActive ? "text-primary" : hasNumber ? "text-muted-foreground" : "text-muted-foreground/50"
                    )} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className={cn(
                      "font-medium truncate transition-colors",
                      isActive ? "text-foreground" : "text-muted-foreground group-hover:text-foreground"
                    )}>
                      {dept.name}
                    </p>
                    {hasNumber && (
                      <p className="text-xs font-mono text-muted-foreground truncate">
                        {phoneNumbers[dept.phone_number_id!]?.phone_number}
                      </p>
                    )}
                    <div className="flex items-center gap-2 mt-0.5">
                      {hasNumber ? (
                        <span className="text-xs text-success flex items-center gap-1">
                          <span className="w-1.5 h-1.5 rounded-full bg-success animate-pulse" />
                          Active
                        </span>
                      ) : (
                        <span className="text-xs text-muted-foreground">No number assigned</span>
                      )}
                      {stats && stats.allTimeTotalCalls > 0 && (
                        <span className="text-xs text-muted-foreground">
                          • {stats.allTimeAnswerRatio}% answered
                        </span>
                      )}
                    </div>
                  </div>
                  {queueCount > 0 && (
                    <Badge className="bg-warning text-warning-foreground badge-pulse">
                      {queueCount}
                    </Badge>
                  )}
                </button>
              );
            })}
          </div>
        </ScrollArea>
      </div>

      {/* Main Content */}
      <div className="flex-1 flex flex-col bg-background-subtle overflow-hidden">
        {selectedDept ? (
          !selectedDept.phone_number_id ? (
            <div className="flex items-center justify-center h-full p-6">
              <Card className="w-full max-w-md">
                <CardContent className="pt-6">
                  <div className="text-center space-y-4">
                    <div className="w-16 h-16 mx-auto rounded-full bg-warning/10 flex items-center justify-center">
                      <Phone className="w-8 h-8 text-warning" />
                    </div>
                    <h3 className="text-xl font-display font-semibold">No Phone Number</h3>
                    <p className="text-muted-foreground">
                      Assign a phone number in Admin to start receiving calls.
                    </p>
                  </div>
                </CardContent>
              </Card>
            </div>
          ) : (
            <>
              {/* Department Header */}
              <div className="border-b border-border bg-card px-6 py-5">
                <div className="flex items-center justify-between">
                  <div>
                    <h2 className="text-xl font-display font-semibold">{selectedDept.name}</h2>
                    <div className="flex items-center gap-3 mt-1">
                      <Badge className="bg-success/10 text-success border-0 font-medium">
                        <span className="w-1.5 h-1.5 rounded-full bg-success mr-1.5 animate-pulse" />
                        Online
                      </Badge>
                      {currentStats?.departmentNumber && (
                        <span className="text-sm font-mono text-muted-foreground">
                          {currentStats.departmentNumber}
                        </span>
                      )}
                    </div>
                  </div>
                  
                  {/* Export Dropdown */}
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="outline" size="sm" className="gap-2">
                        <Download className="w-4 h-4" />
                        Export
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onClick={exportToCSV} className="gap-2 cursor-pointer">
                        <FileSpreadsheet className="w-4 h-4" />
                        Export as CSV
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={exportToPDF} className="gap-2 cursor-pointer">
                        <FileText className="w-4 h-4" />
                        Export as PDF
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </div>

              <ScrollArea className="flex-1">
                <div className="p-6 space-y-6">
                  {/* Stats Cards */}
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6 stagger-animation">
                    {/* Answer Ratio Card with Date Picker */}
                    <Card className="relative overflow-hidden border-0 shadow-lg bg-gradient-to-br from-card to-card/80">
                      <CardHeader className="pb-3">
                        <CardTitle className="text-sm font-medium text-muted-foreground flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <div className="p-1.5 rounded-md bg-success/10">
                              <CheckCircle2 className="w-4 h-4 text-success" />
                            </div>
                            <span>Answer Ratio</span>
                          </div>
                          <Popover>
                            <PopoverTrigger asChild>
                              <Button variant="outline" size="sm" className="h-7 text-xs gap-1.5 bg-background/50">
                                <CalendarIcon className="w-3 h-3" />
                                {answerRatioDate ? format(answerRatioDate, "MMM d") : "All Time"}
                              </Button>
                            </PopoverTrigger>
                            <PopoverContent className="w-auto p-0" align="end">
                              <div className="p-2 border-b">
                                <Button 
                                  variant="ghost" 
                                  size="sm" 
                                  className="w-full text-xs"
                                  onClick={() => setAnswerRatioDate(undefined)}
                                >
                                  Show All Time
                                </Button>
                              </div>
                              <Calendar
                                mode="single"
                                selected={answerRatioDate}
                                onSelect={setAnswerRatioDate}
                                initialFocus
                                className="pointer-events-auto"
                              />
                            </PopoverContent>
                          </Popover>
                        </CardTitle>
                      </CardHeader>
                      <CardContent>
                        {periodAnswerRatio.total === 0 ? (
                          <div className="flex flex-col items-center justify-center py-8">
                            <div className="w-28 h-28 rounded-full border-[6px] border-muted flex items-center justify-center">
                              <span className="text-3xl font-display font-bold text-muted-foreground">--</span>
                            </div>
                            <p className="text-sm text-muted-foreground mt-4">No calls yet</p>
                          </div>
                        ) : (
                          <div className="flex flex-col items-center justify-center py-4">
                            <div className="relative">
                              <svg className="w-32 h-32 transform -rotate-90">
                                <circle
                                  cx="64"
                                  cy="64"
                                  r="54"
                                  stroke="hsl(var(--muted))"
                                  strokeWidth="10"
                                  fill="none"
                                />
                                <circle
                                  cx="64"
                                  cy="64"
                                  r="54"
                                  stroke="hsl(var(--success))"
                                  strokeWidth="10"
                                  fill="none"
                                  strokeDasharray={`${2 * Math.PI * 54}`}
                                  strokeDashoffset={`${2 * Math.PI * 54 * (1 - periodAnswerRatio.ratio / 100)}`}
                                  className="progress-ring"
                                  strokeLinecap="round"
                                />
                              </svg>
                              <div className="absolute inset-0 flex flex-col items-center justify-center">
                                <span className="text-2xl font-display font-bold">{periodAnswerRatio.ratio}%</span>
                              </div>
                            </div>
                            <p className="text-sm text-muted-foreground mt-4 font-medium">
                              {periodAnswerRatio.answered} of {periodAnswerRatio.total} answered
                            </p>
                          </div>
                        )}
                      </CardContent>
                    </Card>


                    {/* Total Calls Card */}
                    <Card className="relative overflow-hidden border-0 shadow-lg bg-gradient-to-br from-card to-card/80">
                      <CardHeader className="pb-3">
                        <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                          <div className="p-1.5 rounded-md bg-primary/10">
                            <PhoneIncoming className="w-4 h-4 text-primary" />
                          </div>
                          <span>Total Calls</span>
                        </CardTitle>
                      </CardHeader>
                      <CardContent>
                        <div className="flex flex-col items-center justify-center py-4">
                          <div className="w-28 h-28 rounded-full bg-primary/10 flex items-center justify-center ring-4 ring-primary/5">
                            <Phone className="w-12 h-12 text-primary" />
                          </div>
                          <p className="text-4xl font-display font-bold mt-4">
                            {currentStats?.allTimeTotalCalls || 0}
                          </p>
                          <p className="text-sm text-muted-foreground font-medium">all time</p>
                        </div>
                      </CardContent>
                    </Card>
                  </div>

                  {/* Queue Section */}
                  <Card>
                    <CardHeader>
                      <CardTitle className="flex items-center gap-3">
                        <div className="p-2 rounded-lg bg-warning/10">
                          <PhoneIncoming className="w-5 h-5 text-warning" />
                        </div>
                        <span>Live Queue</span>
                        {queuedCalls.length > 0 && (
                          <Badge className="bg-warning text-warning-foreground ml-2 badge-pulse">
                            {queuedCalls.length} waiting
                          </Badge>
                        )}
                      </CardTitle>
                    </CardHeader>
                    <CardContent>
                      {queuedCalls.length === 0 ? (
                        <div className="text-center py-12">
                          <div className="w-16 h-16 mx-auto rounded-full bg-muted flex items-center justify-center mb-4">
                            <PhoneOff className="w-8 h-8 text-muted-foreground" />
                          </div>
                          <p className="font-medium text-muted-foreground">No calls in queue</p>
                          <p className="text-sm text-muted-foreground mt-1">Incoming calls will appear here</p>
                        </div>
                      ) : (
                        <div className="space-y-3">
                          {queuedCalls.map((call, index) => {
                            const waitTime = Math.floor((Date.now() - new Date(call.created_at).getTime()) / 1000);
                            return (
                              <div 
                                key={call.id} 
                                className="queue-item flex items-center justify-between p-4 bg-accent/50 rounded-xl border border-border"
                                style={{ animationDelay: `${index * 100}ms` }}
                              >
                                <div className="flex items-center gap-4">
                                  <div className="w-10 h-10 rounded-full bg-warning/10 flex items-center justify-center">
                                    <PhoneIncoming className="w-5 h-5 text-warning" />
                                  </div>
                                  <div>
                                    <p className="font-medium font-mono">{call.from_number}</p>
                                    <div className="flex items-center gap-2 mt-0.5">
                                      <Clock className="w-3 h-3 text-muted-foreground" />
                                      <span className="text-sm text-muted-foreground">
                                        Waiting {formatTime(waitTime)}
                                      </span>
                                    </div>
                                  </div>
                                </div>
                                <Button 
                                  onClick={() => handleTakeCall(call)} 
                                  variant="success"
                                  className="gap-2"
                                >
                                  <Phone className="w-4 h-4" />
                                  Take Call
                                </Button>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </CardContent>
                  </Card>
                </div>
              </ScrollArea>
            </>
          )
        ) : (
          <div className="flex items-center justify-center h-full">
            <div className="text-center">
              <div className="w-16 h-16 mx-auto rounded-full bg-muted flex items-center justify-center mb-4">
                <Users className="w-8 h-8 text-muted-foreground" />
              </div>
              <p className="text-muted-foreground">Select a department to view details</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
