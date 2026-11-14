import { useEffect, useState, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card } from "./ui/card";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import { Play, Pause, Trash2, Phone, Clock } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { format } from "date-fns";

interface Voicemail {
  id: string;
  from_number: string;
  to_number: string;
  recording_url: string;
  recording_sid: string;
  duration: number;
  status: string;
  transcription: string | null;
  created_at: string;
}

interface VoicemailListProps {
  userId?: string;
}

export const VoicemailList = ({ userId }: VoicemailListProps) => {
  const [voicemails, setVoicemails] = useState<Voicemail[]>([]);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const { toast } = useToast();

  useEffect(() => {
    if (userId) {
      fetchVoicemails();
      
      // Subscribe to new voicemails
      const channel = supabase
        .channel('voicemails')
        .on(
          'postgres_changes',
          {
            event: 'INSERT',
            schema: 'public',
            table: 'voicemails',
            filter: `user_id=eq.${userId}`,
          },
          () => {
            fetchVoicemails();
          }
        )
        .subscribe();

      return () => {
        supabase.removeChannel(channel);
      };
    }
  }, [userId]);

  const fetchVoicemails = async () => {
    const { data, error } = await supabase
      .from("voicemails")
      .select("*")
      .eq("user_id", userId)
      .order("created_at", { ascending: false });

    if (error) {
      console.error("Error fetching voicemails:", error);
      return;
    }

    setVoicemails(data || []);
  };

  const formatDuration = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, "0")}`;
  };

  const handlePlay = async (voicemail: Voicemail) => {
    if (playingId === voicemail.id) {
      audioRef.current?.pause();
      setPlayingId(null);
      return;
    }

    if (audioRef.current) {
      audioRef.current.pause();
    }

    try {
      const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
      const supabaseKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

      let audioUrl = voicemail.recording_url;

      // Fetch via proxy with auth headers, then create blob URL
      if (supabaseUrl && supabaseKey) {
        const { data: { session } } = await supabase.auth.getSession();
        const accessToken = session?.access_token || supabaseKey;

        const params = new URLSearchParams();
        if (voicemail.recording_sid) params.set("sid", voicemail.recording_sid);
        params.set("url", voicemail.recording_url);
        const proxyUrl = `${supabaseUrl}/functions/v1/proxy-recording?${params.toString()}`;
        const response = await fetch(proxyUrl, {
          headers: {
            "apikey": supabaseKey,
            "Authorization": `Bearer ${accessToken}`,
          },
        });
        if (!response.ok) {
          throw new Error(`Failed to load voicemail (${response.status})`);
        }
        const blob = await response.blob();
        audioUrl = URL.createObjectURL(blob);
      }

      const audio = new Audio(audioUrl);
      audioRef.current = audio;

      audio.onended = () => {
        setPlayingId(null);
        if (audioUrl.startsWith("blob:")) URL.revokeObjectURL(audioUrl);
      };

      await audio.play();
      setPlayingId(voicemail.id);

      // Mark as listened
      if (voicemail.status === 'new') {
        await supabase
          .from('voicemails')
          .update({ status: 'listened' })
          .eq('id', voicemail.id);
        
        fetchVoicemails();
      }
    } catch (error) {
      console.error('Error playing voicemail:', error);
      toast({
        title: "Error",
        description: "Failed to play voicemail",
        variant: "destructive",
      });
    }
  };

  const handleDelete = async (id: string) => {
    const { error } = await supabase
      .from("voicemails")
      .delete()
      .eq("id", id);

    if (error) {
      toast({
        title: "Error",
        description: "Failed to delete voicemail",
        variant: "destructive",
      });
      return;
    }

    toast({
      title: "Success",
      description: "Voicemail deleted",
    });

    fetchVoicemails();
  };

  return (
    <Card className="p-6">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-semibold">Voicemails</h3>
        {voicemails.filter(v => v.status === 'new').length > 0 && (
          <Badge variant="destructive">
            {voicemails.filter(v => v.status === 'new').length} new
          </Badge>
        )}
      </div>

      {voicemails.length === 0 ? (
        <p className="text-muted-foreground text-center py-8">No voicemails</p>
      ) : (
        <div className="space-y-3">
          {voicemails.map((voicemail) => (
            <div
              key={voicemail.id}
              className="flex items-center justify-between p-4 border rounded-lg hover:bg-accent/50 transition-colors"
            >
              <div className="flex items-center gap-4 flex-1">
                <Button
                  variant="outline"
                  size="icon"
                  onClick={() => handlePlay(voicemail)}
                >
                  {playingId === voicemail.id ? (
                    <Pause className="h-4 w-4" />
                  ) : (
                    <Play className="h-4 w-4" />
                  )}
                </Button>

                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <Phone className="h-4 w-4 text-muted-foreground" />
                    <span className="font-medium">{voicemail.from_number}</span>
                    {voicemail.status === 'new' && (
                      <Badge variant="secondary">New</Badge>
                    )}
                  </div>
                  
                  {voicemail.transcription && (
                    <p className="text-sm text-muted-foreground truncate">
                      {voicemail.transcription}
                    </p>
                  )}
                  
                  <div className="flex items-center gap-3 mt-2 text-xs text-muted-foreground">
                    <span className="flex items-center gap-1">
                      <Clock className="h-3 w-3" />
                      {formatDuration(voicemail.duration)}
                    </span>
                    <span>{format(new Date(voicemail.created_at), "MMM d, h:mm a")}</span>
                  </div>
                </div>
              </div>

              <Button
                variant="ghost"
                size="icon"
                onClick={() => handleDelete(voicemail.id)}
              >
                <Trash2 className="h-4 w-4 text-destructive" />
              </Button>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
};
