require('dotenv').config();
const express = require('express');
const OpenAI = require('openai');
const axios = require('axios');
const { getSalesforceAccessToken } = require('./salesforceAuth');

// MCP-specific token cache
let mcpToken = null;
let mcpTokenExpiry = 0;

async function getMCPAccessToken() {
  if (mcpToken && Date.now() < mcpTokenExpiry) {
    return mcpToken;
  }

  console.log('🔑 Getting MCP-specific access token...');

  const response = await axios.post(
    `${process.env.SF_INSTANCE_URL}/services/oauth2/token`,
    new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: process.env.SF_MCP_CLIENT_ID,
      client_secret: process.env.SF_MCP_CLIENT_SECRET
    }),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );

  mcpToken = response.data.access_token;
  mcpTokenExpiry = Date.now() + (25 * 60 * 1000);
  console.log('✅ MCP access token obtained successfully');
  return mcpToken;
}

const app = express();
app.use(express.json());

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ─── HEALTH CHECK ──────────────────────────────────────────────────────────
app.get('/health', async (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ─── MAIN ORCHESTRATOR ENDPOINT ────────────────────────────────────────────
// Called by Salesforce Apex when a new Case is created

app.post('/orchestrate', async (req, res) => {

  // Verify the call is from your Salesforce org
  const auth = req.headers['authorization'];
  if (auth !== `Bearer ${process.env.ORCHESTRATOR_SECRET}`) {
    console.warn('⚠️  Unauthorized request blocked');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { caseId } = req.body;
  if (!caseId) {
    return res.status(400).json({ error: 'caseId is required' });
  }

  console.log(`\n🤖 Starting AI processing for Case: ${caseId}`);
  console.log(`   Time: ${new Date().toISOString()}`);

  // Respond immediately to Salesforce so it doesn't time out
  // The actual AI work happens asynchronously
  res.json({ success: true, message: 'AI processing started', caseId });

  // Run AI processing in background
  processCase(caseId).catch(err => {
    console.error(`❌ Error processing Case ${caseId}:`, err.message);
  });
});

async function processCase(caseId) {
  try {
    // Get a valid Salesforce access token via JWT
    const sfToken = await getSalesforceAccessToken();
    console.log(`🔑 SF token obtained for Case: ${caseId}`);

    // Get MCP-specific token with mcp scope
    const mcpAccessToken = await getMCPAccessToken();
    console.log(`🔑 MCP token obtained for Case: ${caseId}`);

    // Decode and log the token scopes (JWT tokens are base64 encoded)
    try {
      const tokenParts = mcpAccessToken.split('.');
      if (tokenParts.length === 3) {
        const payload = JSON.parse(Buffer.from(tokenParts[1], 'base64').toString());
        console.log('🔑 MCP token scopes:', payload.scp || payload.scope || 'not visible');
      }
    } catch(e) {
      console.log('🔑 Token is not JWT format (opaque token)');
    }
      
    // Call OpenAI Responses API
    // OpenAI will autonomously call the Salesforce MCP Server
    // to gather whatever data it needs, then produce the output
    console.log(`📡 Calling OpenAI Responses API with SF MCP Server...`);

    console.log('🔑 MCP Client ID set:', !!process.env.SF_MCP_CLIENT_ID);
    console.log('🔑 MCP Client Secret set:', !!process.env.SF_MCP_CLIENT_SECRET);
    console.log('🔑 MCP Server URL:', process.env.SF_MCP_SERVER_URL);
    
    const response = await openai.responses.create({
      model: 'gpt-5-nano',
      tools: [
        {
          type: 'mcp',
          server_label: 'salesforce',
          server_url: process.env.SF_MCP_SERVER_URL,
          headers: {
            'Authorization': `Bearer ${mcpAccessToken}`
          },
          require_approval: 'never'
        }
      ],
      input: `You are an expert Salesforce customer service AI assistant.

A new support Case has just arrived via email with Salesforce Case ID: ${caseId}

Work through these steps autonomously using the Salesforce tools available to you:

STEP 1 - Get the Case: Query the Case record to get subject, description, 
status, priority, origin, AccountId, and ContactId.

STEP 2 - Get the Customer: Use the ContactId to get the customer's 
full name and email address.

STEP 3 - Get the Account: Use the AccountId to get the company name 
and industry.

STEP 4 - Get Email History: Query EmailMessage records where ParentId 
equals the Case ID, ordered by MessageDate descending, limit 5. 
This gives you the actual email the customer sent.

STEP 5 - Get Support History: Query the 5 most recent Cases for the 
same ContactId (excluding the current Case) to understand if this 
is a repeat issue.

STEP 6 - Search Knowledge: Query KnowledgeArticleVersion records 
where PublishStatus = 'Online' and Language = 'en_US', searching 
for titles or summaries relevant to the customer's issue. Limit 3.

STEP 7 - Write the outputs. Based on everything you found, produce:

  A) CASE SUMMARY for the field AI_Case_Summary__c:
     - What the customer is asking for (2-3 clear sentences)
     - Key details (bullet points)  
     - Urgency: Low / Medium / High with a one-line reason

  B) DRAFT EMAIL RESPONSE for the field AI_Draft_Response__c:
     - Use the customer's first name
     - Acknowledge their specific issue warmly
     - Provide clear resolution steps using knowledge base content if found
     - Professional closing with your name as "Salesforce Support Team"

STEP 8 - Update the Case: Write both outputs back to the Case record 
by updating AI_Case_Summary__c, AI_Draft_Response__c, and set 
AI_Status__c to "AI Processing Complete - ${new Date().toLocaleString()}"

Important rules:
- Do not invent data not found in Salesforce
- Use the customer's actual first name in the response
- If no knowledge articles are found, still provide helpful general guidance
- Be empathetic, professional, and concise`

    });

    console.log(`✅ OpenAI completed processing for Case: ${caseId}`);
    console.log(`   Output preview: ${response.output_text?.substring(0, 150)}...`);

  } catch (err) {
    console.error(`❌ processCase error for ${caseId}:`, err.message);

    // Add this to see the full error details
    if (err.status) console.error('   Status:', err.status);
    if (err.headers) console.error('   Headers:', JSON.stringify(err.headers));
    console.error('   Full error:', JSON.stringify(err, null, 2));
      
    // Try to write the error back to the Case so the CSR knows
    try {
      const sfToken = await getSalesforceAccessToken();
      const axios = require('axios');
      await axios.patch(
        `${process.env.SF_INSTANCE_URL}/services/data/v59.0/sobjects/Case/${caseId}`,
        { AI_Status__c: `AI Error: ${err.message.substring(0, 200)}` },
        { 
          headers: { 
            'Authorization': `Bearer ${sfToken}`,
            'Content-Type': 'application/json'
          } 
        }
      );
    } catch (updateErr) {
      console.error('Could not write error to Case:', updateErr.message);
    }
  }
}

// ─── START SERVER ──────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🚀 MCP Orchestrator running on http://localhost:${PORT}`);
  console.log(`   Health: http://localhost:${PORT}/health`);
  console.log(`   Orchestrate: POST http://localhost:${PORT}/orchestrate`);
  console.log('\n   Waiting for Case events from Salesforce...\n');
});

// Temporary diagnostic endpoint - remove after testing
app.get('/test-mcp', async (req, res) => {
  try {
    const mcpAccessToken = await getMCPAccessToken();
    console.log('🔑 MCP token obtained:', mcpAccessToken.substring(0, 20) + '...');
    console.log('🔑 Full MCP token:', mcpAccessToken);
    
    // Call the MCP Server directly to get tool list
    const response = await axios.post(
      process.env.SF_MCP_SERVER_URL,
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        params: {}
      },
      {
        headers: {
          'Authorization': `Bearer ${mcpAccessToken}`,
          'Content-Type': 'application/json'
        }
      }
    );

    console.log('✅ MCP Server response:', JSON.stringify(response.data, null, 2));
    res.json({ success: true, data: response.data });

  } catch (err) {
    console.error('❌ MCP direct call error:');
    console.error('   Status:', err.response?.status);
    console.error('   Data:', JSON.stringify(err.response?.data, null, 2));
    console.error('   Message:', err.message);
    res.json({ 
      error: err.message,
      status: err.response?.status,
      data: err.response?.data
    });
  }
});
