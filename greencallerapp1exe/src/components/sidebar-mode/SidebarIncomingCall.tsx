import { Phone, PhoneOff, Voicemail } from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { useContactName } from "@/utils/contactLookup";

interface SidebarIncomingCallProps {
  callerNumber: string;
  callerName?: string;
  /** The GreenCaller line the call is arriving on. */
  lineNumber?: string | null;
  onAccept: () => void;
  onDecline: () => void;
  onSendToVoicemail: () => void;
}

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

/**
 * Incoming-call view inside the docked panel.
 *
 * No ringtone is played here: the full app window stays mounted (just hidden)
 * and its IncomingCallModal keeps driving the user's chosen ringtone and the
 * native notification, so audio behaviour is unchanged.
 */
export const SidebarIncomingCall = ({
  callerNumber,
  callerName,
  lineNumber,
  onAccept,
  onDecline,
  onSendToVoicemail,
}: SidebarIncomingCallProps) => {
  const displayName = useContactName(callerNumber, callerName);

  return (
    <div className="h-full flex flex-col items-center justify-center px-5 py-6 text-center">
      <div className="flex items-center gap-2 mb-5">
        <span className="relative flex h-2.5 w-2.5">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-75" />
          <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-success" />
        </span>
        <span className="text-sm font-medium text-success">Incoming call…</span>
      </div>

      <Avatar className="w-20 h-20 mb-4 border-2 border-success/25 shadow-lg">
        <AvatarFallback className="bg-muted text-foreground text-xl font-semibold">
          {getInitials(displayName, callerNumber)}
        </AvatarFallback>
      </Avatar>

      {displayName && (
        <h3 className="text-lg font-semibold text-foreground mb-0.5 max-w-full truncate">
          {displayName}
        </h3>
      )}
      <p
        className={
          displayName
            ? "text-sm font-mono text-muted-foreground"
            : "text-xl font-mono font-semibold text-foreground"
        }
      >
        {callerNumber || "Unknown"}
      </p>

      {lineNumber && (
        <p className="mt-3 text-xs text-muted-foreground">
          to your line <span className="font-mono text-foreground">{lineNumber}</span>
        </p>
      )}

      <div className="mt-auto w-full pt-6 space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <Button
            onClick={onDecline}
            className="h-14 flex-col gap-1 bg-destructive hover:bg-destructive/90 text-destructive-foreground shadow-md"
          >
            <PhoneOff className="w-5 h-5" />
            <span className="text-xs font-medium">Decline</span>
          </Button>
          <Button
            onClick={onAccept}
            className="h-14 flex-col gap-1 bg-success hover:bg-success/90 text-success-foreground shadow-md animate-pulse-soft"
          >
            <Phone className="w-5 h-5" />
            <span className="text-xs font-medium">Accept</span>
          </Button>
        </div>

        <button
          type="button"
          onClick={onSendToVoicemail}
          className="flex w-full items-center justify-center gap-2 rounded-lg py-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <Voicemail className="w-3.5 h-3.5" />
          Send to voicemail
        </button>
      </div>
    </div>
  );
};
