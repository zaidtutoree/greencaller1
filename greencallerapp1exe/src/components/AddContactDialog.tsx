import { useState } from "react";
import { Loader2, Plus, UserPlus } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import type { NewContact } from "@/hooks/usePersonalContacts";

interface AddContactDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAdd: (c: NewContact) => Promise<{ error: { message?: string } | null }>;
  /** Fit the dialog to a narrow window (Sidebar Mode). */
  compact?: boolean;
}

/** "Add contact" form shared by every personal-contacts surface. */
export const AddContactDialog = ({ open, onOpenChange, onAdd, compact = false }: AddContactDialogProps) => {
  const { toast } = useToast();
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");

  const reset = () => {
    setName("");
    setPhone("");
    setEmail("");
  };

  const submit = async () => {
    if (!name.trim() || !phone.trim()) {
      toast({
        title: "Name and phone required",
        description: "Please enter both a name and a phone number.",
        variant: "destructive",
      });
      return;
    }
    setSaving(true);
    const { error } = await onAdd({ name, phone_number: phone, email });
    setSaving(false);
    if (error) {
      toast({ title: "Error", description: error.message || "Failed to add contact", variant: "destructive" });
      return;
    }
    toast({ title: "Contact added" });
    reset();
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={compact ? "w-[calc(100vw-1.5rem)] max-w-[calc(100vw-1.5rem)] rounded-lg p-4" : "sm:max-w-md"}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <UserPlus className="w-4 h-4 text-primary" />
            Add Contact
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label htmlFor="c-name">Full name</Label>
            <Input id="c-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Aaron Smith" autoFocus />
          </div>
          <div className="space-y-2">
            <Label htmlFor="c-phone">Phone number</Label>
            <Input id="c-phone" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+44 7700 900123" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="c-email">
              Email <span className="text-muted-foreground font-normal">(optional)</span>
            </Label>
            <Input id="c-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="aaron@example.com" />
          </div>
        </div>
        <DialogFooter className="gap-2 sm:gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={saving} className="gap-1.5">
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
            Save Contact
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default AddContactDialog;
