require('dotenv').config();
const express = require('express');
const OpenAI = require('openai');
const axios = require('axios');
const crypto = require('crypto');
const { getSalesforceAccessToken } = require('./salesforceAuth');

const app = express();
app.use(express.json());

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

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

  // Use stored access token
  if (process.env.SF_MCP_ACCESS_TOKEN) {
    console.log('🔑 Using stored MCP access token');
    mcpToken = process.env.SF_MCP_ACCESS_TOKEN;
    mcpTokenExpiry = Date.now() + (25 * 60 * 1000);
    return mcpToken;
  }

  // Refresh using refresh token
  if (process.env.SF_MCP_REFRESH_TOKEN) {
    console.log('🔑 Refreshing MCP token...');
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
    return mcpToken;
  }

  throw new Error('No MCP token. Visit /oauth/start to authorize.');
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
    mcpTokenExpiry = Date.now() + (25 * 60 * 1000);
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
    res.status(500).send('OAuth failed: ' + JSON.stringify(err.response?.data || err.message));
  }
});

// ─── DIAGNOSTIC: Test MCP Server Directly ────────────────────────────────────
app.get('/test-mcp', async (req, res) => {
  try {
    const mcpAccessToken = await getMCPAccessToken();
    console.log('🔑 Token length:', mcpAccessToken.length);
    console.log('🔑 Token preview:', mcpAccessToken.substring(0, 20) + '...');

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

    console.log('✅ MCP Server responded successfully');
    res.json({ success: true, tools: response.data });

  } catch (err) {
    console.error('❌ MCP test error:', err.response?.data || err.message);
    res.json({
      error: err.message,
      status: err.response?.status,
      data: err.response?.data
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

  console.log(`\n🤖 Starting AI processing for Case: ${caseId}`);
  console.log(`   Time: ${new Date().toISOString()}`);

  // Respond immediately so Apex does not time out
  res.json({ success: true, message: 'AI processing started', caseId });

  // Process in background
  processCase(caseId).catch(err => {
    console.error(`❌ Background error for Case ${caseId}:`, err.message);
  });
});

// ─── CORE AI PROCESSING FUNCTION ──────────────────────────────────────────────
async function processCase(caseId) {
  try {
    const sfToken = await getSalesforceAccessToken();
    console.log(`🔑 SF JWT token obtained for Case: ${caseId}`);

    const mcpAccessToken = await getMCPAccessToken();
    console.log(`🔑 MCP token obtained for Case: ${caseId}`);
    console.log(`🔑 MCP token length: ${mcpAccessToken.length}`);

    console.log(`📡 Calling OpenAI Responses API with SF MCP Server...`);

    const response = await openai.responses.create({
      model: 'gpt-4.1',
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
     - Professional closing with "Salesforce Support Team"

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
    console.log(`   Output: ${response.output_text?.substring(0, 150)}...`);

  } catch (err) {
    console.error(`❌ processCase error for ${caseId}:`, err.message);

    try {
      const sfToken = await getSalesforceAccessToken();
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

// ─── START SERVER ──────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🚀 MCP Orchestrator running on http://localhost:${PORT}`);
  console.log(`   Health:      http://localhost:${PORT}/health`);
  console.log(`   OAuth Start: http://localhost:${PORT}/oauth/start`);
  console.log(`   Test MCP:    http://localhost:${PORT}/test-mcp`);
  console.log(`   Orchestrate: POST http://localhost:${PORT}/orchestrate`);
  console.log('\n   Waiting for Case events from Salesforce...\n');
});
