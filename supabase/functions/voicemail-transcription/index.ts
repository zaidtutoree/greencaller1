import "https://deno.land/x/xhr@0.1.0/mod.ts";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.81.1?target=deno';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const formData = await req.formData();
    const transcriptionText = formData.get('TranscriptionText');
    const recordingSid = formData.get('RecordingSid');

    console.log('Transcription received:', { recordingSid, text: transcriptionText });

    if (transcriptionText && recordingSid) {
      const { error } = await supabase
        .from('voicemails')
        .update({ transcription: transcriptionText })
        .eq('recording_sid', recordingSid);

      if (error) {
        console.error('Error updating transcription:', error);
      } else {
        console.log('Transcription saved successfully');
      }
    }

    return new Response(null, {
      status: 200,
      headers: corsHeaders,
    });
  } catch (error) {
    console.error('Error processing transcription:', error);
    return new Response(null, {
      status: 500,
      headers: corsHeaders,
    });
  }
});
