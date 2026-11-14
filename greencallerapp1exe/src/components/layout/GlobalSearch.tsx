import { useState, useEffect, useCallback } from "react";
import { Search, Phone, MessageSquare, Voicemail, Users, PhoneIncoming, PhoneOutgoing, PhoneMissed } from "lucide-react";
import { Input } from "@/components/ui/input";
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { supabase } from "@/integrations/supabase/client";
import { formatDistanceToNow } from "date-fns";
import { cn } from "@/lib/utils";

interface SearchResult {
  id: string;
  type: "contact" | "call" | "message" | "voicemail";
  title: string;
  subtitle: string;
  timestamp?: string;
  metadata?: Record<string, any>;
}

interface GlobalSearchProps {
  userId?: string;
  onNavigate?: (tab: string) => void;
}

export const GlobalSearch = ({ userId, onNavigate }: GlobalSearchProps) => {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);

  // Keyboard shortcut to open search
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((open) => !open);
      }
    };

    document.addEventListener("keydown", down);
    return () => document.removeEventListener("keydown", down);
  }, []);

  const search = useCallback(async (searchQuery: string) => {
    if (!searchQuery.trim() || !userId) {
      setResults([]);
      return;
    }

    setIsSearching(true);
    const searchTerm = `%${searchQuery}%`;
    const allResults: SearchResult[] = [];

    try {
      // Search contacts (profiles in same company)
      const { data: profile } = await supabase
        .from("profiles")
        .select("company_name")
        .eq("id", userId)
        .single();

      if (profile?.company_name) {
        const { data: contacts } = await supabase
          .from("profiles")
          .select("id, full_name, email")
          .eq("company_name", profile.company_name)
          .or(`full_name.ilike.${searchTerm},email.ilike.${searchTerm}`)
          .limit(5);

        contacts?.forEach((contact) => {
          allResults.push({
            id: `contact-${contact.id}`,
            type: "contact",
            title: contact.full_name,
            subtitle: contact.email,
          });
        });
      }

      // Search call history
      const { data: calls } = await supabase
        .from("call_history")
        .select("id, from_number, to_number, direction, created_at, status")
        .eq("user_id", userId)
        .or(`from_number.ilike.${searchTerm},to_number.ilike.${searchTerm}`)
        .order("created_at", { ascending: false })
        .limit(5);

      calls?.forEach((call) => {
        const number = call.direction === "inbound" ? call.from_number : call.to_number;
        allResults.push({
          id: `call-${call.id}`,
          type: "call",
          title: number,
          subtitle: `${call.direction === "inbound" ? "Incoming" : "Outgoing"} call • ${call.status}`,
          timestamp: call.created_at || undefined,
          metadata: { direction: call.direction, status: call.status },
        });
      });

      // Search messages
      const { data: messages } = await supabase
        .from("messages")
        .select("id, from_number, to_number, message_body, direction, created_at")
        .eq("user_id", userId)
        .or(`from_number.ilike.${searchTerm},to_number.ilike.${searchTerm},message_body.ilike.${searchTerm}`)
        .order("created_at", { ascending: false })
        .limit(5);

      messages?.forEach((msg) => {
        const number = msg.direction === "inbound" ? msg.from_number : msg.to_number;
        allResults.push({
          id: `message-${msg.id}`,
          type: "message",
          title: number,
          subtitle: msg.message_body?.slice(0, 50) + (msg.message_body && msg.message_body.length > 50 ? "..." : ""),
          timestamp: msg.created_at || undefined,
        });
      });

      // Search voicemails
      const { data: voicemails } = await supabase
        .from("voicemails")
        .select("id, from_number, duration, created_at, transcription")
        .eq("user_id", userId)
        .or(`from_number.ilike.${searchTerm},transcription.ilike.${searchTerm}`)
        .order("created_at", { ascending: false })
        .limit(5);

      voicemails?.forEach((vm) => {
        allResults.push({
          id: `voicemail-${vm.id}`,
          type: "voicemail",
          title: vm.from_number,
          subtitle: vm.transcription?.slice(0, 50) || `${vm.duration || 0}s voicemail`,
          timestamp: vm.created_at || undefined,
        });
      });

      setResults(allResults);
    } catch (error) {
      console.error("Search error:", error);
    } finally {
      setIsSearching(false);
    }
  }, [userId]);

  // Debounced search
  useEffect(() => {
    const timer = setTimeout(() => {
      search(query);
    }, 300);

    return () => clearTimeout(timer);
  }, [query, search]);

  const handleSelect = (result: SearchResult) => {
    setOpen(false);
    setQuery("");
    
    // Navigate to the relevant tab
    switch (result.type) {
      case "contact":
        onNavigate?.("contacts");
        break;
      case "call":
        onNavigate?.("activity");
        break;
      case "message":
        onNavigate?.("messages");
        break;
      case "voicemail":
        onNavigate?.("activity");
        break;
    }
  };

  const getIcon = (type: SearchResult["type"], metadata?: Record<string, any>) => {
    switch (type) {
      case "contact":
        return <Users className="w-4 h-4 text-primary" />;
      case "call":
        if (metadata?.status === "missed" || metadata?.status === "no-answer") {
          return <PhoneMissed className="w-4 h-4 text-destructive" />;
        }
        return metadata?.direction === "inbound" 
          ? <PhoneIncoming className="w-4 h-4 text-success" />
          : <PhoneOutgoing className="w-4 h-4 text-primary" />;
      case "message":
        return <MessageSquare className="w-4 h-4 text-primary" />;
      case "voicemail":
        return <Voicemail className="w-4 h-4 text-warning" />;
    }
  };

  const groupedResults = {
    contacts: results.filter((r) => r.type === "contact"),
    calls: results.filter((r) => r.type === "call"),
    messages: results.filter((r) => r.type === "message"),
    voicemails: results.filter((r) => r.type === "voicemail"),
  };

  return (
    <>
      <div 
        className="relative hidden md:block cursor-pointer"
        onClick={() => setOpen(true)}
      >
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
        <Input
          placeholder="Search... ⌘K"
          className="w-64 pl-9 h-9 bg-background border-border focus:border-primary cursor-pointer"
          readOnly
        />
      </div>

      <CommandDialog open={open} onOpenChange={setOpen}>
        <Command shouldFilter={false}>
          <CommandInput 
            placeholder="Search contacts, calls, messages..."
            value={query}
            onValueChange={setQuery}
          />
        <CommandList>
          {!query && (
            <CommandEmpty>
              <div className="text-center py-6">
                <Search className="w-8 h-8 mx-auto text-muted-foreground mb-2" />
                <p className="text-sm text-muted-foreground">
                  Start typing to search across contacts, calls, messages, and voicemails
                </p>
              </div>
            </CommandEmpty>
          )}

          {query && results.length === 0 && !isSearching && (
            <CommandEmpty>No results found for "{query}"</CommandEmpty>
          )}

          {query && isSearching && (
            <div className="py-6 text-center text-sm text-muted-foreground">
              Searching...
            </div>
          )}

          {groupedResults.contacts.length > 0 && (
            <CommandGroup heading="Contacts">
              {groupedResults.contacts.map((result) => (
                <CommandItem
                  key={result.id}
                  onSelect={() => handleSelect(result)}
                  className="flex items-center gap-3 cursor-pointer"
                >
                  <div className="flex items-center justify-center w-8 h-8 rounded-full bg-primary/10">
                    {getIcon(result.type)}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{result.title}</p>
                    <p className="text-xs text-muted-foreground truncate">{result.subtitle}</p>
                  </div>
                </CommandItem>
              ))}
            </CommandGroup>
          )}

          {groupedResults.calls.length > 0 && (
            <CommandGroup heading="Call History">
              {groupedResults.calls.map((result) => (
                <CommandItem
                  key={result.id}
                  onSelect={() => handleSelect(result)}
                  className="flex items-center gap-3 cursor-pointer"
                >
                  <div className="flex items-center justify-center w-8 h-8 rounded-full bg-muted">
                    {getIcon(result.type, result.metadata)}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{result.title}</p>
                    <p className="text-xs text-muted-foreground truncate">{result.subtitle}</p>
                  </div>
                  {result.timestamp && (
                    <span className="text-xs text-muted-foreground">
                      {formatDistanceToNow(new Date(result.timestamp), { addSuffix: true })}
                    </span>
                  )}
                </CommandItem>
              ))}
            </CommandGroup>
          )}

          {groupedResults.messages.length > 0 && (
            <CommandGroup heading="Messages">
              {groupedResults.messages.map((result) => (
                <CommandItem
                  key={result.id}
                  onSelect={() => handleSelect(result)}
                  className="flex items-center gap-3 cursor-pointer"
                >
                  <div className="flex items-center justify-center w-8 h-8 rounded-full bg-primary/10">
                    {getIcon(result.type)}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{result.title}</p>
                    <p className="text-xs text-muted-foreground truncate">{result.subtitle}</p>
                  </div>
                  {result.timestamp && (
                    <span className="text-xs text-muted-foreground">
                      {formatDistanceToNow(new Date(result.timestamp), { addSuffix: true })}
                    </span>
                  )}
                </CommandItem>
              ))}
            </CommandGroup>
          )}

          {groupedResults.voicemails.length > 0 && (
            <CommandGroup heading="Voicemails">
              {groupedResults.voicemails.map((result) => (
                <CommandItem
                  key={result.id}
                  onSelect={() => handleSelect(result)}
                  className="flex items-center gap-3 cursor-pointer"
                >
                  <div className="flex items-center justify-center w-8 h-8 rounded-full bg-warning/10">
                    {getIcon(result.type)}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{result.title}</p>
                    <p className="text-xs text-muted-foreground truncate">{result.subtitle}</p>
                  </div>
                  {result.timestamp && (
                    <span className="text-xs text-muted-foreground">
                      {formatDistanceToNow(new Date(result.timestamp), { addSuffix: true })}
                    </span>
                  )}
                </CommandItem>
              ))}
            </CommandGroup>
          )}
        </CommandList>
        </Command>
      </CommandDialog>
    </>
  );
};
