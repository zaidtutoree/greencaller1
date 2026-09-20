import { useState } from "react";
import { User, Users } from "lucide-react";
import { cn } from "@/lib/utils";
import { PersonalContacts } from "@/components/PersonalContacts";
import { Contacts } from "@/components/Contacts";

interface ContactsViewProps {
  userId?: string;
  onCall?: (phoneNumber: string) => void;
  /** Narrow single-column layout (Sidebar Mode's slide-out panel). */
  compact?: boolean;
}

type ContactsMode = "contacts" | "teammates";

/**
 * Enterprise Contacts area with a two-choice toggle:
 *  - "Contacts"  → the user's personal contacts (user_contacts, synced with mobile)
 *  - "Teammates" → the company directory (existing Contacts component)
 */
export const ContactsView = ({ userId, onCall, compact = false }: ContactsViewProps) => {
  const [mode, setMode] = useState<ContactsMode>("contacts");

  const tabClass = (active: boolean) =>
    cn(
      "flex items-center gap-2 rounded-md font-medium transition-colors",
      compact ? "px-3 py-1 text-xs" : "px-4 py-1.5 text-sm",
      active ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
    );

  return (
    <div className="flex flex-col h-full">
      {/* Segmented toggle */}
      <div className={cn("flex items-center justify-center border-b border-border", compact ? "p-2" : "p-3")}>
        <div className={cn("inline-flex items-center gap-1 rounded-lg bg-muted", compact ? "p-0.5" : "p-1")}>
          <button onClick={() => setMode("contacts")} className={tabClass(mode === "contacts")}>
            <User className={compact ? "w-3.5 h-3.5" : "w-4 h-4"} />
            Contacts
          </button>
          <button onClick={() => setMode("teammates")} className={tabClass(mode === "teammates")}>
            <Users className={compact ? "w-3.5 h-3.5" : "w-4 h-4"} />
            Teammates
          </button>
        </div>
      </div>

      {/* Active view */}
      <div className="flex-1 min-h-0">
        {mode === "contacts" ? (
          <PersonalContacts userId={userId} onCall={onCall} />
        ) : (
          <Contacts userId={userId} onCall={onCall} compact={compact} />
        )}
      </div>
    </div>
  );
};

export default ContactsView;
