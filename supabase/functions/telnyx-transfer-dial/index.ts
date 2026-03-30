import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

// TeXML endpoint for transferring a caller to an agent's SIP endpoint
// Called when the pickup-call function redirects the caller to this endpoint
serve(async (req) => {
  const url = new URL(req.url);
  const sipUri = url.searchParams.get('sipUri') || '';
  const from = url.searchParams.get('from') || '';
  const agentNumber = url.searchParams.get('agentNumber') || '';
  const userId = url.searchParams.get('userId') || '';
  
  console.log('Transfer dial request:', { sipUri, from, agentNumber, userId });
  
  const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';
  
  // Action URL for when dial completes/fails - update call status
  const actionUrl = `${supabaseUrl}/functions/v1/telnyx-call-events`;
  
  // Dial the agent's SIP endpoint with the original caller's ID
  // - callerId shows who is really calling (the original caller)
  // - timeout gives agent 60 seconds to answer
  // - answerOnBridge="false" means caller hears ringing while waiting
  const texml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial callerId="${from}" timeout="60" answerOnBridge="false" action="${actionUrl}">
    <Sip>${sipUri}</Sip>
  </Dial>
</Response>`;

  console.log('Returning transfer TeXML:', texml);

  return new Response(texml, {
    headers: { 'Content-Type': 'application/xml' },
  });
});
