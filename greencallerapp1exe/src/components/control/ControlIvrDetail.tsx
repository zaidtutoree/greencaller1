import { BarChart3, Building2, Hash, Mic, PhoneForwarded, User, Volume2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { CallAnalytics, type AnalyticsCall } from "./CallAnalytics";
import { RecordingsList } from "./RecordingsList";

export interface ControlIvrOption {
  id: string;
  digit: string;
  label: string;
  department_name?: string | null;
  user_name?: string | null;
}

export interface ControlIvr {
  id: string;
  phone_number: string | null;
  greeting_message: string | null;
  voice: string | null;
  options: ControlIvrOption[];
}

interface ControlIvrDetailProps {
  ivr: ControlIvr;
  /** Inbound calls to the IVR number across the whole company (pre-filtered). */
  calls: AnalyticsCall[];
  /** Every user in the company — recordings on this number can belong to any of them. */
  userIds: string[];
  userNames: Record<string, string>;
}

/** The company's IVR number: how it answers, where each digit routes, and how busy it is. */
export const ControlIvrDetail = ({ ivr, calls, userIds, userNames }: ControlIvrDetailProps) => {
  return (
    <div className="space-y-6">
      <Card className="shadow-none">
        <CardContent className="flex flex-wrap items-center gap-4 p-5">
          <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
            <PhoneForwarded className="h-6 w-6" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="font-display text-xl font-semibold">IVR number</h2>
            <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
              <span className="font-mono">{ivr.phone_number || "No number attached"}</span>
              {ivr.voice && (
                <span className="flex items-center gap-1.5">
                  <Volume2 className="h-3.5 w-3.5" /> {ivr.voice.replace("Polly.", "")}
                </span>
              )}
              <Badge variant="outline" className="font-normal">
                {ivr.options.length} menu option{ivr.options.length === 1 ? "" : "s"}
              </Badge>
            </div>
          </div>
        </CardContent>
      </Card>

      <Tabs defaultValue="analytics" className="space-y-4">
        <TabsList className="h-auto flex-wrap justify-start gap-1 bg-muted/60 p-1">
          <TabsTrigger value="analytics" className="gap-1.5">
            <BarChart3 className="h-3.5 w-3.5" /> Analytics
          </TabsTrigger>
          <TabsTrigger value="menu" className="gap-1.5">
            <Hash className="h-3.5 w-3.5" /> Menu
          </TabsTrigger>
          <TabsTrigger value="recordings" className="gap-1.5">
            <Mic className="h-3.5 w-3.5" /> Recordings
          </TabsTrigger>
        </TabsList>

        <TabsContent value="analytics">
          <CallAnalytics calls={calls} emptyHint="No calls have reached this number yet." />
        </TabsContent>

        <TabsContent value="menu">
          <div className="grid gap-4 lg:grid-cols-[1fr_1.2fr]">
            <Card className="shadow-none">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium">Greeting</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm leading-relaxed text-foreground/90">
                  {ivr.greeting_message ? `“${ivr.greeting_message}”` : "No greeting set."}
                </p>
              </CardContent>
            </Card>
            <Card className="shadow-none">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium">When the caller presses…</CardTitle>
              </CardHeader>
              <CardContent>
                {ivr.options.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No menu options configured.</p>
                ) : (
                  <div className="divide-y">
                    {[...ivr.options]
                      .sort((a, b) => a.digit.localeCompare(b.digit, undefined, { numeric: true }))
                      .map((o) => (
                        <div key={o.id} className="flex items-center gap-3 py-2.5">
                          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-muted font-mono text-sm font-semibold">
                            {o.digit}
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-sm font-medium">{o.label}</div>
                            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                              {o.user_name ? (
                                <>
                                  <User className="h-3 w-3" /> {o.user_name}
                                </>
                              ) : o.department_name ? (
                                <>
                                  <Building2 className="h-3 w-3" /> {o.department_name}
                                </>
                              ) : (
                                "Unrouted"
                              )}
                            </div>
                          </div>
                        </div>
                      ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="recordings">
          <RecordingsList userIds={userIds} matchNumber={ivr.phone_number} userNames={userNames} />
        </TabsContent>
      </Tabs>
    </div>
  );
};

export default ControlIvrDetail;
