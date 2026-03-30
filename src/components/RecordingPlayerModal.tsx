import { useEffect, useRef, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Play, Pause, RotateCcw, Volume2, VolumeX } from "lucide-react";
import { Slider } from "@/components/ui/slider";
import { supabase } from "@/integrations/supabase/client";

interface Recording {
  id: string;
  recording_sid: string;
  recording_url: string;
  duration: number;
  from_number: string;
  to_number: string;
  direction: string;
  created_at: string;
}

interface RecordingPlayerModalProps {
  recording: Recording | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const RecordingPlayerModal = ({
  recording,
  open,
  onOpenChange,
}: RecordingPlayerModalProps) => {
  const audioRef = useRef<HTMLAudioElement>(null);
  const blobUrlRef = useRef<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [isMuted, setIsMuted] = useState(false);
  const [audioError, setAudioError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  // Fetch audio via proxy with auth headers, create blob URL
  useEffect(() => {
    if (!open || !recording?.recording_url) return;

    let cancelled = false;
    setIsLoading(true);
    setAudioError(null);

    const fetchAudio = async () => {
      try {
        const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
        const supabaseKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

        if (!supabaseUrl || !supabaseKey) {
          if (audioRef.current) {
            audioRef.current.src = recording.recording_url;
          }
          setIsLoading(false);
          return;
        }

        // Get the user's session token for auth
        const { data: { session } } = await supabase.auth.getSession();
        const accessToken = session?.access_token || supabaseKey;

        // Pass recording_sid so the proxy can get a fresh download URL from Telnyx API
        const params = new URLSearchParams();
        if (recording.recording_sid) params.set("sid", recording.recording_sid);
        params.set("url", recording.recording_url);
        const proxyUrl = `${supabaseUrl}/functions/v1/proxy-recording?${params.toString()}`;

        const response = await fetch(proxyUrl, {
          headers: {
            "apikey": supabaseKey,
            "Authorization": `Bearer ${accessToken}`,
          },
        });

        if (cancelled) return;

        if (!response.ok) {
          const text = await response.text();
          console.error("Proxy response error:", response.status, text);
          // Log the recording URL for debugging
          console.error("Recording URL was:", recording.recording_url);
          setAudioError(`Failed to load recording (${response.status})`);
          setIsLoading(false);
          return;
        }

        const blob = await response.blob();
        if (cancelled) return;

        // Clean up previous blob URL
        if (blobUrlRef.current) {
          URL.revokeObjectURL(blobUrlRef.current);
        }

        const blobUrl = URL.createObjectURL(blob);
        blobUrlRef.current = blobUrl;

        if (audioRef.current) {
          audioRef.current.src = blobUrl;
        }
        setIsLoading(false);
      } catch (e: any) {
        if (cancelled) return;
        console.error("Error fetching recording:", e);
        setAudioError("Failed to load recording: " + (e.message || "Unknown error"));
        setIsLoading(false);
      }
    };

    fetchAudio();

    return () => {
      cancelled = true;
    };
  }, [open, recording?.recording_url]);

  // Cleanup on close
  useEffect(() => {
    if (!open) {
      setIsPlaying(false);
      setCurrentTime(0);
      setAudioError(null);
      setIsLoading(false);
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current.removeAttribute("src");
        audioRef.current.load();
      }
      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current);
        blobUrlRef.current = null;
      }
    }
  }, [open]);

  const handleTimeUpdate = () => {
    if (audioRef.current) {
      setCurrentTime(audioRef.current.currentTime);
    }
  };

  const handleLoadedMetadata = () => {
    if (audioRef.current) {
      setDuration(audioRef.current.duration);
      setAudioError(null);
    }
  };

  const handleAudioError = () => {
    // Only show error if we're not in the middle of loading via fetch
    if (isLoading) return;
    setIsPlaying(false);
    const err = audioRef.current?.error;
    if (err) {
      console.error("Audio playback error:", err.code, err.message);
      setAudioError("Failed to play recording.");
    }
  };

  const handleEnded = () => {
    setIsPlaying(false);
    setCurrentTime(0);
  };

  const togglePlayPause = () => {
    if (audioRef.current) {
      if (isPlaying) {
        audioRef.current.pause();
        setIsPlaying(false);
      } else {
        audioRef.current.play().then(() => {
          setIsPlaying(true);
        }).catch((e) => {
          console.error("Play failed:", e);
          setAudioError("Failed to play recording.");
        });
      }
    }
  };

  const handleRestart = () => {
    if (audioRef.current) {
      audioRef.current.currentTime = 0;
      audioRef.current.play().then(() => {
        setIsPlaying(true);
      }).catch(() => {});
    }
  };

  const handleSeek = (value: number[]) => {
    if (audioRef.current) {
      audioRef.current.currentTime = value[0];
      setCurrentTime(value[0]);
    }
  };

  const handleVolumeChange = (value: number[]) => {
    if (audioRef.current) {
      const newVolume = value[0];
      audioRef.current.volume = newVolume;
      setVolume(newVolume);
      setIsMuted(newVolume === 0);
    }
  };

  const toggleMute = () => {
    if (audioRef.current) {
      if (isMuted) {
        audioRef.current.volume = volume || 1;
        setIsMuted(false);
      } else {
        audioRef.current.volume = 0;
        setIsMuted(true);
      }
    }
  };

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, "0")}`;
  };

  const progress = duration > 0 ? (currentTime / duration) * 100 : 0;

  if (!recording) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex flex-col gap-1">
            <span>{recording.direction === "outbound" ? "Outgoing" : "Incoming"} Call Recording</span>
            <span className="text-sm font-normal text-muted-foreground">
              {recording.from_number} → {recording.to_number}
            </span>
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-6 py-4">
          {/* Hidden audio element - src set dynamically via blob URL */}
          <audio
            ref={audioRef}
            preload="metadata"
            onTimeUpdate={handleTimeUpdate}
            onLoadedMetadata={handleLoadedMetadata}
            onEnded={handleEnded}
            onError={handleAudioError}
          />

          {/* Error message */}
          {audioError && (
            <div className="text-sm text-destructive bg-destructive/10 rounded-md p-3">
              {audioError}
            </div>
          )}

          {/* Loading indicator */}
          {isLoading && (
            <div className="text-sm text-muted-foreground text-center">
              Loading recording...
            </div>
          )}

          {/* Progress bar */}
          <div className="space-y-2">
            <Progress value={progress} className="h-2" />
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>{formatTime(currentTime)}</span>
              <span>{formatTime(duration)}</span>
            </div>
          </div>

          {/* Seek slider */}
          <Slider
            value={[currentTime]}
            max={duration || 100}
            step={0.1}
            onValueChange={handleSeek}
            className="cursor-pointer"
          />

          {/* Playback controls */}
          <div className="flex items-center justify-center gap-4">
            <Button variant="outline" size="icon" onClick={handleRestart}>
              <RotateCcw className="h-4 w-4" />
            </Button>
            <Button size="lg" className="h-14 w-14 rounded-full" onClick={togglePlayPause} disabled={isLoading}>
              {isPlaying ? (
                <Pause className="h-6 w-6" />
              ) : (
                <Play className="h-6 w-6 ml-1" />
              )}
            </Button>
            <Button variant="outline" size="icon" onClick={toggleMute}>
              {isMuted ? (
                <VolumeX className="h-4 w-4" />
              ) : (
                <Volume2 className="h-4 w-4" />
              )}
            </Button>
          </div>

          {/* Volume slider */}
          <div className="flex items-center gap-3">
            <Volume2 className="h-4 w-4 text-muted-foreground" />
            <Slider
              value={[isMuted ? 0 : volume]}
              max={1}
              step={0.01}
              onValueChange={handleVolumeChange}
              className="flex-1"
            />
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};

export default RecordingPlayerModal;
