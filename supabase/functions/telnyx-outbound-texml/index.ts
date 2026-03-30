import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const url = new URL(req.url);
    const toNumber = url.searchParams.get('to');
    const fromNumber = url.searchParams.get('from');

    // Parse form data if POST
    let to = toNumber;
    let from = fromNumber;
    if (req.method === 'POST') {
      const formData = await req.text();
      const params = new URLSearchParams(formData);
      to = params.get('To') || params.get('to') || toNumber;
      from = params.get('From') || params.get('from') || fromNumber;
    }

    console.log('TeXML outbound handler:', { to, from });

    if (!to || !from) {
      throw new Error('Missing to/from for TeXML dial');
    }

    // Return TeXML that connects the call WITHOUT any pre-audio (no robot voice)
    const texml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial callerId="${from}" timeLimit="14400">
    <Number>${to}</Number>
  </Dial>
</Response>`;

    return new Response(texml, {
      headers: { 
        ...corsHeaders, 
        'Content-Type': 'application/xml' 
      },
    });
  } catch (error) {
    console.error('Error in TeXML outbound handler:', error);
    
    // Return a hangup response on error
    const errorTexml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>Sorry, there was an error connecting your call.</Say>
  <Hangup/>
</Response>`;

    return new Response(errorTexml, {
      headers: { 
        ...corsHeaders, 
        'Content-Type': 'application/xml' 
      },
    });
  }
});
