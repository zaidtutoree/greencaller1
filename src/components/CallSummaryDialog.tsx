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
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";

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
const renderSummary = (text: string) =>
  text.split("\n").map((raw, i) => {
    const line = raw.trim();
    if (!line) return <div key={i} className="h-2" />;

    // Bold section header like **Overview:** rest...
    const headerMatch = line.match(/^\*\*(.+?)\*\*:?\s*(.*)$/);
    if (headerMatch) {
      return (
        <p key={i} className="text-sm">
          <span className="font-semibold">{headerMatch[1]}</span>
          {headerMatch[2] ? `: ${headerMatch[2].replace(/\*\*/g, "")}` : ""}
        </p>
      );
    }

    if (line.startsWith("- ") || line.startsWith("* ")) {
      return (
        <div key={i} className="flex gap-2 text-sm">
          <span className="text-muted-foreground">•</span>
          <span>{line.slice(2).replace(/\*\*/g, "")}</span>
        </div>
      );
    }

    return (
      <p key={i} className="text-sm">
        {line.replace(/\*\*/g, "")}
      </p>
    );
  });

export const CallSummaryDialog = ({ open, onOpenChange, target }: CallSummaryDialogProps) => {
  const [summary, setSummary] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { toast } = useToast();
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

  // Generate (or load cached) when the dialog opens for a recording.
  useEffect(() => {
    if (!open || !target) return;
    if (requestedFor.current === target.recordingId) return;
    requestedFor.current = target.recordingId;
    setSummary("");
    setError(null);
    generate(target.recordingId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, target?.recordingId]);

  // Reset when closed so reopening re-checks state cleanly.
  useEffect(() => {
    if (!open) requestedFor.current = null;
  }, [open]);

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
          {target?.direction && (
            <Badge variant="outline" className="gap-1 font-normal">
              {target.direction === "outbound" ? (
                <PhoneOutgoing className="w-3 h-3 text-success" />
              ) : (
                <PhoneIncoming className="w-3 h-3 text-primary" />
              )}
              {target.direction === "outbound" ? "Outbound" : "Inbound"}
            </Badge>
          )}
          <span className="font-medium truncate">{title}</span>
        </div>

        <div className="min-h-[180px] rounded-lg border bg-muted/30 p-4">
          {loading ? (
            <div className="flex flex-col items-center justify-center h-full min-h-[150px] gap-3 text-muted-foreground">
              <Loader2 className="w-6 h-6 animate-spin text-primary" />
              <p className="text-sm">Analyzing the call and writing a summary…</p>
              <p className="text-xs">This can take a few seconds the first time.</p>
            </div>
          ) : error ? (
            <div className="flex flex-col items-center justify-center h-full min-h-[150px] gap-3 text-center">
              <AlertCircle className="w-6 h-6 text-destructive" />
              <p className="text-sm text-muted-foreground max-w-sm">{error}</p>
            </div>
          ) : summary ? (
            <div className="space-y-1.5">{renderSummary(summary)}</div>
          ) : null}
        </div>

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
