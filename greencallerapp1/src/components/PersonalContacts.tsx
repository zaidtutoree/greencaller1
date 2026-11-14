import { useMemo, useState } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Search, Phone, Plus, Trash2, Loader2, UserPlus, Users } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { contactColor, contactInitials, usePersonalContacts, type UserContact } from "@/hooks/usePersonalContacts";
import { AddContactDialog } from "@/components/AddContactDialog";

interface PersonalContactsProps {
  userId?: string;
  onCall?: (phoneNumber: string) => void;
}

/**
 * Single-list personal contacts (basic/premium accounts and the sidebar).
 * Enterprise accounts get the two-pane version inside ContactsView.
 */
export const PersonalContacts = ({ userId, onCall }: PersonalContactsProps) => {
  const { toast } = useToast();
  const { contacts, loading, addContact, deleteContact } = usePersonalContacts(userId);
  const [search, setSearch] = useState("");
  const [addOpen, setAddOpen] = useState(false);

  const handleDelete = async (contact: UserContact) => {
    const { error } = await deleteContact(contact.id);
    if (error) {
      toast({ title: "Error", description: "Failed to delete contact", variant: "destructive" });
      return;
    }
    toast({ title: "Contact deleted" });
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
                  <AvatarFallback className={cn("text-white text-sm font-semibold", contactColor(contact.name))}>
                    {contactInitials(contact.name)}
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

      <AddContactDialog open={addOpen} onOpenChange={setAddOpen} onAdd={addContact} />
    </div>
  );
};

export default PersonalContacts;
