import { useState, useEffect, useRef } from "react";
import { Phone, PhoneOff, X, Voicemail } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";

interface IncomingCallModalProps {
  isVisible: boolean;
  isDismissed: boolean;
  callerNumber: string;
  callerName?: string;
  onPickup: () => void;
  onDecline: () => void;
  onDismiss: () => void;
  onRestore: () => void;
  onSendToVoicemail: () => void;
}

export const IncomingCallModal = ({
  isVisible,
  isDismissed,
  callerNumber,
  callerName,
  onPickup,
  onDecline,
  onDismiss,
  onRestore,
  onSendToVoicemail,
}: IncomingCallModalProps) => {
  const [isMuted, setIsMuted] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const notificationRef = useRef<Notification | null>(null);

  // Initialize and play ringtone - works even in background tabs
  useEffect(() => {
    if (isVisible || isDismissed) {
      const audio = new Audio("/ringtone.wav");
      audio.loop = true;
      audioRef.current = audio;

      if (!isMuted && isVisible) {
        // Play ringtone - works in background tabs after user has interacted with the page
        audio.play().catch(console.error);
      }

      // Show browser notification so user is alerted even in another tab
      if ("Notification" in window && Notification.permission === "granted" && isVisible) {
        const title = callerName || callerNumber || "Unknown Caller";
        notificationRef.current = new Notification("Incoming Call", {
          body: `${title} is calling...`,
          icon: "/brand-logo.png",
          requireInteraction: true,
          tag: "incoming-call",
        });
        notificationRef.current.onclick = () => {
          window.focus();
          notificationRef.current?.close();
        };
      }

      return () => {
        audio.pause();
        audio.currentTime = 0;
        audioRef.current = null;
        notificationRef.current?.close();
        notificationRef.current = null;
      };
    }
  }, [isVisible, isDismissed]);

  // Handle mute toggle
  useEffect(() => {
    if (audioRef.current) {
      if (isMuted || isDismissed) {
        audioRef.current.pause();
      } else if (isVisible) {
        audioRef.current.play().catch(console.error);
      }
    }
  }, [isMuted, isVisible, isDismissed]);

  const getInitials = (name?: string, number?: string) => {
    if (name) {
      return name
        .split(" ")
        .map((n) => n[0])
        .join("")
        .toUpperCase()
        .slice(0, 2);
    }
    return number?.slice(-2) || "??";
  };

  const handlePickup = () => {
    if (audioRef.current) {
      audioRef.current.pause();
    }
    onPickup();
  };

  const handleDecline = () => {
    if (audioRef.current) {
      audioRef.current.pause();
    }
    onDecline();
  };

  const handleDismiss = () => {
    setIsMuted(true);
    if (audioRef.current) {
      audioRef.current.pause();
    }
    onDismiss();
  };

  const handleSendToVoicemail = () => {
    if (audioRef.current) {
      audioRef.current.pause();
    }
    onSendToVoicemail();
  };

  // Show floating restore button when call is dismissed but still active
  if (isDismissed && !isVisible) {
    return (
      <div className="fixed bottom-6 right-6 z-50 animate-fade-in">
        <Button
          onClick={onRestore}
          size="lg"
          className="w-16 h-16 rounded-full bg-green-600 hover:bg-green-700 text-white shadow-xl animate-pulse flex items-center justify-center"
        >
          <Phone className="w-7 h-7" />
        </Button>
        <p className="text-xs text-center mt-2 text-muted-foreground max-w-[80px]">
          Incoming call
        </p>
      </div>
    );
  }

  if (!isVisible) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm animate-fade-in">
      <div className="bg-card border border-border rounded-2xl shadow-2xl p-8 max-w-sm w-full mx-4 animate-scale-in">

        {/* Caller Info */}
        <div className="text-center mb-8">
          <p className="text-sm text-muted-foreground uppercase tracking-wider mb-2">
            Incoming Call
          </p>
          {callerName && (
            <h2 className="text-2xl font-bold text-foreground mb-1">{callerName}</h2>
          )}
          <p className={cn(
            "text-lg",
            callerName ? "text-muted-foreground" : "text-foreground font-semibold text-2xl"
          )}>
            {callerNumber}
          </p>
        </div>

        {/* Action Buttons */}
        <div className="flex items-center justify-center gap-3 mb-4">
          {/* Decline */}
          <div className="flex flex-col items-center gap-1">
            <Button
              onClick={handleDecline}
              size="lg"
              className="w-14 h-14 rounded-full bg-destructive hover:bg-destructive/90 text-destructive-foreground shadow-lg"
            >
              <PhoneOff className="w-6 h-6" />
            </Button>
            <span className="text-xs text-muted-foreground">Decline</span>
          </div>

          {/* Voicemail */}
          <div className="flex flex-col items-center gap-1">
            <Button
              onClick={handleSendToVoicemail}
              size="lg"
              variant="outline"
              className="w-14 h-14 rounded-full border-2 border-orange-500/50 hover:bg-orange-500/10 hover:border-orange-500"
            >
              <Voicemail className="w-6 h-6 text-orange-500" />
            </Button>
            <span className="text-xs text-muted-foreground">Voicemail</span>
          </div>

          {/* Dismiss */}
          <div className="flex flex-col items-center gap-1">
            <Button
              onClick={handleDismiss}
              size="lg"
              variant="outline"
              className="w-14 h-14 rounded-full"
            >
              <X className="w-6 h-6" />
            </Button>
            <span className="text-xs text-muted-foreground">Minimize</span>
          </div>

          {/* Answer */}
          <div className="flex flex-col items-center gap-1">
            <Button
              onClick={handlePickup}
              size="lg"
              className="w-14 h-14 rounded-full bg-green-600 hover:bg-green-700 text-white shadow-lg animate-pulse"
            >
              <Phone className="w-6 h-6" />
            </Button>
            <span className="text-xs text-muted-foreground">Answer</span>
          </div>
        </div>
      </div>
    </div>
  );
};
