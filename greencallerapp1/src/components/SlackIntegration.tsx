import { useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Slack, Loader2, CheckCircle2, Bell, PhoneMissed, Sparkles } from "lucide-react";

export const SlackIntegration = () => {
  const { toast } = useToast();
  const [loading, setLoading] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [connected, setConnected] = useState(false);
  const [teamName, setTeamName] = useState<string | null>(null);
  const [linked, setLinked] = useState(false);
  const [linking, setLinking] = useState(false);
  const pollRef = useRef<number | null>(null);
  const linkPollRef = useRef<number | null>(null);

  const call = async (action: string) => {
    const { data, error } = await supabase.functions.invoke("slack-connect", { body: { action } });
    if (error) throw new Error(error.message);
    if (data?.error) throw new Error(data.error);
    return data;
  };

  const refreshStatus = async () => {
    try {
      const d = await call("status");
      setConnected(!!d.connected);
      setTeamName(d.team_name || null);
      setLinked(!!d.linked);
      return d;
    } catch {
      return null;
    }
  };

  useEffect(() => {
    refreshStatus().finally(() => setLoading(false));
    return () => {
      if (pollRef.current) window.clearInterval(pollRef.current);
      if (linkPollRef.current) window.clearInterval(linkPollRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const linkAccount = async () => {
    setLinking(true);
    try {
      const d = await call("link");
      if (!d.url) throw new Error("Could not start Slack account linking");
      window.open(d.url, "slack_link", "width=600,height=760");
      let tries = 0;
      linkPollRef.current = window.setInterval(async () => {
        tries++;
        const s = await refreshStatus();
        if (s?.linked || tries > 48) {
          if (linkPollRef.current) window.clearInterval(linkPollRef.current);
          setLinking(false);
          if (s?.linked) toast({ title: "Slack account linked" });
        }
      }, 2500);
    } catch (e: any) {
      setLinking(false);
      toast({ title: "Error", description: e.message, variant: "destructive" });
    }
  };

  const connect = async () => {
    setConnecting(true);
    try {
      const d = await call("start");
      if (!d.url) throw new Error("Could not start Slack connection");
      window.open(d.url, "slack_oauth", "width=600,height=760");
      // Poll for completion (the OAuth happens in the popup).
      let tries = 0;
      pollRef.current = window.setInterval(async () => {
        tries++;
        const s = await refreshStatus();
        if (s?.connected || tries > 48) { // ~2 min
          if (pollRef.current) window.clearInterval(pollRef.current);
          setConnecting(false);
          if (s?.connected) toast({ title: "Slack connected" });
        }
      }, 2500);
    } catch (e: any) {
      setConnecting(false);
      toast({ title: "Error", description: e.message, variant: "destructive" });
    }
  };

  const disconnect = async () => {
    if (!confirm("Disconnect Slack? Your team will stop receiving call notifications.")) return;
    try {
      await call("disconnect");
      setConnected(false);
      setTeamName(null);
      toast({ title: "Slack disconnected" });
    } catch (e: any) {
      toast({ title: "Error", description: e.message, variant: "destructive" });
    }
  };

  if (loading) {
    return <div className="flex items-center justify-center py-16"><Loader2 className="w-6 h-6 animate-spin text-primary" /></div>;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4 rounded-lg border p-4">
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 rounded-lg bg-muted flex items-center justify-center shrink-0">
            <Slack className="w-5 h-5" />
          </div>
          <div>
            <div className="font-medium flex items-center gap-2">
              Slack
              {connected && <Badge className="gap-1 bg-green-500/15 text-green-600 border-0"><CheckCircle2 className="w-3 h-3" /> Connected</Badge>}
            </div>
            <p className="text-sm text-muted-foreground">
              {connected
                ? `Connected to ${teamName || "your workspace"}. Your team gets call notifications in Slack.`
                : "Connect your company's Slack workspace to get call notifications."}
            </p>
          </div>
        </div>
        {connected ? (
          <Button variant="outline" size="sm" onClick={disconnect}>Disconnect</Button>
        ) : (
          <Button size="sm" onClick={connect} disabled={connecting} className="gap-1.5 shrink-0">
            {connecting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Slack className="w-4 h-4" />}
            {connecting ? "Waiting…" : "Connect Slack"}
          </Button>
        )}
      </div>

      {connected && (
        <div className="flex items-start justify-between gap-4 rounded-lg border p-4">
          <div>
            <div className="font-medium flex items-center gap-2">
              Your Slack account
              {linked && <Badge className="gap-1 bg-green-500/15 text-green-600 border-0"><CheckCircle2 className="w-3 h-3" /> Linked</Badge>}
            </div>
            <p className="text-sm text-muted-foreground">
              {linked
                ? "Your call notifications will be DM'd to your linked Slack account."
                : "Link your Slack so call notifications reach you — even if your Slack email is different from your Greencaller email."}
            </p>
          </div>
          <Button variant={linked ? "outline" : "default"} size="sm" onClick={linkAccount} disabled={linking} className="gap-1.5 shrink-0">
            {linking ? <Loader2 className="w-4 h-4 animate-spin" /> : <Slack className="w-4 h-4" />}
            {linking ? "Waiting…" : linked ? "Re-link" : "Link your Slack"}
          </Button>
        </div>
      )}

      <div>
        <p className="text-sm font-medium mb-2">What you'll get</p>
        <ul className="space-y-2 text-sm text-muted-foreground">
          <li className="flex items-center gap-2"><PhoneMissed className="w-4 h-4 text-primary" /> Missed-call alerts, sent as a DM to whoever owns that number</li>
          <li className="flex items-center gap-2"><Bell className="w-4 h-4 text-primary" /> Voicemail notifications with the transcript</li>
          <li className="flex items-center gap-2"><Sparkles className="w-4 h-4 text-primary" /> AI call summaries posted after a call</li>
        </ul>
        {connecting && (
          <p className="text-xs text-muted-foreground mt-4">
            Finish authorising in the Slack window that opened, then come back here — it'll update automatically.
          </p>
        )}
      </div>
    </div>
  );
};
