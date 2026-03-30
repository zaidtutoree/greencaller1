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
    const { recordingId } = await req.json();

    if (!recordingId) {
      throw new Error('Recording ID is required');
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    // Get recording details
    const { data: recording, error: fetchError } = await supabase
      .from('call_recordings')
      .select('*')
      .eq('id', recordingId)
      .single();

    if (fetchError || !recording) {
      throw new Error('Recording not found');
    }

    // Download the audio file
    const audioUrl = recording.recording_url;
    console.log('Downloading audio from:', audioUrl);

    const audioResponse = await fetch(audioUrl);
    if (!audioResponse.ok) {
      throw new Error('Failed to download audio file');
    }

    const audioBlob = await audioResponse.blob();
    console.log('Audio downloaded, size:', audioBlob.size);

    // Transcribe using Deepgram with enhanced speaker diarization
    const deepgramApiKey = Deno.env.get('DEEPGRAM_API_KEY');
    if (!deepgramApiKey) {
      throw new Error('DEEPGRAM_API_KEY not configured');
    }

    console.log('Sending audio to Deepgram for transcription with speaker diarization...');
    console.log('Recording direction:', recording.direction);
    console.log('From number:', recording.from_number);
    console.log('To number:', recording.to_number);

    // Use enhanced diarization settings for better speaker separation
    // multichannel=true helps when audio has separate channels per speaker (common in phone recordings)
    // smart_format improves readability
    const deepgramResponse = await fetch(
      'https://api.deepgram.com/v1/listen?' + new URLSearchParams({
        'model': 'nova-2',
        'diarize': 'true',
        'punctuate': 'true',
        'utterances': 'true',
        'smart_format': 'true',
        'diarize_version': '2023-09-19',
        'multichannel': 'true', // Better for phone calls with separate audio channels
      }).toString(),
      {
        method: 'POST',
        headers: {
          'Authorization': `Token ${deepgramApiKey}`,
          'Content-Type': 'audio/mpeg',
        },
        body: audioBlob,
      }
    );

    if (!deepgramResponse.ok) {
      const errorText = await deepgramResponse.text();
      console.error('Deepgram transcription error:', errorText);
      throw new Error(`Transcription failed: ${errorText}`);
    }

    const deepgramData = await deepgramResponse.json();
    console.log('Deepgram response received');
    
    // Check if multichannel detected multiple channels
    const channels = deepgramData.results?.channels || [];
    console.log('Number of audio channels detected:', channels.length);

    let formattedTranscription = '';

    // If multichannel detected 2 channels, use channel-based speaker identification
    if (channels.length >= 2) {
      console.log('Using multichannel speaker identification');
      
      // Collect all utterances from both channels with timestamps
      const allUtterances: Array<{channel: number, start: number, text: string}> = [];
      
      channels.forEach((channel: any, channelIndex: number) => {
        const alternatives = channel.alternatives || [];
        if (alternatives.length > 0 && alternatives[0].words) {
          // Group words into sentences/utterances
          let currentUtterance = '';
          let utteranceStart = 0;
          
          alternatives[0].words.forEach((word: any, wordIndex: number) => {
            if (currentUtterance === '') {
              utteranceStart = word.start;
            }
            currentUtterance += (currentUtterance ? ' ' : '') + word.word;
            
            // End utterance on punctuation or pause
            const nextWord = alternatives[0].words[wordIndex + 1];
            const isPause = nextWord && (nextWord.start - word.end) > 0.5;
            const isEndPunctuation = word.word.match(/[.!?]$/);
            
            if (isEndPunctuation || isPause || wordIndex === alternatives[0].words.length - 1) {
              if (currentUtterance.trim()) {
                allUtterances.push({
                  channel: channelIndex,
                  start: utteranceStart,
                  text: currentUtterance.trim()
                });
              }
              currentUtterance = '';
            }
          });
        }
      });
      
      // Sort by timestamp
      allUtterances.sort((a, b) => a.start - b.start);
      
      // Map channels to CALLER/RECIPIENT based on direction
      // For Twilio recordings: Channel 0 = remote/receiving party, Channel 1 = local/initiating party
      const isOutbound = recording.direction === 'outbound';
      
      formattedTranscription = allUtterances
        .map((utterance) => {
          // Twilio channel mapping:
          // Channel 0 = the party being called (remote)
          // Channel 1 = the party making the call (local)
          // For outbound: Channel 1 = CALLER (business calling), Channel 0 = RECIPIENT (customer receiving)
          // For inbound: Channel 1 = CALLER (customer calling), Channel 0 = RECIPIENT (business receiving)
          let speaker: string;
          if (isOutbound) {
            // Outbound: Channel 1 = business (CALLER), Channel 0 = customer (RECIPIENT)
            speaker = utterance.channel === 1 ? 'CALLER' : 'RECIPIENT';
          } else {
            // Inbound: Channel 1 = customer (CALLER), Channel 0 = business (RECIPIENT)
            speaker = utterance.channel === 1 ? 'CALLER' : 'RECIPIENT';
          }
          return `[${speaker}]: ${utterance.text}`;
        })
        .join('\n');
        
    } else {
      // Fallback to diarization-based identification
      console.log('Using diarization-based speaker identification');
      
      const utterances = deepgramData.results?.utterances || [];
      const uniqueSpeakers = new Set(utterances.map((u: any) => u.speaker));
      console.log('Number of speakers detected via diarization:', uniqueSpeakers.size);
      console.log('Total utterances:', utterances.length);
      
      if (utterances.length === 0) {
        // Try to get transcript from alternatives
        const alternatives = channels[0]?.alternatives || [];
        if (alternatives.length > 0 && alternatives[0].transcript) {
          formattedTranscription = `[CALLER]: ${alternatives[0].transcript}`;
          console.log('No utterances found, using full transcript');
        } else {
          throw new Error('No utterances or transcript found in transcription');
        }
      } else {
        // Map speaker numbers to caller/recipient
        const speakerMap = new Map<number, string>();
        const isOutbound = recording.direction === 'outbound';
        
        // Assign speakers based on order of appearance
        utterances.forEach((utterance: any) => {
          if (!speakerMap.has(utterance.speaker)) {
            if (speakerMap.size === 0) {
              // First speaker
              speakerMap.set(utterance.speaker, isOutbound ? 'CALLER' : 'RECIPIENT');
            } else {
              // Second speaker
              speakerMap.set(utterance.speaker, isOutbound ? 'RECIPIENT' : 'CALLER');
            }
          }
        });

        formattedTranscription = utterances
          .map((utterance: any) => {
            const speaker = speakerMap.get(utterance.speaker) || 'UNKNOWN';
            return `[${speaker}]: ${utterance.transcript}`;
          })
          .join('\n');
      }
    }

    console.log('Final transcription:', formattedTranscription);

    // Update recording with formatted transcription
    const { error: updateError } = await supabase
      .from('call_recordings')
      .update({ transcription: formattedTranscription })
      .eq('id', recordingId);

    if (updateError) {
      throw new Error('Failed to save transcription');
    }

    return new Response(
      JSON.stringify({ transcription: formattedTranscription }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );
  } catch (error) {
    console.error('Error in transcribe-recording function:', error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error' }),
      {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );
  }
});
