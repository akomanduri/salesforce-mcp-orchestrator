require('dotenv').config();
const jwt = require('jsonwebtoken');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

let cachedToken = null;
let tokenExpiry = 0;

async function getSalesforceAccessToken() {
  // Return cached token if still valid
  if (cachedToken && Date.now() < tokenExpiry) {
    return cachedToken;
  }

  const privateKey = fs.readFileSync(
    path.join(__dirname, '..', 'private_key.pem'), 
    'utf8'
  );

  const claim = {
    iss: process.env.SF_CLIENT_ID,
    sub: process.env.SF_USERNAME,
    aud: process.env.SF_LOGIN_URL,
    exp: Math.floor(Date.now() / 1000) + 300  // 5 min expiry
  };

  const token = jwt.sign(claim, privateKey, { algorithm: 'RS256' });

  const response = await axios.post(
    `${process.env.SF_LOGIN_URL}/services/oauth2/token`,
    new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: token
    }),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );

  cachedToken = response.data.access_token;
  tokenExpiry = Date.now() + (25 * 60 * 1000); // Cache for 25 minutes
  
  console.log('✅ Salesforce JWT token obtained successfully');
  return cachedToken;
}

module.exports = { getSalesforceAccessToken };
