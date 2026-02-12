const fs = require("fs");
const path = require("path");
const { google } = require("googleapis");

const SCOPES = ["https://www.googleapis.com/auth/drive"]; // simples e garante acesso

function loadJSON(p) {
  const full = path.resolve(p);
  if (!fs.existsSync(full)) throw new Error(`Arquivo não encontrado: ${full}`);
  return JSON.parse(fs.readFileSync(full, "utf8"));
}

function saveJSON(p, obj) {
  const full = path.resolve(p);
  fs.writeFileSync(full, JSON.stringify(obj, null, 2), "utf8");
}

function getOAuth2Client() {
  const credentialsPath = process.env.DRIVE_OAUTH_CREDENTIALS_JSON || "./driveOAuthClient.json";
  const creds = loadJSON(credentialsPath);

  // formato do google: { "installed": { client_id, client_secret, redirect_uris[] } }
  const installed = creds.installed || creds.web;
  if (!installed?.client_id || !installed?.client_secret) {
    throw new Error("driveOAuthClient.json inválido. Baixe o JSON do OAuth Client (Desktop).");
  }

  const redirectUri =
    (installed.redirect_uris && installed.redirect_uris[0]) ||
    "http://localhost:3000/oauth2callback";

  return new google.auth.OAuth2(installed.client_id, installed.client_secret, redirectUri);
}

function getDrive() {
  const tokenPath = process.env.DRIVE_OAUTH_TOKEN_JSON || "./driveToken.json";
  const oauth2 = getOAuth2Client();

  if (!fs.existsSync(path.resolve(tokenPath))) {
    throw new Error(
      `Token OAuth não encontrado (${tokenPath}). Rode: node driveAuthSetup.js`
    );
  }

  const token = loadJSON(tokenPath);
  oauth2.setCredentials(token);

  return google.drive({ version: "v3", auth: oauth2 });
}

function getAuthUrl() {
  const oauth2 = getOAuth2Client();
  return oauth2.generateAuthUrl({
    access_type: "offline",
    prompt: "consent", // garante refresh_token
    scope: SCOPES,
  });
}

async function exchangeCodeForToken(code) {
  const oauth2 = getOAuth2Client();
  const { tokens } = await oauth2.getToken(code);
  return tokens;
}

module.exports = {
  getDrive,
  getAuthUrl,
  exchangeCodeForToken,
  saveJSON,
};
