import { PanelRightClose } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

interface SidebarModeButtonProps {
  /** Hidden entirely on the web build. */
  available: boolean;
  onClick: () => void;
}

/**
 * Title-bar control that collapses the full app into the docked sidebar strip.
 * The window is only hidden, never closed, so the call session survives.
 */
export const SidebarModeButton = ({ available, onClick }: SidebarModeButtonProps) => {
  if (!available) return null;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          onClick={onClick}
          aria-label="Sidebar mode"
          className="text-muted-foreground hover:text-foreground"
        >
          <PanelRightClose className="w-[18px] h-[18px]" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">Sidebar mode</TooltipContent>
    </Tooltip>
  );
};
