import { useEffect, useState, useRef } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Send, Search, User, MessageCircle, Check, CheckCheck, Smile } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import { format, isToday, isYesterday } from "date-fns";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

interface TeamMember {
  id: string;
  full_name: string;
  email: string;
  lastMessage?: string;
  lastMessageTime?: string;
  unreadCount?: number;
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

interface MessagesListProps {
  userId?: string;
  onMessagesRead?: () => void;
}

// Typing indicator component
const TypingIndicator = () => (
  <div className="flex items-center gap-1 px-4 py-2">
    <div className="flex gap-1">
      <span className="w-2 h-2 bg-muted-foreground/50 rounded-full animate-bounce" style={{ animationDelay: "0ms" }} />
      <span className="w-2 h-2 bg-muted-foreground/50 rounded-full animate-bounce" style={{ animationDelay: "150ms" }} />
      <span className="w-2 h-2 bg-muted-foreground/50 rounded-full animate-bounce" style={{ animationDelay: "300ms" }} />
    </div>
  </div>
);

// Message bubble component
const MessageBubble = ({ 
  message, 
  isSent, 
  showAvatar,
  senderName 
}: { 
  message: TeamMessage; 
  isSent: boolean; 
  showAvatar: boolean;
  senderName: string;
}) => {
  const getInitials = (name: string) => {
    return name.split(" ").map(n => n[0]).join("").toUpperCase().slice(0, 2);
  };

  return (
    <div 
      className={cn(
        "flex gap-2 animate-fade-in",
        isSent ? "flex-row-reverse" : "flex-row"
      )}
    >
      {/* Avatar */}
      <div className="w-8 flex-shrink-0">
        {showAvatar && !isSent && (
          <Avatar className="w-8 h-8">
            <AvatarFallback className="bg-primary/10 text-primary text-xs">
              {getInitials(senderName)}
            </AvatarFallback>
          </Avatar>
        )}
      </div>

      {/* Message Content */}
      <div className={cn("max-w-[70%] group", isSent ? "items-end" : "items-start")}>
        <div
          className={cn(
            "px-4 py-2.5 rounded-2xl transition-all duration-200",
            isSent 
              ? "bg-primary text-primary-foreground rounded-br-md" 
              : "bg-card border border-border rounded-bl-md shadow-sm"
          )}
        >
          <p className="text-sm whitespace-pre-wrap break-words leading-relaxed">
            {message.message_body}
          </p>
        </div>
        
        {/* Time and status */}
        <div className={cn(
          "flex items-center gap-1 mt-1 px-1",
          isSent ? "justify-end" : "justify-start"
        )}>
          <span className="text-[10px] text-muted-foreground">
            {format(new Date(message.created_at), "h:mm a")}
          </span>
          {isSent && (
            message.read 
              ? <CheckCheck className="w-3 h-3 text-primary" />
              : <Check className="w-3 h-3 text-muted-foreground" />
          )}
        </div>
      </div>

      {/* Spacer for sent messages */}
      {isSent && <div className="w-8 flex-shrink-0" />}
    </div>
  );
};

// Date separator component
const DateSeparator = ({ date }: { date: Date }) => {
  const getDateLabel = (date: Date) => {
    if (isToday(date)) return "Today";
    if (isYesterday(date)) return "Yesterday";
    return format(date, "MMMM d, yyyy");
  };

  return (
    <div className="flex items-center justify-center my-6">
      <div className="bg-muted px-3 py-1 rounded-full">
        <span className="text-xs font-medium text-muted-foreground">
          {getDateLabel(date)}
        </span>
      </div>
    </div>
  );
};

const MessagesList = ({ userId, onMessagesRead }: MessagesListProps) => {
  const [conversationMessages, setConversationMessages] = useState<TeamMessage[]>([]);
  const [teamMembers, setTeamMembers] = useState<TeamMember[]>([]);
  const [selectedMember, setSelectedMember] = useState<TeamMember | null>(null);
  const [messageBody, setMessageBody] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [isTyping, setIsTyping] = useState(false);
  const [onlineUsers, setOnlineUsers] = useState<Set<string>>(new Set());
  const scrollRef = useRef<HTMLDivElement>(null);
  const { toast } = useToast();

  // Presence tracking
  useEffect(() => {
    if (!userId) return;

    const presenceChannel = supabase.channel('online-users', {
      config: { presence: { key: userId } }
    });

    presenceChannel
      .on('presence', { event: 'sync' }, () => {
        const state = presenceChannel.presenceState();
        const onlineIds = new Set<string>();
        Object.keys(state).forEach(key => {
          onlineIds.add(key);
        });
        setOnlineUsers(onlineIds);
      })
      .subscribe(async (status) => {
        if (status === 'SUBSCRIBED') {
          await presenceChannel.track({ user_id: userId, online_at: new Date().toISOString() });
        }
      });

    return () => {
      supabase.removeChannel(presenceChannel);
    };
  }, [userId]);

  useEffect(() => {
    if (userId) {
      fetchTeamMembers();

      const channel = supabase
        .channel("team_messages")
        .on(
          "postgres_changes",
          {
            event: "*",
            schema: "public",
            table: "team_messages",
          },
          () => {
            fetchTeamMembers();
            if (selectedMember) {
              fetchConversation(selectedMember.id);
            }
          }
        )
        .subscribe();

      return () => {
        supabase.removeChannel(channel);
      };
    }
  }, [userId, selectedMember]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [conversationMessages]);

  const fetchTeamMembers = async () => {
    if (!userId) return;

    try {
      const { data: profile } = await supabase
        .from("profiles")
        .select("company_name")
        .eq("id", userId)
        .single();

      if (!profile?.company_name) return;

      const { data, error } = await supabase
        .from("profiles")
        .select("id, full_name, email")
        .eq("company_name", profile.company_name)
        .neq("id", userId);

      if (error) throw error;

      const membersWithMessages = await Promise.all(
        (data || []).map(async (member) => {
          const { data: messages } = await supabase
            .from("team_messages")
            .select("message_body, created_at, read, from_user_id")
            .or(`and(from_user_id.eq.${userId},to_user_id.eq.${member.id}),and(from_user_id.eq.${member.id},to_user_id.eq.${userId})`)
            .order("created_at", { ascending: false })
            .limit(1);

          const lastMsg = messages?.[0];
          const unreadCount = await getUnreadCount(member.id);

          return {
            ...member,
            lastMessage: lastMsg?.message_body,
            lastMessageTime: lastMsg?.created_at,
            unreadCount,
            isOnline: onlineUsers.has(member.id),
          };
        })
      );

      membersWithMessages.sort((a, b) => {
        if (!a.lastMessageTime) return 1;
        if (!b.lastMessageTime) return -1;
        return new Date(b.lastMessageTime).getTime() - new Date(a.lastMessageTime).getTime();
      });

      setTeamMembers(membersWithMessages);
    } catch (error) {
      console.error("Error fetching team members:", error);
    }
  };

  const getUnreadCount = async (fromUserId: string) => {
    if (!userId) return 0;

    const { count } = await supabase
      .from("team_messages")
      .select("*", { count: "exact", head: true })
      .eq("from_user_id", fromUserId)
      .eq("to_user_id", userId)
      .eq("read", false);

    return count || 0;
  };

  const fetchConversation = async (otherUserId: string) => {
    if (!userId) return;

    try {
      await supabase
        .from("team_messages")
        .update({ read: true })
        .eq("from_user_id", otherUserId)
        .eq("to_user_id", userId)
        .eq("read", false);

      const { data, error } = await supabase
        .from("team_messages")
        .select("*")
        .or(`and(from_user_id.eq.${userId},to_user_id.eq.${otherUserId}),and(from_user_id.eq.${otherUserId},to_user_id.eq.${userId})`)
        .order("created_at", { ascending: true });

      if (error) throw error;
      setConversationMessages(data || []);
      fetchTeamMembers();
      onMessagesRead?.();
    } catch (error) {
      console.error("Error fetching conversation:", error);
    }
  };

  const handleSendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!messageBody.trim() || !selectedMember) return;

    setLoading(true);

    try {
      const { error } = await supabase
        .from("team_messages")
        .insert({
          from_user_id: userId!,
          to_user_id: selectedMember.id,
          message_body: messageBody.trim(),
        });

      if (error) throw error;

      setMessageBody("");
      fetchConversation(selectedMember.id);
    } catch (error) {
      console.error("Error sending message:", error);
      toast({
        title: "Error",
        description: error instanceof Error ? error.message : "Failed to send message",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  };

  const handleSelectMember = (member: TeamMember) => {
    setSelectedMember(member);
    fetchConversation(member.id);
  };

  const getInitials = (name: string) => {
    return name.split(" ").map((n) => n[0]).join("").toUpperCase().slice(0, 2);
  };

  const filteredMembers = teamMembers.filter((member) =>
    member.full_name.toLowerCase().includes(searchQuery.toLowerCase()) ||
    member.email.toLowerCase().includes(searchQuery.toLowerCase())
  );

  // Group messages by date
  const groupedMessages = conversationMessages.reduce((groups, message) => {
    const date = format(new Date(message.created_at), "yyyy-MM-dd");
    if (!groups[date]) {
      groups[date] = [];
    }
    groups[date].push(message);
    return groups;
  }, {} as Record<string, TeamMessage[]>);

  return (
    <div className="flex h-full">
      {/* Left Sidebar - Team Members */}
      <div className="w-80 min-w-[320px] max-w-[320px] border-r border-border flex flex-col bg-card overflow-hidden">
        <div className="p-5 border-b border-border space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="font-display text-lg font-semibold flex items-center gap-2">
              <MessageCircle className="w-5 h-5 text-primary" />
              Messages
            </h2>
            <Badge variant="secondary" className="text-xs">
              {teamMembers.length} contacts
            </Badge>
          </div>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              placeholder="Search conversations..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-9 bg-background"
            />
          </div>
        </div>

        <ScrollArea className="flex-1 w-full">
          <div className="p-2 max-w-full overflow-hidden">
            {filteredMembers.length === 0 ? (
              <div className="text-center py-12">
                <div className="w-12 h-12 mx-auto rounded-full bg-muted flex items-center justify-center mb-3">
                  <User className="w-6 h-6 text-muted-foreground" />
                </div>
                <p className="text-sm text-muted-foreground">No conversations found</p>
              </div>
            ) : (
              <div className="space-y-1">
                {filteredMembers.map((member) => {
                  const isSelected = selectedMember?.id === member.id;
                  const hasUnread = (member.unreadCount ?? 0) > 0;
                  
                  return (
                    <button
                      key={member.id}
                      onClick={() => handleSelectMember(member)}
                      className={cn(
                        "w-full flex items-center gap-3 p-3 rounded-xl transition-all duration-200 overflow-hidden",
                        isSelected
                          ? "bg-accent shadow-sm"
                          : hasUnread
                            ? "bg-yellow-400/10 hover:bg-yellow-400/20"
                            : "hover:bg-muted/50"
                      )}
                    >
                      <div className="relative flex-shrink-0">
                        <Avatar className={cn(
                          "h-12 w-12 border-2",
                          hasUnread ? "border-yellow-400" : "border-background"
                        )}>
                          <AvatarFallback className={cn(
                            "text-sm font-medium",
                            isSelected ? "bg-primary/20 text-primary" : hasUnread ? "bg-yellow-400/20 text-yellow-600" : "bg-muted"
                          )}>
                            {getInitials(member.full_name)}
                          </AvatarFallback>
                        </Avatar>
                        {/* Online indicator */}
                        {member.isOnline && (
                          <span className="absolute bottom-0 right-0 w-3 h-3 bg-success border-2 border-card rounded-full" />
                        )}
                      </div>
                      <div className="flex-1 text-left min-w-0 overflow-hidden">
                        <div className="flex items-center justify-between mb-0.5">
                          <p className={cn(
                            "font-medium truncate min-w-0 flex-1",
                            hasUnread && "text-foreground"
                          )}>
                            {member.full_name}
                          </p>
                          {member.lastMessageTime && (
                            <span className={cn(
                              "text-[10px] flex-shrink-0 ml-2",
                              hasUnread ? "text-yellow-500 font-medium" : "text-muted-foreground"
                            )}>
                              {isToday(new Date(member.lastMessageTime))
                                ? format(new Date(member.lastMessageTime), "h:mm a")
                                : format(new Date(member.lastMessageTime), "MMM d")
                              }
                            </span>
                          )}
                        </div>
                        <div className="flex items-center justify-between">
                          <p className={cn(
                            "text-sm truncate min-w-0 flex-1",
                            hasUnread ? "text-foreground font-medium" : "text-muted-foreground"
                          )}>
                            {member.lastMessage || "No messages yet"}
                          </p>
                          {hasUnread && (
                            <Badge className="bg-yellow-400 text-black h-5 min-w-5 px-1.5 text-xs flex-shrink-0 ml-2">
                              {member.unreadCount}
                            </Badge>
                          )}
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </ScrollArea>
      </div>

      {/* Right Panel - Conversation */}
      <div className="flex-1 flex flex-col bg-background-subtle">
        {selectedMember ? (
          <>
            {/* Chat Header */}
            <div className="border-b border-border p-4 bg-card">
              <div className="flex items-center gap-3">
                <div className="relative">
                  <Avatar className="h-10 w-10">
                    <AvatarFallback className="bg-primary/10 text-primary">
                      {getInitials(selectedMember.full_name)}
                    </AvatarFallback>
                  </Avatar>
                  {selectedMember.isOnline && (
                    <span className="absolute bottom-0 right-0 w-2.5 h-2.5 bg-success border-2 border-card rounded-full" />
                  )}
                </div>
                <div className="flex-1">
                  <h3 className="font-display font-semibold">{selectedMember.full_name}</h3>
                  <p className={cn(
                    "text-xs flex items-center gap-1",
                    selectedMember.isOnline ? "text-success" : "text-muted-foreground"
                  )}>
                    <span className={cn(
                      "w-1.5 h-1.5 rounded-full",
                      selectedMember.isOnline ? "bg-success" : "bg-muted-foreground"
                    )} />
                    {selectedMember.isOnline ? "Online" : "Offline"}
                  </p>
                </div>
              </div>
            </div>

            {/* Messages Area */}
            <ScrollArea className="flex-1 p-4" ref={scrollRef}>
              <div className="max-w-3xl mx-auto space-y-2">
                {conversationMessages.length === 0 ? (
                  <div className="text-center py-20">
                    <div className="w-20 h-20 mx-auto rounded-full bg-accent flex items-center justify-center mb-4">
                      <MessageCircle className="w-10 h-10 text-accent-foreground" />
                    </div>
                    <h3 className="font-display font-semibold text-lg mb-1">Start a conversation</h3>
                    <p className="text-sm text-muted-foreground">
                      Send a message to {selectedMember.full_name}
                    </p>
                  </div>
                ) : (
                  Object.entries(groupedMessages).map(([date, messages]) => (
                    <div key={date}>
                      <DateSeparator date={new Date(date)} />
                      <div className="space-y-3">
                        {messages.map((msg, index) => {
                          const isSent = msg.from_user_id === userId;
                          const prevMsg = messages[index - 1];
                          const showAvatar = !prevMsg || prevMsg.from_user_id !== msg.from_user_id;

                          return (
                            <MessageBubble
                              key={msg.id}
                              message={msg}
                              isSent={isSent}
                              showAvatar={showAvatar}
                              senderName={selectedMember.full_name}
                            />
                          );
                        })}
                      </div>
                    </div>
                  ))
                )}
                
                {/* Typing indicator */}
                {isTyping && (
                  <div className="flex gap-2">
                    <Avatar className="w-8 h-8">
                      <AvatarFallback className="bg-primary/10 text-primary text-xs">
                        {getInitials(selectedMember.full_name)}
                      </AvatarFallback>
                    </Avatar>
                    <div className="bg-card border border-border rounded-2xl rounded-bl-md shadow-sm">
                      <TypingIndicator />
                    </div>
                  </div>
                )}
              </div>
            </ScrollArea>

            {/* Message Input */}
            <div className="border-t border-border p-4 bg-card">
              <form onSubmit={handleSendMessage} className="flex gap-3 max-w-3xl mx-auto">
                <div className="flex-1 relative">
                  <Input
                    value={messageBody}
                    onChange={(e) => setMessageBody(e.target.value)}
                    placeholder="Type a message..."
                    disabled={loading}
                    className="pr-10 bg-background border-border focus:border-primary"
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        handleSendMessage(e);
                      }
                    }}
                  />
                  <Button 
                    type="button" 
                    variant="ghost" 
                    size="icon-sm" 
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  >
                    <Smile className="w-4 h-4" />
                  </Button>
                </div>
                <Button 
                  type="submit" 
                  disabled={loading || !messageBody.trim()}
                  className="gap-2"
                >
                  <Send className="w-4 h-4" />
                  <span className="hidden sm:inline">Send</span>
                </Button>
              </form>
            </div>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center">
              <div className="w-24 h-24 mx-auto rounded-full bg-accent flex items-center justify-center mb-6">
                <MessageCircle className="w-12 h-12 text-accent-foreground" />
              </div>
              <h3 className="font-display text-xl font-semibold mb-2">Your Messages</h3>
              <p className="text-muted-foreground max-w-sm">
                Select a conversation from the sidebar to start messaging your team members
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default MessagesList;
