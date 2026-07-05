import { useState } from "react";
import { User, Users } from "lucide-react";
import { cn } from "@/lib/utils";
import { PersonalContacts } from "@/components/PersonalContacts";
import { Contacts } from "@/components/Contacts";

interface ContactsViewProps {
  userId?: string;
  onCall?: (phoneNumber: string) => void;
}

type ContactsMode = "contacts" | "teammates";

/**
 * Enterprise Contacts area with a two-choice toggle:
 *  - "Contacts"  → the user's personal contacts (user_contacts, synced with mobile)
 *  - "Teammates" → the company directory (existing Contacts component)
 */
export const ContactsView = ({ userId, onCall }: ContactsViewProps) => {
  const [mode, setMode] = useState<ContactsMode>("contacts");

  return (
    <div className="flex flex-col h-full">
      {/* Segmented toggle */}
      <div className="flex items-center justify-center border-b border-border p-3">
        <div className="inline-flex items-center gap-1 rounded-lg bg-muted p-1">
          <button
            onClick={() => setMode("contacts")}
            className={cn(
              "flex items-center gap-2 rounded-md px-4 py-1.5 text-sm font-medium transition-colors",
              mode === "contacts" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
            )}
          >
            <User className="w-4 h-4" />
            Contacts
          </button>
          <button
            onClick={() => setMode("teammates")}
            className={cn(
              "flex items-center gap-2 rounded-md px-4 py-1.5 text-sm font-medium transition-colors",
              mode === "teammates" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Users className="w-4 h-4" />
            Teammates
          </button>
        </div>
      </div>

      {/* Active view */}
      <div className="flex-1 min-h-0">
        {mode === "contacts" ? (
          <PersonalContacts userId={userId} onCall={onCall} />
        ) : (
          <Contacts userId={userId} onCall={onCall} />
        )}
      </div>
    </div>
  );
};

export default ContactsView;
