import { useState, useEffect, useRef } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Phone, Delete, Sparkles } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";

interface DialpadProps {
  userId?: string;
  onMakeCall?: (phoneNumber: string, record: boolean) => void;
  accountType?: string;
}

const Dialpad = ({ userId, onMakeCall, accountType }: DialpadProps) => {
  const [phoneNumber, setPhoneNumber] = useState("");
  const [assignedNumber, setAssignedNumber] = useState<string | null>(null);
  const [provider, setProvider] = useState<string>("twilio");
  const [recordCall, setRecordCall] = useState(false);
  const [canMakeCalls, setCanMakeCalls] = useState(true);
  const { toast } = useToast();
  
  // Long press handling for "0" to become "+"
  const longPressTimer = useRef<NodeJS.Timeout | null>(null);
  const isLongPress = useRef(false);

  useEffect(() => {
    if (!userId) return;

    const fetchCallPermission = async () => {
      const { data } = await supabase
        .from("profiles")
        .select("can_make_calls")
        .eq("id", userId)
        .single();
      if (data) setCanMakeCalls(data.can_make_calls !== false);
    };
    fetchCallPermission();

    // Listen for realtime changes to can_make_calls
    const channel = supabase
      .channel(`dialpad-gating-${userId}`)
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "profiles", filter: `id=eq.${userId}` },
        (payload) => {
          if (payload.new && "can_make_calls" in payload.new) {
            setCanMakeCalls(payload.new.can_make_calls !== false);
          }
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [userId]);

  useEffect(() => {
    const fetchAssignedNumber = async () => {
      if (!userId) return;

      const { data, error } = await supabase
        .from('phone_numbers')
        .select('phone_number, provider')
        .eq('assigned_to', userId)
        .eq('is_active', true)
        .maybeSingle();

      if (error) {
        console.error('Error fetching assigned number:', error);
        return;
      }

      if (data) {
        setAssignedNumber(data.phone_number);
        setProvider(data.provider || 'twilio');
      }
    };

    fetchAssignedNumber();
  }, [userId]);

  const dialpadNumbers = [
    ["1", "2", "3"],
    ["4", "5", "6"],
    ["7", "8", "9"],
    ["*", "0", "#"],
  ];

  const handleNumberClick = (num: string) => {
    if (num === "0" && isLongPress.current) {
      return; // Don't add 0 if it was a long press (+ was already added)
    }
    setPhoneNumber((prev) => prev + num);
  };

  const handleLongPressStart = (num: string) => {
    if (num === "0") {
      isLongPress.current = false;
      longPressTimer.current = setTimeout(() => {
        isLongPress.current = true;
        setPhoneNumber((prev) => prev + "+");
      }, 500); // 500ms for long press
    }
  };

  const handleLongPressEnd = (num: string) => {
    if (num === "0" && longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  };

  const handleDelete = () => {
    setPhoneNumber((prev) => prev.slice(0, -1));
  };

  const handleCall = () => {
    if (!phoneNumber) {
      toast({
        title: "Enter a phone number",
        description: "Please enter a valid phone number to call",
        variant: "destructive",
      });
      return;
    }

    if (!canMakeCalls) {
      toast({
        title: "Calls disabled",
        description: "Your subscription does not allow making calls. Please contact your administrator.",
        variant: "destructive",
      });
      return;
    }

    if (!assignedNumber) {
      toast({
        title: "No phone number assigned",
        description: "Please contact admin to assign a phone number to your account",
        variant: "destructive",
      });
      return;
    }

    if (onMakeCall) {
      onMakeCall(phoneNumber, recordCall);
      setPhoneNumber("");
    }
  };

  return (
    <Card className="max-w-md mx-auto border-0 shadow-none">
      <CardHeader className="pb-4">
        <CardTitle className="text-center text-lg">
          {assignedNumber ? (
            <span className="text-sm text-muted-foreground font-normal">
              Calling from: <span className="font-mono">{assignedNumber}</span>
            </span>
          ) : (
            <span className="text-sm text-warning">No number assigned</span>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="relative">
          <Input
            value={phoneNumber}
            onChange={(e) => setPhoneNumber(e.target.value)}
            placeholder="Enter phone number"
            className="text-center text-2xl h-14 pr-12"
          />
          {phoneNumber && (
            <Button
              variant="ghost"
              size="icon"
              className="absolute right-2 top-1/2 -translate-y-1/2"
              onClick={handleDelete}
            >
              <Delete className="w-5 h-5" />
            </Button>
          )}
        </div>

        <div className="grid gap-3">
          {dialpadNumbers.map((row, i) => (
            <div key={i} className="grid grid-cols-3 gap-3">
              {row.map((num) => (
                <Button
                  key={num}
                  variant="outline"
                  size="lg"
                  className="h-16 text-xl font-semibold relative"
                  onClick={() => handleNumberClick(num)}
                  onMouseDown={() => handleLongPressStart(num)}
                  onMouseUp={() => handleLongPressEnd(num)}
                  onMouseLeave={() => handleLongPressEnd(num)}
                  onTouchStart={() => handleLongPressStart(num)}
                  onTouchEnd={() => handleLongPressEnd(num)}
                >
                  <span className="flex flex-col items-center">
                    {num}
                    {num === "0" && (
                      <span className="text-[10px] text-muted-foreground absolute bottom-1">hold for +</span>
                    )}
                  </span>
                </Button>
              ))}
            </div>
          ))}
        </div>

        <div className="space-y-4">
          {accountType === "premium" || accountType === "enterprise" ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <input
                type="checkbox"
                id="recordCall"
                checked={recordCall}
                onChange={(e) => setRecordCall(e.target.checked)}
                className="rounded border-gray-300 cursor-pointer"
              />
              <label htmlFor="recordCall" className="cursor-pointer">
                Record this call
              </label>
            </div>
          ) : (
            <div className="flex items-center gap-2 rounded-lg bg-muted/50 px-3 py-2.5 text-sm">
              <Sparkles className="w-4 h-4 text-primary shrink-0" />
              <span className="text-muted-foreground">
                Call recording is available on{" "}
                <span className="font-medium text-foreground">Premium</span> and above.
              </span>
            </div>
          )}

          <Button
            onClick={handleCall}
            className={`w-full h-14 text-lg ${canMakeCalls ? "bg-success hover:bg-success/90" : "bg-muted text-muted-foreground cursor-not-allowed"}`}
            disabled={!phoneNumber || !assignedNumber || !canMakeCalls}
          >
            <Phone className="w-5 h-5 mr-2" />
            {canMakeCalls ? "Call" : "Subscription Required"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
};

export default Dialpad;
