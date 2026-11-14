import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Map Polly voices to OpenAI TTS voices
const voiceMapping: Record<string, string> = {
  'Polly.Amy-Neural': 'nova',      // British female, warm
  'Polly.Emma-Neural': 'shimmer',  // British female, friendly
  'Polly.Brian-Neural': 'onyx',    // British male, authoritative
  'Polly.Arthur-Neural': 'echo',   // British male, distinguished
  'Polly.Joanna-Neural': 'alloy',  // US female, professional
  'Polly.Matthew-Neural': 'fable', // US male, confident
  'Polly.Amy': 'nova',
  'Polly.Emma': 'shimmer',
};

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { voice, text } = await req.json();
    
    const openAIApiKey = Deno.env.get('OPENAI_API_KEY');
    if (!openAIApiKey) {
      throw new Error('OpenAI API key not configured');
    }

    // Get the OpenAI voice equivalent
    const openAIVoice = voiceMapping[voice] || 'nova';
    const previewText = text || "Hello, thank you for calling. How may I assist you today?";

    console.log('Generating voice preview:', { voice, openAIVoice, textLength: previewText.length });

    const response = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${openAIApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'tts-1',
        input: previewText,
        voice: openAIVoice,
        response_format: 'mp3',
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      console.error('OpenAI TTS error:', error);
      throw new Error(`Failed to generate speech: ${error}`);
    }

    // Get the audio as array buffer and convert to base64
    const arrayBuffer = await response.arrayBuffer();
    const base64Audio = btoa(
      String.fromCharCode(...new Uint8Array(arrayBuffer))
    );

    return new Response(
      JSON.stringify({ audioContent: base64Audio }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );
  } catch (error) {
    console.error('Error in preview-voice:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return new Response(
      JSON.stringify({ error: errorMessage }),
      {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );
  }
});
