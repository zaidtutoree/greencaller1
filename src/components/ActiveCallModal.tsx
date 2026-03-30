import { useState, useRef, useEffect } from "react";
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
  Maximize2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { TransferCallDialog } from "./TransferCallDialog";
import { InCallKeypad } from "./InCallKeypad";

interface ActiveCallModalProps {
  isVisible: boolean;
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
  onExpand?: () => void;
  onSendDtmf: (digit: string) => void;
  userId?: string;
  accountType?: string;
}

export const ActiveCallModal = ({
  isVisible,
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
  onExpand,
  onSendDtmf,
  userId,
  accountType,
}: ActiveCallModalProps) => {
  const [position, setPosition] = useState({ x: 20, y: 20 });
  const [isDragging, setIsDragging] = useState(false);
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
  const [transferDialogOpen, setTransferDialogOpen] = useState(false);
  const modalRef = useRef<HTMLDivElement>(null);

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

  const handleMouseDown = (e: React.MouseEvent) => {
    if (modalRef.current) {
      const rect = modalRef.current.getBoundingClientRect();
      setDragOffset({
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
      });
      setIsDragging(true);
    }
  };

  const handleMouseMove = (e: MouseEvent) => {
    if (isDragging) {
      const newX = e.clientX - dragOffset.x;
      const newY = e.clientY - dragOffset.y;

      // Keep within viewport bounds
      const maxX = window.innerWidth - (modalRef.current?.offsetWidth || 320);
      const maxY = window.innerHeight - (modalRef.current?.offsetHeight || 200);

      setPosition({
        x: Math.max(0, Math.min(newX, maxX)),
        y: Math.max(0, Math.min(newY, maxY)),
      });
    }
  };

  const handleMouseUp = () => {
    setIsDragging(false);
  };

  useEffect(() => {
    if (isDragging) {
      window.addEventListener("mousemove", handleMouseMove);
      window.addEventListener("mouseup", handleMouseUp);
      return () => {
        window.removeEventListener("mousemove", handleMouseMove);
        window.removeEventListener("mouseup", handleMouseUp);
      };
    }
  }, [isDragging, dragOffset]);

  if (!isVisible) return null;

  return (
    <>
      <div
        ref={modalRef}
        className={cn(
          "fixed z-50 w-[380px] rounded-3xl overflow-hidden shadow-2xl border border-white/20",
          "backdrop-blur-xl",
          isDragging ? "scale-[1.02] shadow-[0_25px_50px_-12px_rgba(0,0,0,0.5)]" : ""
        )}
        style={{
          left: position.x,
          top: position.y,
          background: "linear-gradient(145deg, rgba(22, 101, 52, 0.95), rgba(20, 83, 45, 0.98))",
          transition: isDragging ? "none" : "transform 0.2s ease-out, box-shadow 0.2s ease-out",
        }}
      >
        {/* Header with Drag Handle and Expand */}
        <div
          className="flex items-center justify-between px-4 py-3 cursor-grab active:cursor-grabbing"
          onMouseDown={handleMouseDown}
        >
          <div className="w-10 h-1 rounded-full bg-white/30" />
          {onExpand && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onExpand();
              }}
              className="w-7 h-7 rounded-full bg-white/15 hover:bg-white/25 flex items-center justify-center transition-colors"
            >
              <Maximize2 className="w-3.5 h-3.5 text-white" />
            </button>
          )}
        </div>

        {/* Caller Info */}
        <div className="px-5 pb-5">
          <div className="flex items-center gap-4">
            <div className="relative">
              <Avatar className="w-14 h-14 border-2 border-white/30 shadow-lg">
                <AvatarImage src={callerAvatar} />
                <AvatarFallback className="bg-white/20 text-white text-base font-semibold backdrop-blur-sm">
                  {getInitials(callerName)}
                </AvatarFallback>
              </Avatar>
              <span className="absolute -bottom-0.5 -right-0.5 w-3.5 h-3.5 bg-green-400 rounded-full border-2 border-green-900 animate-pulse" />
            </div>
            <div className="flex-1 min-w-0">
              <h3 className="text-white font-semibold text-base truncate">
                {callerName || "Unknown Caller"}
              </h3>
              <p className="text-white/70 text-sm flex items-center gap-2 mt-0.5">
                <span className="font-mono text-xs">{callerNumber}</span>
                <span className="text-white/40">•</span>
                <span className="font-medium tabular-nums">{formatDuration(duration)}</span>
              </p>
            </div>
          </div>
        </div>

        {/* Action Buttons */}
        <div className="bg-black/15 backdrop-blur-sm px-3 py-4 border-t border-white/10">
          <div className="flex items-center justify-between gap-1">
            {/* Mute */}
            <button
              onClick={onMuteToggle}
              className={cn(
                "flex flex-col items-center gap-1.5 p-1.5 rounded-xl transition-all duration-200",
                isMuted ? "bg-white/20 scale-95" : "hover:bg-white/10 active:scale-95"
              )}
            >
              <div className={cn(
                "w-9 h-9 rounded-full flex items-center justify-center transition-all duration-200",
                isMuted ? "bg-white text-green-700 shadow-lg" : "bg-white/15 text-white"
              )}>
                {isMuted ? <MicOff className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
              </div>
              <span className="text-white/80 text-[10px] font-medium">Mute</span>
            </button>

            {/* Hold */}
            <button
              onClick={onHoldToggle}
              className={cn(
                "flex flex-col items-center gap-1.5 p-1.5 rounded-xl transition-all duration-200",
                isOnHold ? "bg-white/20 scale-95" : "hover:bg-white/10 active:scale-95"
              )}
            >
              <div className={cn(
                "w-9 h-9 rounded-full flex items-center justify-center transition-all duration-200",
                isOnHold ? "bg-white text-green-700 shadow-lg" : "bg-white/15 text-white"
              )}>
                {isOnHold ? <Play className="w-4 h-4" /> : <Pause className="w-4 h-4" />}
              </div>
              <span className="text-white/80 text-[10px] font-medium">Hold</span>
            </button>

            {/* Transfer - Only for enterprise accounts */}
            {accountType === "enterprise" && (
              <button
                onClick={() => setTransferDialogOpen(true)}
                className="flex flex-col items-center gap-1.5 p-1.5 rounded-xl transition-all duration-200 hover:bg-white/10 active:scale-95"
              >
                <div className="w-9 h-9 rounded-full flex items-center justify-center bg-white/15 text-white">
                  <ArrowRightLeft className="w-4 h-4" />
                </div>
                <span className="text-white/80 text-[10px] font-medium">Transfer</span>
              </button>
            )}

            {/* Record - premium and enterprise only */}
            {(accountType === "premium" || accountType === "enterprise") && (
              <button
                onClick={onRecordToggle}
                className={cn(
                  "flex flex-col items-center gap-1.5 p-1.5 rounded-xl transition-all duration-200",
                  isRecording && !isPaused ? "bg-white/20 scale-95" : "hover:bg-white/10 active:scale-95"
                )}
              >
                <div className={cn(
                  "w-9 h-9 rounded-full flex items-center justify-center relative transition-all duration-200",
                  isRecording && !isPaused ? "bg-red-500 text-white shadow-lg shadow-red-500/30" : "bg-white/15 text-white"
                )}>
                  <Circle className={cn("w-4 h-4", isRecording && !isPaused && "fill-current")} />
                </div>
                <span className="text-white/80 text-[10px] font-medium">Record</span>
              </button>
            )}

            {/* Keypad */}
            <InCallKeypad onSendDtmf={onSendDtmf} variant="modal" />

            {/* End Call */}
            <button
              onClick={onEndCall}
              className="flex flex-col items-center gap-1.5 p-1.5 rounded-xl transition-all duration-200 hover:bg-red-500/20 active:scale-95"
            >
              <div className="w-9 h-9 rounded-full flex items-center justify-center bg-red-500 text-white shadow-lg shadow-red-500/30">
                <PhoneOff className="w-4 h-4" />
              </div>
              <span className="text-white/80 text-[10px] font-medium">End</span>
            </button>
          </div>
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
