require('dotenv').config();
const express = require('express');
const OpenAI = require('openai');
const axios = require('axios');
const crypto = require('crypto');
const { getSalesforceAccessToken } = require('./salesforceAuth');

const app = express();
app.use(express.json());

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ─── CONSTANTS ────────────────────────────────────────────────────────────────
const TOKEN_TTL_MS = 25 * 60 * 1000;
const SF_API_VERSION = process.env.SF_API_VERSION || 'v59.0';
const SFID_REGEX = /^[a-zA-Z0-9]{15,18}$/;

// ─── MCP TOKEN CACHE ──────────────────────────────────────────────────────────
let mcpToken = null;
let mcpTokenExpiry = 0;
let pkceVerifier = null;

// ─── PKCE HELPERS ─────────────────────────────────────────────────────────────
function base64URLEncode(buffer) {
  return buffer.toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

function generateCodeVerifier() {
  return base64URLEncode(crypto.randomBytes(32));
}

function generateCodeChallenge(verifier) {
  return base64URLEncode(
    crypto.createHash('sha256').update(verifier).digest()
  );
}

// ─── MCP TOKEN MANAGEMENT ─────────────────────────────────────────────────────
async function getMCPAccessToken() {
  // Return cached token if still valid
  if (mcpToken && Date.now() < mcpTokenExpiry) {
    return mcpToken;
  }

  // Try refresh token first (more reliable than stored access token)
  if (process.env.SF_MCP_REFRESH_TOKEN) {
    console.log('🔑 Refreshing MCP token using refresh token...');
    try {
      const response = await axios.post(
        `${process.env.SF_INSTANCE_URL}/services/oauth2/token`,
        new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: process.env.SF_MCP_CLIENT_ID,
          client_secret: process.env.SF_MCP_CLIENT_SECRET,
          refresh_token: process.env.SF_MCP_REFRESH_TOKEN
        }),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
      );
      mcpToken = response.data.access_token;
      mcpTokenExpiry = Date.now() + (25 * 60 * 1000);
      process.env.SF_MCP_ACCESS_TOKEN = mcpToken;
      console.log('✅ MCP token refreshed successfully');
      console.log('🔑 New token length:', mcpToken.length);
      return mcpToken;
    } catch (refreshErr) {
      console.error('❌ Token refresh failed:', refreshErr.response?.data || refreshErr.message);
      // Fall through to stored access token
    }
  }

  // Fall back to stored access token
  if (process.env.SF_MCP_ACCESS_TOKEN) {
    console.log('🔑 Using stored MCP access token');
    mcpToken = process.env.SF_MCP_ACCESS_TOKEN;
    mcpTokenExpiry = Date.now() + (25 * 60 * 1000);
    return mcpToken;
  }

  throw new Error('No MCP token available. Please visit /oauth/start to authorize.');
}

// ─── OAUTH ROUTES ─────────────────────────────────────────────────────────────
app.get('/oauth/start', (req, res) => {
  pkceVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(pkceVerifier);

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: process.env.SF_MCP_CLIENT_ID,
    redirect_uri: process.env.SF_REDIRECT_URI,
    scope: 'mcp_api refresh_token',
    code_challenge_method: 'S256',
    code_challenge: codeChallenge
  });

  const authUrl = `${process.env.SF_INSTANCE_URL}/services/oauth2/authorize?${params}`;
  console.log('🔑 Starting OAuth with PKCE...');
  res.redirect(authUrl);
});

app.get('/oauth/callback', async (req, res) => {
  const { code, error, error_description } = req.query;

  if (error) {
    console.error('❌ OAuth error:', error, error_description);
    return res.status(400).send(`OAuth error: ${error} - ${error_description}`);
  }

  if (!code) {
    return res.status(400).send('No authorization code received');
  }

  if (!pkceVerifier) {
    return res.status(400).send('PKCE verifier missing. Please restart the OAuth flow at /oauth/start');
  }

  try {
    const response = await axios.post(
      `${process.env.SF_INSTANCE_URL}/services/oauth2/token`,
      new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: process.env.SF_MCP_CLIENT_ID,
        client_secret: process.env.SF_MCP_CLIENT_SECRET,
        redirect_uri: process.env.SF_REDIRECT_URI,
        code_verifier: pkceVerifier,
        code
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );

    process.env.SF_MCP_ACCESS_TOKEN = response.data.access_token;
    process.env.SF_MCP_REFRESH_TOKEN = response.data.refresh_token;
    mcpToken = response.data.access_token;
    mcpTokenExpiry = Date.now() + TOKEN_TTL_MS;
    pkceVerifier = null;

    console.log('\n✅ MCP OAuth successful!');
    console.log('Copy these into Render environment variables:');
    console.log('SF_MCP_ACCESS_TOKEN=' + response.data.access_token);
    console.log('SF_MCP_REFRESH_TOKEN=' + response.data.refresh_token);

    res.send(`
      <h2>✅ OAuth Successful!</h2>
      <p>Your orchestrator is now authorized to call the Salesforce MCP Server.</p>
      <p>Check your Render logs and copy SF_MCP_ACCESS_TOKEN and 
      SF_MCP_REFRESH_TOKEN into your Render environment variables 
      so they persist after restarts.</p>
    `);
  } catch (err) {
    console.error('❌ OAuth callback error:', err.response?.data || err.message);
    res.status(500).send('OAuth failed. Check server logs for details.');
  }
});

// ─── DIAGNOSTIC: Test MCP Server Directly ────────────────────────────────────
app.get('/test-mcp', async (req, res) => {
  const auth = req.headers['authorization'];
  if (auth !== `Bearer ${process.env.ORCHESTRATOR_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const mcpAccessToken = await getMCPAccessToken();

    const headers = {
      'Authorization': `Bearer ${mcpAccessToken}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream'
    };

    // Step 1 — Initialize the MCP session
    console.log('📡 Step 1: Sending initialize request...');
    const initResponse = await axios.post(
      process.env.SF_MCP_SERVER_URL,
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: {
            name: 'salesforce-mcp-orchestrator',
            version: '1.0.0'
          }
        }
      },
      { headers }
    );

    console.log('✅ Initialize response:', JSON.stringify(initResponse.data));

    // Extract session key from response headers
    const sessionKey = initResponse.headers['mcp-session-id'] 
      || initResponse.headers['x-session-id']
      || initResponse.headers['session-id'];
    
    console.log('🔑 Session key:', sessionKey);
    console.log('🔑 Response headers:', JSON.stringify(initResponse.headers));

    if (!sessionKey) {
      return res.json({ 
        success: false, 
        message: 'No session key in response headers',
        headers: initResponse.headers,
        data: initResponse.data
      });
    }

    // Step 2 — List tools using session key
    console.log('📡 Step 2: Listing tools...');
    const toolsResponse = await axios.post(
      process.env.SF_MCP_SERVER_URL,
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
        params: {}
      },
      { 
        headers: {
          ...headers,
          'mcp-session-id': sessionKey
        }
      }
    );

    console.log('✅ MCP Server tools retrieved successfully');
    console.log('✅ Tools raw response:', JSON.stringify(toolsResponse.data));
    console.log('✅ Tools response type:', typeof toolsResponse.data);
    res.json({ 
      success: true, 
      raw: toolsResponse.data,
      type: typeof toolsResponse.data
    });

  } catch (err) {
    console.error('❌ MCP test error:', err.response?.data || err.message);
    res.status(500).json({
      error: 'MCP test failed',
      status: err.response?.status
    });
  }
});

// ─── HEALTH CHECK ─────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    hasMCPToken: !!process.env.SF_MCP_ACCESS_TOKEN,
    hasMCPRefreshToken: !!process.env.SF_MCP_REFRESH_TOKEN
  });
});

// ─── MAIN ORCHESTRATOR ENDPOINT ───────────────────────────────────────────────
app.post('/orchestrate', async (req, res) => {
  const auth = req.headers['authorization'];
  if (auth !== `Bearer ${process.env.ORCHESTRATOR_SECRET}`) {
    console.warn('⚠️  Unauthorized request blocked');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { caseId } = req.body;
  if (!caseId) {
    return res.status(400).json({ error: 'caseId is required' });
  }
  if (!SFID_REGEX.test(caseId)) {
    return res.status(400).json({ error: 'Invalid caseId format' });
  }

  const requestId = crypto.randomUUID();
  console.log(`\n🤖 [${requestId}] Starting AI processing for Case: ${caseId}`);
  console.log(`   Time: ${new Date().toISOString()}`);

  // Respond immediately so Apex does not time out
  res.json({ success: true, message: 'AI processing started', caseId });

  // Process in background
  processCase(caseId, requestId).catch(err => {
    console.error(`❌ [${requestId}] Background error for Case ${caseId}:`, err.message);
  });
});

// ─── PROMPT BUILDER ──────────────────────────────────────────────────────────
function buildCasePrompt(caseId) {
  return `You are an expert Salesforce customer service AI assistant.

A new support Case has just arrived via email with Salesforce Case ID: ${caseId}

Use the Salesforce MCP tools to gather information, then return a JSON response.

STEP 1 - Get the Case: Query the Case record to get subject, description,
status, priority, origin, AccountId, and ContactId.

STEP 2 - Get the Customer: Use the Email address of the sender to find the Contact. Then use the ContactId to get the customer's
full name.

STEP 3 - Get the Account: Use the AccountId to get the company name
and industry.

STEP 4 - Get the Orders : Use the AccountId find relevant Orders of the Customer,
and try to find out which Order the Customer is likely talking about.

STEP 5 - Get Email History: Query EmailMessage records where ParentId
equals '${caseId}', ordered by MessageDate descending, limit 5.

STEP 6 - Get Support History: Query the 5 most recent Cases for the
same ContactId to understand if this is a repeat issue.

STEP 7 - Search Knowledge: Query KnowledgeArticleVersion records
where PublishStatus = 'Online' and Language = 'en_US', searching
for titles or summaries relevant to the customer's issue. Limit 3.

STEP 8 - Return your response as a JSON object with exactly these two fields:
{
  "summary": "your case summary here",
  "draftResponse": "your draft email response here"
}

For the summary include:
- What the customer is asking for (2-3 clear sentences)
- Key details (bullet points)
- Urgency: Low / Medium / High with a one-line reason

For the draft email response:
- Use the customer's first name
- Acknowledge their specific issue warmly
- Provide clear resolution steps using knowledge base content if found
- Professional closing with Salesforce Support Team

IMPORTANT: Your final response must be a valid JSON object only.
Do not include any text before or after the JSON.
Do not invent data not found in Salesforce.`;
}

// ─── CORE AI PROCESSING FUNCTION ──────────────────────────────────────────────
async function processCase(caseId, requestId) {
  const log = (msg) => console.log(`[${requestId}] ${msg}`);
  const logErr = (msg) => console.error(`[${requestId}] ${msg}`);

  try {
    const sfToken = await getSalesforceAccessToken();
    log(`🔑 SF JWT token obtained for Case: ${caseId}`);

    const mcpAccessToken = await getMCPAccessToken();
    log(`🔑 MCP token obtained for Case: ${caseId}`);

    log(`📡 Calling OpenAI Responses API with SF MCP Server...`);

    const response = await openai.responses.create({
      model: 'gpt-5-mini',
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
      input: buildCasePrompt(caseId)
    });

    log(`✅ OpenAI completed processing for Case: ${caseId}`);
    log(`   Raw output: ${response.output_text}`);

    // Also log all tool calls OpenAI made
    if (response.output) {
      response.output.forEach((item, index) => {
        if (item.type === 'mcp_call') {
          log(`   Tool call ${index}: ${item.name} → ${JSON.stringify(item.arguments)}`);
        }
        if (item.type === 'mcp_call_result') {
          log(`   Tool result ${index}: ${JSON.stringify(item.content)?.substring(0, 200)}`);
        }
      });
    }
      
    // Parse the JSON response from OpenAI
    let summary = '';
    let draftResponse = '';

    try {
      // Clean the response in case OpenAI added markdown code fences
      const cleaned = response.output_text
        .replace(/```json/g, '')
        .replace(/```/g, '')
        .trim();

      const parsed = JSON.parse(cleaned);
      summary = parsed.summary || '';
      draftResponse = parsed.draftResponse || '';

      log(`✅ Successfully parsed AI output`);
      log(`   Summary preview: ${summary.substring(0, 100)}...`);
      log(`   Draft preview: ${draftResponse.substring(0, 100)}...`);

    } catch (parseErr) {
      logErr('❌ Could not parse JSON from OpenAI response: ' + parseErr.message);
      // Use raw output as summary if JSON parsing fails
      summary = response.output_text;
      draftResponse = 'AI could not generate a structured response. Please review the summary.';
    }

    // Update Salesforce Case directly via REST API using JWT token
    log(`📝 Updating Salesforce Case ${caseId}...`);
    await axios.patch(
      `${process.env.SF_INSTANCE_URL}/services/data/${SF_API_VERSION}/sobjects/Case/${caseId}`,
      {
        AI_Case_Summary__c: summary,
        AI_Draft_Response__c: draftResponse,
        AI_Status__c: `AI Processing Complete - ${new Date().toLocaleString()}`
      },
      {
        headers: {
          'Authorization': `Bearer ${sfToken}`,
          'Content-Type': 'application/json'
        }
      }
    );

    log(`✅ Salesforce Case updated successfully for Case: ${caseId}`);

  } catch (err) {
    logErr(`❌ processCase error for ${caseId}: ${err.message}`);

    try {
      const sfToken = await getSalesforceAccessToken();
      await axios.patch(
        `${process.env.SF_INSTANCE_URL}/services/data/${SF_API_VERSION}/sobjects/Case/${caseId}`,
        { AI_Status__c: `AI Error: ${err.message.substring(0, 200)}` },
        {
          headers: {
            'Authorization': `Bearer ${sfToken}`,
            'Content-Type': 'application/json'
          }
        }
      );
    } catch (updateErr) {
      logErr('Could not write error to Case: ' + updateErr.message);
    }
  }
}

// ─── START SERVER ──────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
  console.log(`\n🚀 MCP Orchestrator running on http://localhost:${PORT}`);
  console.log(`   Health:      http://localhost:${PORT}/health`);
  console.log(`   OAuth Start: http://localhost:${PORT}/oauth/start`);
  console.log(`   Test MCP:    http://localhost:${PORT}/test-mcp`);
  console.log(`   Orchestrate: POST http://localhost:${PORT}/orchestrate`);
  console.log('\n   Waiting for Case events from Salesforce...\n');
});

// ─── GRACEFUL SHUTDOWN ───────────────────────────────────────────────────────
function shutdown(signal) {
  console.log(`\n⏹️  ${signal} received — shutting down gracefully...`);
  server.close(() => {
    console.log('Server closed.');
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10000);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
