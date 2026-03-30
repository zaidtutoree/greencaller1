import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { Trash2, Download, FileText, Play } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { formatDistanceToNow } from "date-fns";
import RecordingPlayerModal from "./RecordingPlayerModal";

interface Recording {
  id: string;
  call_sid: string;
  recording_sid: string;
  recording_url: string;
  duration: number;
  from_number: string;
  to_number: string;
  direction: string;
  created_at: string;
  transcription: string | null;
}

interface CallRecordingsProps {
  userId?: string;
}

const CallRecordings = ({ userId }: CallRecordingsProps) => {
  const [recordings, setRecordings] = useState<Recording[]>([]);
  const [loading, setLoading] = useState(true);
  const [transcribing, setTranscribing] = useState<string | null>(null);
  const [selectedRecording, setSelectedRecording] = useState<Recording | null>(null);
  const [playerOpen, setPlayerOpen] = useState(false);
  const { toast } = useToast();

  useEffect(() => {
    fetchRecordings();

    const channel = supabase
      .channel("call_recordings_changes")
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "call_recordings",
        },
        () => {
          fetchRecordings();
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [userId]);

  const fetchRecordings = async () => {
    if (!userId) return;
    try {
      const { data, error } = await supabase
        .from("call_recordings")
        .select("*")
        .eq("user_id", userId)
        .order("created_at", { ascending: false });

      if (error) throw error;
      setRecordings(data || []);
    } catch (error) {
      console.error("Error fetching recordings:", error);
      toast({
        title: "Error",
        description: "Failed to load recordings",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      const { error } = await supabase.from("call_recordings").delete().eq("id", id);

      if (error) throw error;

      toast({
        title: "Success",
        description: "Recording deleted successfully",
      });
    } catch (error) {
      console.error("Error deleting recording:", error);
      toast({
        title: "Error",
        description: "Failed to delete recording",
        variant: "destructive",
      });
    }
  };

  const handleTranscribe = async (id: string) => {
    setTranscribing(id);
    try {
      const { error } = await supabase.functions.invoke('transcribe-recording', {
        body: { recordingId: id }
      });

      if (error) throw error;

      toast({
        title: "Success",
        description: "Recording transcribed successfully",
      });
      
      // Refresh recordings to show new transcription
      fetchRecordings();
    } catch (error) {
      console.error("Error transcribing recording:", error);
      toast({
        title: "Error",
        description: "Failed to transcribe recording",
        variant: "destructive",
      });
    } finally {
      setTranscribing(null);
    }
  };

  const formatDuration = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, "0")}`;
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-lg text-muted-foreground">Loading recordings...</div>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Call Recordings</h1>
        <p className="text-muted-foreground">Manage your recorded calls</p>
      </div>

      {recordings.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12">
            <p className="text-muted-foreground">No recordings yet</p>
            <p className="text-sm text-muted-foreground mt-2">
              Enable recording when making or receiving calls
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {recordings.map((recording) => (
            <Card key={recording.id}>
              <CardHeader>
                <CardTitle className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">
                      {recording.direction === "outbound" ? "Outgoing" : "Incoming"}
                    </span>
                    <span className="text-sm text-muted-foreground">
                      {recording.from_number} → {recording.to_number}
                    </span>
                  </div>
                  <span className="text-xs text-muted-foreground">
                    {formatDistanceToNow(new Date(recording.created_at), { addSuffix: true })}
                  </span>
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-4">
                      <Button
                        variant="default"
                        size="icon"
                        className="h-12 w-12 rounded-full"
                        onClick={() => {
                          setSelectedRecording(recording);
                          setPlayerOpen(true);
                        }}
                      >
                        <Play className="h-5 w-5 ml-0.5" />
                      </Button>
                      <p className="text-sm text-muted-foreground">
                        Duration: {formatDuration(recording.duration || 0)}
                      </p>
                    </div>
                    <div className="flex gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleTranscribe(recording.id)}
                        disabled={transcribing === recording.id}
                      >
                        <FileText className="h-4 w-4 mr-2" />
                        {transcribing === recording.id ? "Transcribing..." : recording.transcription ? "Re-transcribe" : "Transcribe"}
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={async () => {
                          try {
                            const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
                            const supabaseKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
                            if (!supabaseUrl || !supabaseKey) {
                              window.open(recording.recording_url, "_blank");
                              return;
                            }
                            const { data: { session } } = await supabase.auth.getSession();
                            const accessToken = session?.access_token || supabaseKey;
                            const params = new URLSearchParams();
                            if (recording.recording_sid) params.set("sid", recording.recording_sid);
                            params.set("url", recording.recording_url);
                            const proxyUrl = `${supabaseUrl}/functions/v1/proxy-recording?${params.toString()}`;
                            const response = await fetch(proxyUrl, {
                              headers: { "apikey": supabaseKey, "Authorization": `Bearer ${accessToken}` },
                            });
                            if (!response.ok) throw new Error(`Download failed (${response.status})`);
                            const blob = await response.blob();
                            const url = URL.createObjectURL(blob);
                            const a = document.createElement("a");
                            a.href = url;
                            a.download = `recording-${recording.recording_sid || recording.id}.mp3`;
                            a.click();
                            URL.revokeObjectURL(url);
                          } catch (e: any) {
                            toast({ title: "Error", description: e.message || "Download failed", variant: "destructive" });
                          }
                        }}
                      >
                        <Download className="h-4 w-4 mr-2" />
                        Download
                      </Button>
                      <Button
                        variant="destructive"
                        size="sm"
                        onClick={() => handleDelete(recording.id)}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                  
                  {recording.transcription && (
                    <div className="border-t pt-4">
                      <p className="text-sm font-medium mb-2">Transcription:</p>
                      <div className="space-y-2 max-h-64 overflow-y-auto">
                        {recording.transcription.split('\n').map((line, index) => {
                          const isCaller = line.startsWith('[CALLER]:');
                          const isRecipient = line.startsWith('[RECIPIENT]:');
                          
                          if (!isCaller && !isRecipient) {
                          return (
                              <p key={index} className="text-sm text-muted-foreground">
                                {line}
                              </p>
                            );
                          }

                          // For outbound: CALLER = from_number (business), RECIPIENT = to_number (customer)
                          // For inbound: CALLER = from_number (customer), RECIPIENT = to_number (business)
                          const isOutbound = recording.direction === 'outbound';
                          const businessNumber = isOutbound ? recording.from_number : recording.to_number;
                          const customerNumber = isOutbound ? recording.to_number : recording.from_number;
                          
                          // CALLER in transcription = person who initiated the call
                          // For outbound: business is caller, For inbound: customer is caller
                          const speakerLabel = isCaller ? 'Business' : 'Customer';
                          const phoneNumber = isCaller 
                            ? (isOutbound ? businessNumber : customerNumber)
                            : (isOutbound ? customerNumber : businessNumber);
                          const text = line.replace(/^\[(CALLER|RECIPIENT)\]:/, '').trim();
                          
                          // Business messages on right (primary), Customer messages on left (muted)
                          const isBusinessSpeaking = (isCaller && isOutbound) || (isRecipient && !isOutbound);

                          return (
                            <div key={index} className={`flex ${isBusinessSpeaking ? 'justify-end' : 'justify-start'}`}>
                              <div className={`max-w-[80%] rounded-lg p-3 ${
                                isBusinessSpeaking 
                                  ? 'bg-primary text-primary-foreground' 
                                  : 'bg-muted text-foreground'
                              }`}>
                                <p className="text-xs font-semibold mb-1">
                                  {speakerLabel} ({phoneNumber})
                                </p>
                                <p className="text-sm">{text}</p>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <RecordingPlayerModal
        recording={selectedRecording}
        open={playerOpen}
        onOpenChange={setPlayerOpen}
      />
    </div>
  );
};

export default CallRecordings;
