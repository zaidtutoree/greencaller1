import { useEffect, useMemo, useState } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Search, Phone, Plus, Trash2, Loader2, UserPlus, Users } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { invalidateContactsCache } from "@/utils/contactLookup";

interface UserContact {
  id: string;
  name: string;
  phone_number: string;
  email: string | null;
  created_at: string | null;
}

interface PersonalContactsProps {
  userId?: string;
  onCall?: (phoneNumber: string) => void;
}

const getInitials = (name: string) => {
  if (!name) return "?";
  const parts = name.trim().split(" ");
  if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  return name.substring(0, 2).toUpperCase();
};

const AVATAR_COLORS = [
  "bg-emerald-500", "bg-teal-500", "bg-rose-500", "bg-amber-500",
  "bg-cyan-600", "bg-orange-500", "bg-indigo-500", "bg-fuchsia-500",
];
const colorFor = (name: string) => {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
};

export const PersonalContacts = ({ userId, onCall }: PersonalContactsProps) => {
  const { toast } = useToast();
  const [contacts, setContacts] = useState<UserContact[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");

  const [addOpen, setAddOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [newName, setNewName] = useState("");
  const [newPhone, setNewPhone] = useState("");
  const [newEmail, setNewEmail] = useState("");

  const fetchContacts = async () => {
    if (!userId) return;
    const { data, error } = await supabase
      .from("user_contacts")
      .select("id, name, phone_number, email, created_at")
      .eq("user_id", userId)
      .order("name", { ascending: true });
    if (error) {
      console.error("Error fetching contacts:", error);
    } else {
      setContacts(data || []);
    }
    setLoading(false);
  };

  useEffect(() => {
    fetchContacts();
    if (!userId) return;

    // Realtime: pick up contacts added from any device (e.g. the mobile app).
    const channel = supabase
      .channel(`user_contacts_${userId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "user_contacts", filter: `user_id=eq.${userId}` },
        () => fetchContacts(),
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  const handleAdd = async () => {
    if (!userId) return;
    if (!newName.trim() || !newPhone.trim()) {
      toast({
        title: "Name and phone required",
        description: "Please enter both a name and a phone number.",
        variant: "destructive",
      });
      return;
    }
    setSaving(true);
    const { error } = await supabase.from("user_contacts").insert({
      user_id: userId,
      name: newName.trim(),
      phone_number: newPhone.trim(),
      email: newEmail.trim() || null,
    });
    setSaving(false);
    if (error) {
      toast({ title: "Error", description: error.message || "Failed to add contact", variant: "destructive" });
      return;
    }
    invalidateContactsCache();
    toast({ title: "Contact added" });
    setNewName("");
    setNewPhone("");
    setNewEmail("");
    setAddOpen(false);
    fetchContacts();
  };

  const handleDelete = async (contact: UserContact) => {
    const { error } = await supabase.from("user_contacts").delete().eq("id", contact.id);
    if (error) {
      toast({ title: "Error", description: "Failed to delete contact", variant: "destructive" });
      return;
    }
    invalidateContactsCache();
    toast({ title: "Contact deleted" });
    fetchContacts();
  };

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return contacts.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        c.phone_number.includes(search) ||
        (c.email || "").toLowerCase().includes(q),
    );
  }, [contacts, search]);

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="p-5 border-b border-border">
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-display text-lg font-semibold flex items-center gap-2">
            <Users className="w-5 h-5 text-primary" />
            Contacts
            <span className="text-sm text-muted-foreground font-normal">({contacts.length})</span>
          </h2>
          <Button size="sm" className="gap-1.5" onClick={() => setAddOpen(true)}>
            <Plus className="w-4 h-4" />
            Add Contact
          </Button>
        </div>
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            placeholder="Search contacts..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>
      </div>

      {/* List */}
      <ScrollArea className="flex-1">
        {loading ? (
          <div className="flex items-center justify-center py-16 text-muted-foreground">
            <Loader2 className="w-6 h-6 animate-spin" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-center px-6">
            <div className="w-16 h-16 rounded-full bg-muted flex items-center justify-center mb-4">
              <UserPlus className="w-8 h-8 text-muted-foreground" />
            </div>
            <h3 className="font-medium mb-1">
              {search ? "No contacts match your search" : "No contacts yet"}
            </h3>
            {!search && (
              <p className="text-sm text-muted-foreground max-w-xs">
                Add a contact here, or add one from the mobile app — it'll show up automatically.
              </p>
            )}
          </div>
        ) : (
          <div className="p-3 space-y-1">
            {filtered.map((contact) => (
              <div
                key={contact.id}
                className="group flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-muted/60 transition-colors"
              >
                <Avatar className="h-10 w-10">
                  <AvatarFallback className={cn("text-white text-sm font-semibold", colorFor(contact.name))}>
                    {getInitials(contact.name)}
                  </AvatarFallback>
                </Avatar>
                <div className="flex-1 min-w-0">
                  <p className="font-medium truncate">{contact.name}</p>
                  <p className="text-xs text-muted-foreground truncate font-mono">{contact.phone_number}</p>
                </div>
                {onCall && (
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-8 w-8 text-success hover:text-success hover:bg-success/10 shrink-0"
                    title="Call"
                    onClick={() => onCall(contact.phone_number)}
                  >
                    <Phone className="h-4 w-4" />
                  </Button>
                )}
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-8 w-8 text-muted-foreground hover:text-destructive shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
                  title="Delete"
                  onClick={() => handleDelete(contact)}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            ))}
          </div>
        )}
      </ScrollArea>

      {/* Add Contact dialog */}
      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <UserPlus className="w-4 h-4 text-primary" />
              Add Contact
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label htmlFor="c-name">Full name</Label>
              <Input id="c-name" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="e.g. Aaron Smith" autoFocus />
            </div>
            <div className="space-y-2">
              <Label htmlFor="c-phone">Phone number</Label>
              <Input id="c-phone" value={newPhone} onChange={(e) => setNewPhone(e.target.value)} placeholder="+1 (555) 123-4567" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="c-email">Email <span className="text-muted-foreground font-normal">(optional)</span></Label>
              <Input id="c-email" type="email" value={newEmail} onChange={(e) => setNewEmail(e.target.value)} placeholder="aaron@example.com" />
            </div>
          </div>
          <DialogFooter className="gap-2 sm:gap-2">
            <Button variant="ghost" onClick={() => setAddOpen(false)}>Cancel</Button>
            <Button onClick={handleAdd} disabled={saving} className="gap-1.5">
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
              Save Contact
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default PersonalContacts;
