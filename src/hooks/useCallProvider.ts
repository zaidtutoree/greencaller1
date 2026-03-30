import { useActiveCall as useTwilioCall } from "./useActiveCall";
import { useTelnyxCall } from "./useTelnyxCall";

interface UseCallProviderProps {
  userId?: string;
  assignedNumber?: string | null;
  provider?: string;
}

/**
 * Unified hook that selects between Twilio and Telnyx based on provider
 * This provides a consistent API regardless of the underlying provider
 */
export const useCallProvider = ({ userId, assignedNumber, provider }: UseCallProviderProps) => {
  const isTelnyx = provider === "telnyx";
  const isTwilio = provider === "twilio";
  const isProviderResolved = isTelnyx || isTwilio;
  
  // Only initialize the selected provider. Avoid booting Twilio by default before
  // the real provider has been fetched (prevents client overlap + rapid hangups).
  const telnyxCall = useTelnyxCall({ userId, assignedNumber, enabled: isTelnyx });
  const twilioCall = useTwilioCall({ userId, assignedNumber, provider: isTwilio ? "twilio" : "telnyx" });

  const noop = async () => {
    // Intentionally empty: provider not yet resolved.
  };

  if (!isProviderResolved) {
    return {
      callState: {
        isActive: false,
        phoneNumber: "",
        duration: 0,
        isMuted: false,
        isOnHold: false,
        isRecording: false,
        isPaused: false,
        conferenceName: null,
        callSid: null,
      },
      incomingCall: { isIncoming: false, isDismissed: false, phoneNumber: "", call: null },
      makeCall: noop,
      endCall: noop,
      toggleMute: noop,
      toggleHold: noop,
      toggleRecording: noop,
      transferCall: noop,
      pickupQueuedCall: noop,
      setCallState: () => {},
      answerIncomingCall: noop,
      declineIncomingCall: noop,
      dismissIncomingCall: () => {},
      restoreIncomingCall: () => {},
      sendToVoicemail: noop,
      sendIncomingToVoicemail: noop,
      sendDtmf: () => {},
      isClientReady: false,
      isRegistrationStale: false,
      provider: "twilio" as const,
    };
  }

  // Return the appropriate hook based on provider
  if (isTelnyx) {
    return {
      callState: telnyxCall.callState,
      incomingCall: telnyxCall.incomingCall,
      makeCall: telnyxCall.makeCall,
      endCall: telnyxCall.endCall,
      toggleMute: telnyxCall.toggleMute,
      toggleHold: telnyxCall.toggleHold,
      toggleRecording: telnyxCall.toggleRecording,
      transferCall: telnyxCall.transferCall,
      pickupQueuedCall: telnyxCall.pickupQueuedCall,
      setCallState: telnyxCall.setCallState,
      answerIncomingCall: telnyxCall.answerIncomingCall,
      declineIncomingCall: telnyxCall.declineIncomingCall,
      dismissIncomingCall: telnyxCall.dismissIncomingCall,
      restoreIncomingCall: telnyxCall.restoreIncomingCall,
      sendToVoicemail: telnyxCall.sendToVoicemail,
      sendIncomingToVoicemail: telnyxCall.sendIncomingToVoicemail,
      sendDtmf: telnyxCall.sendDtmf,
      isClientReady: telnyxCall.isClientReady,
      isRegistrationStale: telnyxCall.isRegistrationStale,
      provider: "telnyx" as const,
    };
  }

  // Default to Twilio
  return {
    callState: twilioCall.callState,
    incomingCall: twilioCall.incomingCall,
    makeCall: twilioCall.makeCall,
    endCall: twilioCall.endCall,
    toggleMute: twilioCall.toggleMute,
    toggleHold: twilioCall.toggleHold,
    toggleRecording: twilioCall.toggleRecording,
    transferCall: twilioCall.transferCall,
    pickupQueuedCall: twilioCall.pickupQueuedCall,
    setCallState: twilioCall.setCallState,
    answerIncomingCall: twilioCall.answerIncomingCall,
    declineIncomingCall: twilioCall.declineIncomingCall,
    dismissIncomingCall: twilioCall.dismissIncomingCall,
    restoreIncomingCall: twilioCall.restoreIncomingCall,
    sendToVoicemail: twilioCall.sendToVoicemail,
    sendIncomingToVoicemail: noop, // Telnyx-specific
    sendDtmf: twilioCall.sendDtmf,
    isClientReady: true, // Twilio uses deviceRef internally
    isRegistrationStale: false,
    provider: "twilio" as const,
  };
};
