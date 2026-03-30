import { useState } from "react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  Mic,
  MicOff,
  Pause,
  Play,
  ArrowRightLeft,
  Circle,
  PhoneOff,
  Minimize2,
  Phone,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { TransferCallDialog } from "./TransferCallDialog";
import { InCallKeypad } from "./InCallKeypad";
import { SheetHeader, SheetTitle } from "@/components/ui/sheet";

interface ActiveCallPanelProps {
  callerName?: string;
  callerCompany?: string;
  callerNumber: string;
  callerAvatar?: string;
  duration: number;
  isMuted: boolean;
  isOnHold: boolean;
  isRecording: boolean;
  isPaused: boolean;
  onMuteToggle: () => void;
  onHoldToggle: () => void;
  onRecordToggle: () => void;
  onEndCall: () => void;
  onTransfer: (targetId: string, targetType: "user" | "department") => void;
  onMinimize: () => void;
  onSendDtmf: (digit: string) => void;
  userId?: string;
  accountType?: string;
}

export const ActiveCallPanel = ({
  callerName,
  callerCompany,
  callerNumber,
  callerAvatar,
  duration,
  isMuted,
  isOnHold,
  isRecording,
  isPaused,
  onMuteToggle,
  onHoldToggle,
  onRecordToggle,
  onEndCall,
  onTransfer,
  onMinimize,
  onSendDtmf,
  userId,
  accountType,
}: ActiveCallPanelProps) => {
  const [transferDialogOpen, setTransferDialogOpen] = useState(false);

  const formatDuration = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, "0")}`;
  };

  const getInitials = (name?: string) => {
    if (!name) return "";
    return name
      .split(" ")
      .map((n) => n[0])
      .join("")
      .toUpperCase()
      .slice(0, 2);
  };

  return (
    <>
      <div className="h-full flex flex-col overflow-hidden">
        {/* Header - Fixed */}
        <SheetHeader className="px-4 py-3 border-b border-border flex-row items-center justify-between flex-shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-full bg-success/20 flex items-center justify-center">
              <Phone className="w-4 h-4 text-success" />
            </div>
            <SheetTitle className="font-display text-base">Active Call</SheetTitle>
          </div>
          <Button
            variant="ghost"
            size="icon"
            onClick={onMinimize}
            className="h-8 w-8"
          >
            <Minimize2 className="w-4 h-4" />
          </Button>
        </SheetHeader>

        {/* Scrollable Caller Info */}
        <div className="flex-1 overflow-y-auto min-h-0">
          <div className="flex flex-col items-center px-4 py-4">
            {/* Call Status */}
            <div className="flex items-center gap-2 mb-3">
              <span className="relative flex h-2.5 w-2.5">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-success opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-success"></span>
              </span>
              <span className="text-sm font-medium text-success">
                {isOnHold ? "On Hold" : "Connected"}
              </span>
            </div>

            {/* Avatar */}
            <div className="relative mb-3">
              <Avatar className="w-16 h-16 border-3 border-success/20 shadow-lg">
                <AvatarImage src={callerAvatar} />
                <AvatarFallback className="bg-muted text-foreground text-lg font-semibold">
                  {getInitials(callerName)}
                </AvatarFallback>
              </Avatar>
              <span className="absolute bottom-0.5 right-0.5 w-3.5 h-3.5 bg-success rounded-full border-2 border-background animate-pulse" />
            </div>

            {/* Caller Details */}
            <h2 className="text-base font-semibold text-foreground mb-0.5">
              {callerName || "Unknown Caller"}
            </h2>
            {callerCompany && (
              <p className="text-xs text-muted-foreground mb-1">{callerCompany}</p>
            )}
            <p className="text-xs font-mono text-muted-foreground mb-2">
              {callerNumber}
            </p>

            {/* Duration */}
            <div className="px-3 py-1.5 rounded-full bg-muted/50">
              <span className="text-lg font-mono font-semibold text-foreground tabular-nums">
                {formatDuration(duration)}
              </span>
            </div>

            {/* Recording Indicator */}
            {isRecording && !isPaused && (
              <div className="flex items-center gap-2 text-destructive mt-2">
                <Circle className="w-2.5 h-2.5 fill-current animate-pulse" />
                <span className="text-xs font-medium">Recording</span>
              </div>
            )}
          </div>
        </div>

        {/* Action Buttons - Fixed at bottom */}
        <div className="px-3 py-3 space-y-2 border-t border-border bg-background flex-shrink-0">
          {/* Primary Actions - Compact grid */}
          <div className="grid grid-cols-5 gap-1">
            {/* Mute */}
            <button
              onClick={onMuteToggle}
              className={cn(
                "flex flex-col items-center gap-1 p-2 rounded-lg transition-all duration-200",
                isMuted
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted hover:bg-muted/80"
              )}
            >
              <div
                className={cn(
                  "w-9 h-9 rounded-full flex items-center justify-center transition-all",
                  isMuted ? "bg-primary-foreground/20" : "bg-background"
                )}
              >
                {isMuted ? <MicOff className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
              </div>
              <span className="text-[10px] font-medium">
                {isMuted ? "Unmute" : "Mute"}
              </span>
            </button>

            {/* Hold */}
            <button
              onClick={onHoldToggle}
              className={cn(
                "flex flex-col items-center gap-1 p-2 rounded-lg transition-all duration-200",
                isOnHold
                  ? "bg-warning text-warning-foreground"
                  : "bg-muted hover:bg-muted/80"
              )}
            >
              <div
                className={cn(
                  "w-9 h-9 rounded-full flex items-center justify-center transition-all",
                  isOnHold ? "bg-warning-foreground/20" : "bg-background"
                )}
              >
                {isOnHold ? <Play className="w-4 h-4" /> : <Pause className="w-4 h-4" />}
              </div>
              <span className="text-[10px] font-medium">
                {isOnHold ? "Resume" : "Hold"}
              </span>
            </button>

            {/* Transfer - Only for enterprise accounts */}
            {accountType === "enterprise" && (
              <button
                onClick={() => setTransferDialogOpen(true)}
                className="flex flex-col items-center gap-1 p-2 rounded-lg transition-all duration-200 bg-muted hover:bg-muted/80"
              >
                <div className="w-9 h-9 rounded-full flex items-center justify-center bg-background">
                  <ArrowRightLeft className="w-4 h-4" />
                </div>
                <span className="text-[10px] font-medium">Transfer</span>
              </button>
            )}

            {/* Keypad */}
            <InCallKeypad onSendDtmf={onSendDtmf} variant="panel" />

            {/* Record - premium and enterprise only */}
            {(accountType === "premium" || accountType === "enterprise") && (
              <button
                onClick={onRecordToggle}
                className={cn(
                  "flex flex-col items-center gap-1 p-2 rounded-lg transition-all duration-200",
                  isRecording && !isPaused
                    ? "bg-destructive text-destructive-foreground"
                    : "bg-muted hover:bg-muted/80"
                )}
              >
                <div
                  className={cn(
                    "w-9 h-9 rounded-full flex items-center justify-center transition-all",
                    isRecording && !isPaused
                      ? "bg-destructive-foreground/20"
                      : "bg-background"
                  )}
                >
                  <Circle
                    className={cn(
                      "w-4 h-4",
                      isRecording && !isPaused && "fill-current"
                    )}
                  />
                </div>
                <span className="text-[10px] font-medium">
                  {isRecording ? (isPaused ? "Resume" : "Pause") : "Record"}
                </span>
              </button>
            )}
          </div>

          {/* End Call Button */}
          <Button
            onClick={onEndCall}
            variant="destructive"
            className="w-full h-11 text-base font-medium"
          >
            <PhoneOff className="w-4 h-4 mr-2" />
            End Call
          </Button>
        </div>
      </div>

      <TransferCallDialog
        open={transferDialogOpen}
        onOpenChange={setTransferDialogOpen}
        onTransfer={onTransfer}
        userId={userId}
      />
    </>
  );
};
