import { useEffect, useRef, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  PhoneIncoming,
  PhoneOutgoing,
  Sparkles,
  Loader2,
  RefreshCw,
  AlertCircle,
  X,
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { cn } from "@/lib/utils";

export interface CallSummaryTarget {
  /** call_recordings.id for the recording backing this call. */
  recordingId: string;
  phoneNumber?: string;
  direction?: string;
  /** Whether the recording already has a cached ai_summary. */
  hasSummary?: boolean;
}

interface CallSummaryDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  target: CallSummaryTarget | null;
}

/** Render the model's lightweight markdown (**Headers:** and "- " bullets). */
const renderSummary = (text: string, compact = false) =>
  text.split("\n").map((raw, i) => {
    const line = raw.trim();
    if (!line) return <div key={i} className="h-2" />;
    const size = compact ? "text-xs leading-relaxed" : "text-sm";

    // Bold section header like **Overview:** rest...
    const headerMatch = line.match(/^\*\*(.+?)\*\*:?\s*(.*)$/);
    if (headerMatch) {
      return (
        <p key={i} className={size}>
          <span className="font-semibold">{headerMatch[1]}</span>
          {headerMatch[2] ? `: ${headerMatch[2].replace(/\*\*/g, "")}` : ""}
        </p>
      );
    }

    if (line.startsWith("- ") || line.startsWith("* ")) {
      return (
        <div key={i} className={cn("flex gap-2", size)}>
          <span className="text-muted-foreground">•</span>
          <span>{line.slice(2).replace(/\*\*/g, "")}</span>
        </div>
      );
    }

    return (
      <p key={i} className={size}>
        {line.replace(/\*\*/g, "")}
      </p>
    );
  });

/**
 * Fetches (or generates) the AI summary for a recording while `active`.
 * Shared by the dialog and the inline (Sidebar Mode) presentation.
 */
const useCallSummary = (target: CallSummaryTarget | null, active: boolean) => {
  const [summary, setSummary] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestedFor = useRef<string | null>(null);

  const generate = async (recordingId: string, force = false) => {
    setLoading(true);
    setError(null);
    if (force) setSummary("");
    try {
      const { data, error: fnError } = await supabase.functions.invoke("summarize-call", {
        body: { recordingId, force },
      });
      // supabase-js wraps a non-2xx response in a FunctionsHttpError and leaves
      // data null — dig the real reason out of the response body.
      if (fnError) {
        let reason = fnError.message || "Failed to generate summary.";
        const ctx: any = (fnError as any).context;
        if (ctx && typeof ctx.json === "function") {
          try {
            const body = await ctx.json();
            if (body?.error) reason = body.error;
          } catch {
            /* keep the generic message */
          }
        }
        throw new Error(reason);
      }
      if (data?.error) throw new Error(data.error);
      if (!data?.summary) throw new Error("No summary was returned.");
      setSummary(data.summary);
    } catch (e: any) {
      let msg = e?.message || "Failed to generate summary.";
      // Common case: a short or silent call with no speech to transcribe.
      if (/could not transcribe|no utterances|no transcript|transcribe this recording/i.test(msg)) {
        msg = "There's no audible speech in this recording to summarize — the call may have been too short or silent.";
      }
      setError(msg);
    } finally {
      setLoading(false);
    }
  };

  // Generate (or load cached) when shown for a recording.
  useEffect(() => {
    if (!active || !target) return;
    if (requestedFor.current === target.recordingId) return;
    requestedFor.current = target.recordingId;
    setSummary("");
    setError(null);
    generate(target.recordingId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, target?.recordingId]);

  // Reset when hidden so reopening re-checks state cleanly.
  useEffect(() => {
    if (!active) requestedFor.current = null;
  }, [active]);

  return { summary, loading, error, generate };
};

const SummaryBody = ({
  loading,
  error,
  summary,
  compact,
}: {
  loading: boolean;
  error: string | null;
  summary: string;
  compact?: boolean;
}) => (
  <div className={cn("rounded-lg border bg-muted/30", compact ? "p-3 min-h-[120px]" : "p-4 min-h-[180px]")}>
    {loading ? (
      <div
        className={cn(
          "flex flex-col items-center justify-center h-full gap-3 text-muted-foreground",
          compact ? "min-h-[100px]" : "min-h-[150px]",
        )}
      >
        <Loader2 className="w-6 h-6 animate-spin text-primary" />
        <p className={compact ? "text-xs" : "text-sm"}>Analyzing the call and writing a summary…</p>
        <p className="text-xs">This can take a few seconds the first time.</p>
      </div>
    ) : error ? (
      <div
        className={cn(
          "flex flex-col items-center justify-center h-full gap-3 text-center",
          compact ? "min-h-[100px]" : "min-h-[150px]",
        )}
      >
        <AlertCircle className="w-6 h-6 text-destructive" />
        <p className={cn("text-muted-foreground max-w-sm", compact ? "text-xs" : "text-sm")}>{error}</p>
      </div>
    ) : summary ? (
      <div className="space-y-1.5">{renderSummary(summary, compact)}</div>
    ) : null}
  </div>
);

const DirectionBadge = ({ direction, compact }: { direction?: string; compact?: boolean }) =>
  direction ? (
    <Badge variant="outline" className={cn("gap-1 font-normal shrink-0", compact && "text-[10px]")}>
      {direction === "outbound" ? (
        <PhoneOutgoing className="w-3 h-3 text-success" />
      ) : (
        <PhoneIncoming className="w-3 h-3 text-primary" />
      )}
      {direction === "outbound" ? "Outbound" : "Inbound"}
    </Badge>
  ) : null;

export const CallSummaryDialog = ({ open, onOpenChange, target }: CallSummaryDialogProps) => {
  const { summary, loading, error, generate } = useCallSummary(target, open);
  const title = target?.phoneNumber || "Call summary";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-primary" />
            AI Call Summary
          </DialogTitle>
        </DialogHeader>

        <div className="flex items-center gap-2 text-sm">
          <DirectionBadge direction={target?.direction} />
          <span className="font-medium truncate">{title}</span>
        </div>

        <SummaryBody loading={loading} error={error} summary={summary} />

        <DialogFooter className="gap-2 sm:gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          <Button
            variant="outline"
            onClick={() => target && generate(target.recordingId, true)}
            disabled={loading || !target}
            className="gap-1.5"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
            Regenerate
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

interface CallSummaryInlineProps {
  target: CallSummaryTarget;
  onClose: () => void;
  className?: string;
}

/**
 * The same summary, rendered in place instead of as a modal. Sidebar Mode uses
 * this: a centred Dialog is wider than the docked panel and its overlay hides
 * the strip, so the close control ends up off-screen.
 */
export const CallSummaryInline = ({ target, onClose, className }: CallSummaryInlineProps) => {
  const { summary, loading, error, generate } = useCallSummary(target, true);
  const title = target.phoneNumber || "Call summary";

  return (
    <div className={cn("flex h-full flex-col bg-background", className)}>
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <Sparkles className="h-4 w-4 shrink-0 text-primary" />
        <span className="text-xs font-semibold">AI Summary</span>
        <div className="ml-auto flex items-center gap-0.5">
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            title="Regenerate"
            disabled={loading}
            onClick={() => generate(target.recordingId, true)}
          >
            <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
          </Button>
          <Button variant="ghost" size="icon" className="h-7 w-7" title="Close" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3 space-y-2">
        <div className="flex items-center gap-2 min-w-0">
          <DirectionBadge direction={target.direction} compact />
          <span className="truncate text-xs font-medium">{title}</span>
        </div>
        <SummaryBody loading={loading} error={error} summary={summary} compact />
      </div>
    </div>
  );
};
