import { useState, useRef, useEffect, useCallback } from "react";
import { Device } from "@twilio/voice-sdk";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";

interface ActiveCallState {
  isActive: boolean;
  phoneNumber: string;
  callerName?: string;
  callerCompany?: string;
  duration: number;
  isMuted: boolean;
  isOnHold: boolean;
  isRecording: boolean;
  isPaused: boolean;
  conferenceName: string | null;
  callSid: string | null;
}

interface IncomingCallState {
  isIncoming: boolean;
  isDismissed: boolean;
  phoneNumber: string;
  callerName?: string;
  call: any | null;
}

interface UseActiveCallProps {
  userId?: string;
  assignedNumber?: string | null;
  provider?: string;
}

export const useActiveCall = ({ userId, assignedNumber, provider = "twilio" }: UseActiveCallProps) => {
  const { toast } = useToast();
  const deviceRef = useRef<Device | null>(null);
  const activeCallRef = useRef<any>(null);
  const callIntervalRef = useRef<number | null>(null);

  const [callState, setCallState] = useState<ActiveCallState>({
    isActive: false,
    phoneNumber: "",
    duration: 0,
    isMuted: false,
    isOnHold: false,
    isRecording: false,
    isPaused: false,
    conferenceName: null,
    callSid: null,
  });

  const [incomingCall, setIncomingCall] = useState<IncomingCallState>({
    isIncoming: false,
    isDismissed: false,
    phoneNumber: "",
    call: null,
  });

  // Initialize Twilio Device (only when provider is NOT telnyx)
  useEffect(() => {
    // If we switched to Telnyx, ensure Twilio is fully torn down.
    if (provider === "telnyx") {
      if (deviceRef.current) {
        try {
          deviceRef.current.destroy();
        } catch {
          // ignore
        }
        deviceRef.current = null;
      }
      return;
    }

    let cancelled = false;

    const initializeTwilioDevice = async () => {
      try {
        const { data, error } = await supabase.functions.invoke("generate-token");

        if (error) {
          console.error("Error getting Twilio token:", error);
          return;
        }

        if (cancelled) return;

        const device = new Device(data.token, { logLevel: 1 });

        device.on("registered", () => {
          console.log("Twilio Device registered");
        });

        device.on("error", (error) => {
          console.error("Twilio Device error:", error);
        });

        device.on("incoming", (call) => {
          console.log("Incoming call from:", call.parameters.From);

          // Set incoming call state to show the modal
          setIncomingCall({
            isIncoming: true,
            isDismissed: false,
            phoneNumber: call.parameters.From || "Unknown",
            call: call,
          });

          // Handle call events
          call.on("cancel", () => {
            console.log("Incoming call cancelled");
            setIncomingCall({ isIncoming: false, isDismissed: false, phoneNumber: "", call: null });
          });

          call.on("disconnect", () => {
            console.log("Incoming call disconnected");
            setIncomingCall({ isIncoming: false, isDismissed: false, phoneNumber: "", call: null });
          });
        });

        await device.register();

        if (cancelled) {
          try {
            device.destroy();
          } catch {
            // ignore
          }
          return;
        }

        deviceRef.current = device;
      } catch (error) {
        console.error("Error initializing Twilio device:", error);
      }
    };

    initializeTwilioDevice();

    return () => {
      cancelled = true;
      if (deviceRef.current) {
        try {
          deviceRef.current.destroy();
        } catch {
          // ignore
        }
        deviceRef.current = null;
      }
    };
  }, [provider]);

  const startDurationTimer = useCallback(() => {
    if (callIntervalRef.current) {
      clearInterval(callIntervalRef.current);
    }
    callIntervalRef.current = window.setInterval(() => {
      setCallState((prev) => ({ ...prev, duration: prev.duration + 1 }));
    }, 1000);
  }, []);

  const stopDurationTimer = useCallback(() => {
    if (callIntervalRef.current) {
      clearInterval(callIntervalRef.current);
      callIntervalRef.current = null;
    }
  }, []);

  const makeCall = useCallback(
    async (toNumber: string, record: boolean = false) => {
      if (!assignedNumber) {
        toast({
          title: "No phone number assigned",
          description: "Please contact admin to assign a phone number",
          variant: "destructive",
        });
        return;
      }

      // For Twilio, we need the device to be ready
      if (provider === "twilio" && !deviceRef.current) {
        toast({
          title: "Device not ready",
          description: "Please wait for the device to initialize",
          variant: "destructive",
        });
        return;
      }

      try {
        setCallState((prev) => ({
          ...prev,
          isActive: true,
          phoneNumber: toNumber,
          isRecording: record,
        }));

        toast({
          title: "Initiating call...",
          description: `Calling ${toNumber} from ${assignedNumber}`,
        });

        // Use different edge functions based on provider
        const functionName = provider === "telnyx" ? "telnyx-make-call" : "make-call";
        
        const { data, error } = await supabase.functions.invoke(functionName, {
          body: {
            toNumber,
            fromNumber: assignedNumber,
            userId,
            record,
          },
        });

        if (error) throw error;
        if (!data.success) throw new Error(data.error || "Failed to initiate call");

        // For Telnyx, we use callControlId instead of conferenceName
        if (provider === "telnyx") {
          setCallState((prev) => ({
            ...prev,
            callSid: data.callControlId,
            conferenceName: null,
          }));
          
          // Telnyx calls are managed server-side, just start the timer
          startDurationTimer();
          
          toast({ 
            title: "Call initiated", 
            description: `Calling ${toNumber} via Telnyx` 
          });
        } else {
          // Twilio flow - connect via device
          setCallState((prev) => ({
            ...prev,
            conferenceName: data.conferenceName,
            callSid: data.callSid,
          }));

          const call = await deviceRef.current!.connect({
            params: {
              conferenceName: data.conferenceName,
              isAgent: "true",
            },
          });

          activeCallRef.current = call;

          call.on("accept", () => {
            toast({ title: "Connected", description: `Speaking with ${toNumber}` });
            startDurationTimer();
          });

          call.on("disconnect", () => {
            setCallState({
              isActive: false,
              phoneNumber: "",
              duration: 0,
              isMuted: false,
              isOnHold: false,
              isRecording: false,
              isPaused: false,
              conferenceName: null,
              callSid: null,
            });
            stopDurationTimer();
            activeCallRef.current = null;
          });
        }
      } catch (error: any) {
        console.error("Error making call:", error);
        setCallState({
          isActive: false,
          phoneNumber: "",
          duration: 0,
          isMuted: false,
          isOnHold: false,
          isRecording: false,
          isPaused: false,
          conferenceName: null,
          callSid: null,
        });
        toast({
          title: "Call failed",
          description: error.message || "Failed to initiate call.",
          variant: "destructive",
        });
      }
    },
    [assignedNumber, userId, provider, startDurationTimer, stopDurationTimer, toast]
  );

  const endCall = useCallback(async () => {
    // Capture the current state before clearing
    const finalDuration = callState.duration;
    const finalPhoneNumber = callState.phoneNumber;

    // Disconnect the local Twilio device call
    if (activeCallRef.current) {
      try {
        activeCallRef.current.disconnect();
      } catch (e) {
        console.warn("Disconnect error (ignored):", e);
      }
    }

    // Cancel the outbound call if it exists (this stops the ringing)
    if (callState.callSid) {
      try {
        await supabase.functions.invoke("cancel-call", {
          body: { callSid: callState.callSid },
        });
      } catch (e) {
        console.warn("Failed to cancel call server-side:", e);
      }
    }

    // Also end the conference if it exists
    if (callState.conferenceName) {
      try {
        await supabase.functions.invoke("end-conference", {
          body: { conferenceName: callState.conferenceName },
        });
      } catch (e) {
        console.warn("Failed to end conference server-side:", e);
      }
    }

    // Note: Duration is updated via Twilio's StatusCallback to call-events edge function

    stopDurationTimer();

    toast({
      title: "Call ended",
      description: `Duration: ${Math.floor(finalDuration / 60)}:${(
        finalDuration % 60
      )
        .toString()
        .padStart(2, "0")}`,
    });

    setCallState({
      isActive: false,
      phoneNumber: "",
      duration: 0,
      isMuted: false,
      isOnHold: false,
      isRecording: false,
      isPaused: false,
      conferenceName: null,
      callSid: null,
    });
  }, [callState.callSid, callState.conferenceName, callState.duration, callState.phoneNumber, userId, assignedNumber, stopDurationTimer, toast]);

  const toggleMute = useCallback(() => {
    if (activeCallRef.current) {
      const newMuted = !callState.isMuted;
      activeCallRef.current.mute(newMuted);
      setCallState((prev) => ({ ...prev, isMuted: newMuted }));
      toast({
        title: newMuted ? "Muted" : "Unmuted",
        description: newMuted ? "Microphone is now off" : "Microphone is now on",
      });
    }
  }, [callState.isMuted, toast]);

  const toggleHold = useCallback(async () => {
    if (!callState.conferenceName || !callState.callSid || !callState.isActive) {
      toast({
        title: "Cannot toggle hold",
        description: "No active call to hold",
        variant: "destructive",
      });
      return;
    }

    const newHoldState = !callState.isOnHold;

    try {
      const { data, error } = await supabase.functions.invoke("hold-call", {
        body: {
          conferenceName: callState.conferenceName,
          callSid: callState.callSid,
          hold: newHoldState,
        },
      });

      if (error) throw error;
      if (!data.success) throw new Error(data.error || "Failed to toggle hold");

      setCallState((prev) => ({ ...prev, isOnHold: newHoldState }));
      toast({
        title: newHoldState ? "Call On Hold" : "Call Resumed",
        description: newHoldState 
          ? "Caller is now hearing hold music" 
          : "Call has been resumed",
      });
    } catch (error: any) {
      console.error("Error toggling hold:", error);
      toast({
        title: "Hold failed",
        description: error.message || "Failed to toggle hold",
        variant: "destructive",
      });
    }
  }, [callState.conferenceName, callState.callSid, callState.isActive, callState.isOnHold, toast]);

  const toggleRecording = useCallback(async () => {
    if (!callState.conferenceName || !callState.isActive) return;

    try {
      // If not recording, start recording
      if (!callState.isRecording) {
        toast({ title: "Starting recording..." });
        
        const { data, error } = await supabase.functions.invoke("start-recording", {
          body: { 
            conferenceName: callState.conferenceName,
            userId,
            fromNumber: assignedNumber,
            toNumber: callState.phoneNumber,
          },
        });
        
        if (error) throw error;
        if (!data?.success) throw new Error(data?.error || "Failed to start recording");
        
        setCallState((prev) => ({ ...prev, isRecording: true, isPaused: false }));
        toast({ 
          title: data.alreadyRecording ? "Recording in progress" : "Recording Started" 
        });
        return;
      }

      // If recording and not paused, pause it
      if (!callState.isPaused) {
        const { data, error } = await supabase.functions.invoke("pause-recording", {
          body: { conferenceName: callState.conferenceName },
        });
        
        if (error) throw error;
        if (!data?.success) {
          console.log("No active recording to pause, updating state only");
        }
        
        setCallState((prev) => ({ ...prev, isPaused: true }));
        toast({ title: "Recording Paused" });
      } else {
        // If paused, resume recording
        const { data, error } = await supabase.functions.invoke("resume-recording", {
          body: { conferenceName: callState.conferenceName },
        });
        
        if (error) throw error;
        if (!data?.success) {
          console.log("No paused recording to resume, updating state only");
        }
        
        setCallState((prev) => ({ ...prev, isPaused: false }));
        toast({ title: "Recording Resumed" });
      }
    } catch (error: any) {
      console.error("Error toggling recording:", error);
      // Don't show error toast for "No active recording" - just update state
      if (error?.message?.includes("No active recording")) {
        setCallState((prev) => ({ ...prev, isRecording: false, isPaused: false }));
        toast({
          title: "Recording Not Available",
          description: "No active recording for this call",
        });
      } else {
        toast({
          title: "Error",
          description: error?.message || "Failed to toggle recording",
          variant: "destructive",
        });
      }
    }
  }, [callState.conferenceName, callState.isActive, callState.isRecording, callState.isPaused, callState.phoneNumber, userId, assignedNumber, toast]);

  const transferCall = useCallback(
    async (targetId: string, targetType: "user" | "department") => {
      if (!callState.isActive) return;

      try {
        // Get target phone number
        let targetNumber: string | null = null;
        let companyName: string | null = null;

        if (targetType === "user") {
          const { data: phoneData } = await supabase
            .from("phone_numbers")
            .select("phone_number")
            .eq("assigned_to", targetId)
            .eq("is_active", true)
            .single();

          targetNumber = phoneData?.phone_number || null;
        } else {
          const { data: deptData } = await supabase
            .from("departments")
            .select("phone_number_id, company_name")
            .eq("id", targetId)
            .single();

          companyName = deptData?.company_name || null;

          if (deptData?.phone_number_id) {
            const { data: phoneData } = await supabase
              .from("phone_numbers")
              .select("phone_number")
              .eq("id", deptData.phone_number_id)
              .single();

            targetNumber = phoneData?.phone_number || null;
          }
        }

        toast({
          title: "Transferring call...",
          description: targetType === "department" 
            ? "Adding to department queue" 
            : `Transferring to ${targetNumber}`,
        });

        const { data, error } = await supabase.functions.invoke("transfer-call", {
          body: {
            callSid: callState.callSid,
            conferenceName: callState.conferenceName,
            targetId,
            targetType,
            targetNumber,
            fromNumber: callState.phoneNumber,
            companyName,
          },
        });

        if (error) throw error;
        if (!data.success) throw new Error(data.error || "Transfer failed");

        toast({
          title: "Transfer initiated",
          description: targetType === "department" 
            ? `Call transferred to ${data.departmentName || 'department'} - caller will hear greeting`
            : "Call is being transferred",
        });

        // If transferring to department, disconnect the agent's call
        if (data.disconnectAgent && activeCallRef.current) {
          console.log("Disconnecting agent after department transfer");
          try {
            activeCallRef.current.disconnect();
          } catch (e) {
            console.warn("Disconnect error (ignored):", e);
          }
          
          stopDurationTimer();
          setCallState({
            isActive: false,
            phoneNumber: "",
            duration: 0,
            isMuted: false,
            isOnHold: false,
            isRecording: false,
            isPaused: false,
            conferenceName: null,
            callSid: null,
          });
          activeCallRef.current = null;
        }
      } catch (error: any) {
        console.error("Error transferring call:", error);
        toast({
          title: "Transfer failed",
          description: error.message || "Failed to transfer call",
          variant: "destructive",
        });
      }
    },
    [callState.isActive, callState.conferenceName, callState.callSid, callState.phoneNumber, stopDurationTimer, toast]
  );

  // Pick up a queued call from the switchboard
  const pickupQueuedCall = useCallback(
    async (callInfo: { phoneNumber: string; conferenceName: string; callSid: string }) => {
      if (!deviceRef.current) {
        toast({
          title: "Device not ready",
          description: "Please wait for the device to initialize",
          variant: "destructive",
        });
        return;
      }

      try {
        setCallState((prev) => ({
          ...prev,
          isActive: true,
          phoneNumber: callInfo.phoneNumber,
          conferenceName: callInfo.conferenceName,
          callSid: callInfo.callSid,
        }));

        const call = await deviceRef.current.connect({
          params: {
            conferenceName: callInfo.conferenceName,
            isAgent: "true",
          },
        });

        activeCallRef.current = call;

        call.on("accept", () => {
          toast({ title: "Connected", description: `Speaking with ${callInfo.phoneNumber}` });
          startDurationTimer();
        });

        call.on("disconnect", () => {
          setCallState({
            isActive: false,
            phoneNumber: "",
            duration: 0,
            isMuted: false,
            isOnHold: false,
            isRecording: false,
            isPaused: false,
            conferenceName: null,
            callSid: null,
          });
          stopDurationTimer();
          activeCallRef.current = null;
        });
      } catch (error: any) {
        console.error("Error picking up queued call:", error);
        setCallState({
          isActive: false,
          phoneNumber: "",
          duration: 0,
          isMuted: false,
          isOnHold: false,
          isRecording: false,
          isPaused: false,
          conferenceName: null,
          callSid: null,
        });
        toast({
          title: "Pickup failed",
          description: error.message || "Failed to connect to call",
          variant: "destructive",
        });
      }
    },
    [startDurationTimer, stopDurationTimer, toast]
  );

  const sendToVoicemail = useCallback(async () => {
    if (!callState.conferenceName || !callState.isActive) return;

    try {
      toast({
        title: "Sending to voicemail...",
      });

      const { data, error } = await supabase.functions.invoke("send-to-voicemail", {
        body: {
          callSid: callState.callSid,
          conferenceName: callState.conferenceName,
          toNumber: assignedNumber,
          fromNumber: callState.phoneNumber, // Pass original caller's number
        },
      });

      if (error) throw error;
      if (!data.success) throw new Error(data.error || "Failed to send to voicemail");

      toast({
        title: "Sent to voicemail",
        description: "Caller is now leaving a voicemail",
      });

      // Disconnect the agent's call
      if (data.disconnectAgent && activeCallRef.current) {
        try {
          activeCallRef.current.disconnect();
        } catch (e) {
          console.warn("Disconnect error (ignored):", e);
        }
        
        stopDurationTimer();
        setCallState({
          isActive: false,
          phoneNumber: "",
          duration: 0,
          isMuted: false,
          isOnHold: false,
          isRecording: false,
          isPaused: false,
          conferenceName: null,
          callSid: null,
        });
        activeCallRef.current = null;
      }
    } catch (error: any) {
      console.error("Error sending to voicemail:", error);
      toast({
        title: "Failed to send to voicemail",
        description: error.message || "Something went wrong",
        variant: "destructive",
      });
    }
  }, [callState.conferenceName, callState.isActive, callState.callSid, assignedNumber, stopDurationTimer, toast]);

  // Answer an incoming call
  const answerIncomingCall = useCallback(async () => {
    if (!incomingCall.call) return;

    // Guard: ensure the Twilio Device is still alive – if it was destroyed
    // (e.g. token refresh / reconnect) the call object is stale and accept()
    // would crash with "Cannot read properties of null (reading 'getTransceivers')".
    if (!deviceRef.current) {
      toast({
        title: "Phone not ready",
        description: "Please wait a moment and try again, or refresh the page",
        variant: "destructive",
      });
      setIncomingCall({ isIncoming: false, isDismissed: false, phoneNumber: "", call: null });
      return;
    }

    try {
      // Register event handlers BEFORE accept() to avoid race conditions
      // where the event fires before the listener is attached.
      incomingCall.call.on("accept", () => {
        toast({ title: "Connected", description: `Speaking with ${incomingCall.phoneNumber}` });
        startDurationTimer();
      });

      incomingCall.call.on("disconnect", () => {
        setCallState({
          isActive: false,
          phoneNumber: "",
          duration: 0,
          isMuted: false,
          isOnHold: false,
          isRecording: false,
          isPaused: false,
          conferenceName: null,
          callSid: null,
        });
        stopDurationTimer();
        activeCallRef.current = null;
      });

      await incomingCall.call.accept();
      activeCallRef.current = incomingCall.call;

      setCallState((prev) => ({
        ...prev,
        isActive: true,
        phoneNumber: incomingCall.phoneNumber,
      }));

      setIncomingCall({ isIncoming: false, isDismissed: false, phoneNumber: "", call: null });
    } catch (error: any) {
      console.error("Error answering call:", error);
      toast({
        title: "Failed to answer",
        description: error.message || "Could not connect to call",
        variant: "destructive",
      });
      setIncomingCall({ isIncoming: false, isDismissed: false, phoneNumber: "", call: null });
    }
  }, [incomingCall, startDurationTimer, stopDurationTimer, toast]);

  // Decline an incoming call
  const declineIncomingCall = useCallback(() => {
    if (incomingCall.call) {
      incomingCall.call.reject();
    }
    setIncomingCall({ isIncoming: false, isDismissed: false, phoneNumber: "", call: null });
    toast({ title: "Call declined" });
  }, [incomingCall, toast]);

  // Dismiss the incoming call modal without declining (just hide and mute)
  const dismissIncomingCall = useCallback(() => {
    setIncomingCall((prev) => ({ ...prev, isIncoming: false, isDismissed: true }));
    // The call is still active, just hidden - caller keeps ringing on their end
  }, []);

  // Restore the dismissed incoming call modal
  const restoreIncomingCall = useCallback(() => {
    setIncomingCall((prev) => ({ ...prev, isIncoming: true, isDismissed: false }));
  }, []);

  // Send DTMF tones during active call
  const sendDtmf = useCallback((digit: string) => {
    if (activeCallRef.current) {
      activeCallRef.current.sendDigits(digit);
      console.log(`Sent DTMF tone: ${digit}`);
    } else {
      console.warn("No active call to send DTMF");
    }
  }, []);

  return {
    callState,
    incomingCall,
    makeCall,
    endCall,
    toggleMute,
    toggleHold,
    toggleRecording,
    transferCall,
    pickupQueuedCall,
    setCallState,
    answerIncomingCall,
    declineIncomingCall,
    dismissIncomingCall,
    restoreIncomingCall,
    sendToVoicemail,
    sendDtmf,
  };
};
