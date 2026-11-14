import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Grid3X3 } from "lucide-react";
import { cn } from "@/lib/utils";

interface InCallKeypadProps {
  onSendDtmf: (digit: string) => void;
  variant?: "panel" | "modal";
}

const dialpadNumbers = [
  ["1", "2", "3"],
  ["4", "5", "6"],
  ["7", "8", "9"],
  ["*", "0", "#"],
];

export const InCallKeypad = ({ onSendDtmf, variant = "panel" }: InCallKeypadProps) => {
  const [open, setOpen] = useState(false);
  const [lastPressed, setLastPressed] = useState<string | null>(null);

  const handlePress = (digit: string) => {
    onSendDtmf(digit);
    setLastPressed(digit);
    setTimeout(() => setLastPressed(null), 150);
  };

  const keypadContent = (
    <div className="grid gap-2 p-2">
      {dialpadNumbers.map((row, i) => (
        <div key={i} className="grid grid-cols-3 gap-2">
          {row.map((num) => (
            <Button
              key={num}
              variant="outline"
              size="lg"
              className={cn(
                "h-14 text-xl font-semibold transition-all bg-muted border-border text-foreground hover:bg-accent",
                lastPressed === num && "scale-95 bg-primary text-primary-foreground"
              )}
              onClick={() => handlePress(num)}
            >
              {num}
            </Button>
          ))}
        </div>
      ))}
    </div>
  );

  if (variant === "modal") {
    return (
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger asChild>
          <button className="flex flex-col items-center gap-1.5 p-1.5 rounded-xl transition-all duration-200 hover:bg-white/10 active:scale-95">
            <div className="w-9 h-9 rounded-full flex items-center justify-center bg-white/15 text-white">
              <Grid3X3 className="w-4 h-4" />
            </div>
            <span className="text-white/80 text-[10px] font-medium">Keypad</span>
          </button>
        </DialogTrigger>
        <DialogContent className="sm:max-w-[280px]">
          <DialogHeader>
            <DialogTitle>Keypad</DialogTitle>
          </DialogHeader>
          {keypadContent}
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button
          className="flex flex-col items-center gap-2 p-3 rounded-xl transition-all duration-200 bg-muted hover:bg-muted/80"
        >
          <div className="w-12 h-12 rounded-full flex items-center justify-center bg-background">
            <Grid3X3 className="w-5 h-5" />
          </div>
          <span className="text-xs font-medium">Keypad</span>
        </button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[280px]">
        <DialogHeader>
          <DialogTitle>Keypad</DialogTitle>
        </DialogHeader>
        {keypadContent}
      </DialogContent>
    </Dialog>
  );
};
