import { useCallback, useEffect, useRef, useState } from "react";
import { format, isToday, isYesterday } from "date-fns";
import { Check, CheckCheck, ChevronLeft, MessageCircle, Phone, Send } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

export interface ConversationMember {
  id: string;
  full_name: string;
  email?: string | null;
  phone?: string | null;
  isOnline?: boolean;
}

interface TeamMessage {
  id: string;
  from_user_id: string;
  to_user_id: string;
  message_body: string;
  read: boolean;
  created_at: string;
}

interface TeamConversationProps {
  userId?: string;
  member: ConversationMember;
  /** Narrow single-pane layout (Sidebar Mode); shows a back control. */
  compact?: boolean;
  onBack?: () => void;
  onCall?: (phoneNumber: string) => void;
  /** Fired after the other side's messages are marked read. */
  onMessagesRead?: () => void;
}

const initials = (name: string) =>
  name.split(" ").map((n) => n[0]).join("").toUpperCase().slice(0, 2);

const MessageBubble = ({
  message,
  isSent,
  showAvatar,
  senderName,
  compact,
}: {
  message: TeamMessage;
  isSent: boolean;
  showAvatar: boolean;
  senderName: string;
  compact: boolean;
}) => (
  <div className={cn("flex gap-2 animate-fade-in", isSent ? "flex-row-reverse" : "flex-row")}>
    <div className={cn("flex-shrink-0", compact ? "w-6" : "w-8")}>
      {showAvatar && !isSent && (
        <Avatar className={compact ? "w-6 h-6" : "w-8 h-8"}>
          <AvatarFallback className={cn("bg-primary/10 text-primary", compact ? "text-[9px]" : "text-xs")}>
            {initials(senderName)}
          </AvatarFallback>
        </Avatar>
      )}
    </div>
    <div className={cn("group min-w-0", compact ? "max-w-[82%]" : "max-w-[70%]")}>
      <div
        className={cn(
          "rounded-2xl",
          compact ? "px-2.5 py-1.5" : "px-4 py-2.5",
          isSent
            ? "bg-primary text-primary-foreground rounded-br-md"
            : "bg-card border border-border rounded-bl-md shadow-sm",
        )}
      >
        <p className={cn("whitespace-pre-wrap break-words", compact ? "text-[11px] leading-snug" : "text-sm leading-relaxed")}>
          {message.message_body}
        </p>
      </div>
      <div className={cn("flex items-center gap-1 mt-1 px-1", isSent ? "justify-end" : "justify-start")}>
        <span className="text-[10px] text-muted-foreground">{format(new Date(message.created_at), "h:mm a")}</span>
        {isSent &&
          (message.read ? (
            <CheckCheck className="w-3 h-3 text-primary" />
          ) : (
            <Check className="w-3 h-3 text-muted-foreground" />
          ))}
      </div>
    </div>
    {isSent && <div className="w-8 flex-shrink-0" />}
  </div>
);

const dateLabel = (d: Date) => (isToday(d) ? "Today" : isYesterday(d) ? "Yesterday" : format(d, "MMMM d, yyyy"));

/**
 * One-to-one team chat with a teammate. Lives on the right of the Teammates
 * view (and in place of the list in Sidebar Mode). Marks the teammate's
 * messages read when opened and as they arrive.
 */
export const TeamConversation = ({ userId, member, compact = false, onBack, onCall, onMessagesRead }: TeamConversationProps) => {
  const { toast } = useToast();
  const [messages, setMessages] = useState<TeamMessage[]>([]);
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    if (!userId) return;
    // Anything they sent us is now seen.
    const { data: marked } = await supabase
      .from("team_messages")
      .update({ read: true })
      .eq("from_user_id", member.id)
      .eq("to_user_id", userId)
      .eq("read", false)
      .select("id");
    if (marked && marked.length > 0) onMessagesRead?.();

    const { data, error } = await supabase
      .from("team_messages")
      .select("*")
      .or(`and(from_user_id.eq.${userId},to_user_id.eq.${member.id}),and(from_user_id.eq.${member.id},to_user_id.eq.${userId})`)
      .order("created_at", { ascending: true });
    if (error) console.error("Conversation fetch error:", error);
    else setMessages(data || []);
  }, [userId, member.id, onMessagesRead]);

  useEffect(() => {
    setMessages([]);
    load();
    if (!userId) return;
    // Both directions: their replies land as to_user_id = me; read receipts on
    // our own messages come back as from_user_id = me.
    const channel = supabase
      .channel(`conversation-${userId}-${member.id}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "team_messages", filter: `to_user_id=eq.${userId}` }, load)
      .on("postgres_changes", { event: "*", schema: "public", table: "team_messages", filter: `from_user_id=eq.${userId}` }, load)
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [userId, member.id, load]);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages]);

  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    const text = body.trim();
    if (!text || !userId) return;
    setSending(true);
    try {
      const { error } = await supabase
        .from("team_messages")
        .insert({ from_user_id: userId, to_user_id: member.id, message_body: text });
      if (error) throw error;
      setBody("");
      load();
    } catch (err) {
      toast({
        title: "Message not sent",
        description: err instanceof Error ? err.message : "Please try again",
        variant: "destructive",
      });
    } finally {
      setSending(false);
    }
  };

  const grouped = messages.reduce<Record<string, TeamMessage[]>>((acc, m) => {
    const k = format(new Date(m.created_at), "yyyy-MM-dd");
    (acc[k] ||= []).push(m);
    return acc;
  }, {});

  return (
    <div className="flex h-full min-h-0 flex-col bg-background-subtle">
      {/* Header */}
      <div className={cn("border-b border-border bg-card shrink-0", compact ? "px-2.5 py-2" : "p-4")}>
        <div className={cn("flex items-center", compact ? "gap-2" : "gap-3")}>
          {onBack && (
            <button
              type="button"
              onClick={onBack}
              aria-label="Back"
              className="flex h-7 w-7 -ml-1 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
          )}
          <div className="relative shrink-0">
            <Avatar className={compact ? "h-8 w-8" : "h-10 w-10"}>
              <AvatarFallback className={cn("bg-primary/10 text-primary", compact && "text-[11px]")}>
                {initials(member.full_name)}
              </AvatarFallback>
            </Avatar>
            {member.isOnline && (
              <span className="absolute bottom-0 right-0 h-2.5 w-2.5 rounded-full border-2 border-card bg-success" />
            )}
          </div>
          <div className="min-w-0 flex-1">
            <h3 className={cn("truncate font-display font-semibold", compact && "text-xs")}>{member.full_name}</h3>
            <p
              className={cn(
                "flex items-center gap-1.5 truncate",
                compact ? "text-[10px]" : "text-xs",
                member.isOnline ? "text-success" : "text-muted-foreground",
              )}
            >
              <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", member.isOnline ? "bg-success" : "bg-muted-foreground")} />
              {member.isOnline ? "Online" : "Offline"}
              {member.phone && <span className="font-mono text-muted-foreground">· {member.phone}</span>}
            </p>
          </div>
          {member.phone && onCall && (
            <Button
              size={compact ? "icon" : "sm"}
              className={cn("shrink-0 bg-success text-success-foreground hover:bg-success/90", compact ? "h-8 w-8" : "gap-1.5")}
              onClick={() => onCall(member.phone!)}
              title={`Call ${member.phone}`}
            >
              <Phone className="h-4 w-4" />
              {!compact && "Call"}
            </Button>
          )}
        </div>
      </div>

      {/* Messages */}
      <ScrollArea className={cn("flex-1 min-h-0", compact ? "p-2.5" : "p-4")} ref={scrollRef}>
        <div className="mx-auto max-w-3xl space-y-2">
          {messages.length === 0 ? (
            <div className={cn("text-center", compact ? "py-10" : "py-20")}>
              <div className={cn("mx-auto flex items-center justify-center rounded-full bg-accent", compact ? "mb-3 h-12 w-12" : "mb-4 h-20 w-20")}>
                <MessageCircle className={cn("text-accent-foreground", compact ? "h-6 w-6" : "h-10 w-10")} />
              </div>
              <h3 className={cn("mb-1 font-display font-semibold", compact ? "text-sm" : "text-lg")}>Start a conversation</h3>
              <p className={cn("text-muted-foreground", compact ? "text-xs" : "text-sm")}>Send a message to {member.full_name}</p>
            </div>
          ) : (
            Object.entries(grouped).map(([date, list]) => (
              <div key={date}>
                <div className="my-5 flex items-center justify-center">
                  <span className="rounded-full bg-muted px-3 py-1 text-xs font-medium text-muted-foreground">
                    {dateLabel(new Date(date))}
                  </span>
                </div>
                <div className="space-y-3">
                  {list.map((m, i) => (
                    <MessageBubble
                      key={m.id}
                      message={m}
                      isSent={m.from_user_id === userId}
                      showAvatar={!list[i - 1] || list[i - 1].from_user_id !== m.from_user_id}
                      senderName={member.full_name}
                      compact={compact}
                    />
                  ))}
                </div>
              </div>
            ))
          )}
        </div>
      </ScrollArea>

      {/* Composer */}
      <div className={cn("border-t border-border bg-card shrink-0", compact ? "p-2" : "p-4")}>
        <form onSubmit={send} className={cn("mx-auto flex max-w-3xl", compact ? "gap-2" : "gap-3")}>
          <Input
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder={`Message ${member.full_name.split(" ")[0]}…`}
            disabled={sending}
            className={cn("bg-background", compact && "h-8 text-xs")}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send(e);
              }
            }}
          />
          <Button
            type="submit"
            disabled={sending || !body.trim()}
            className={cn("shrink-0 gap-2", compact && "h-8 w-8 p-0")}
            aria-label="Send message"
          >
            <Send className={compact ? "h-3.5 w-3.5" : "h-4 w-4"} />
            {!compact && <span className="hidden sm:inline">Send</span>}
          </Button>
        </form>
      </div>
    </div>
  );
};

export default TeamConversation;
