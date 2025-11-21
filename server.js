require("dotenv").config();
const { datadogRum } = require("@datadog/browser-rum");

const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const cors = require("cors");
const request = require("request");
const { google } = require("googleapis");
const app = express();
const PORT = process.env.PORT || 3000;

// TODO : refactor code to use async/await instead of callbacks where possible
// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static("public"));

const upload = multer({ dest: "uploads/" });

datadogRum.init({
  applicationId: process.env.DATADOG_RUM_APPLICATION_ID,
  clientToken: process.env.DATADOG_RUM_CLIENT_TOKEN,
  // `site` refers to the Datadog site parameter of your organization
  // see https://docs.datadoghq.com/getting_started/site/
  site: "us5.datadoghq.com",
  service: "test",
  env: "prod",
  // Specify a version number to identify the deployed version of your application in Datadog
  // version: '1.0.0',
  sessionSampleRate: 100,
  sessionReplaySampleRate: 20,
  trackBfcacheViews: true,
  defaultPrivacyLevel: "mask-user-input",
});

// Config constants
const SCOPES = ["https://www.googleapis.com/auth/spreadsheets"];
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const SHEET_RANGE = "Sheet1!A:E";

const OAUTH_CLIENT_ID = process.env.GOOGLE_OAUTH_CLIENT_ID;
const OAUTH_CLIENT_SECRET = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const OAUTH_REDIRECT =
  process.env.GOOGLE_OAUTH_REDIRECT || `${BASE_URL}/oauth2callback`;
const TOKEN_FILE = path.join(__dirname, "google_tokens.json");

let sheetsClient = null;
let oauth2Client = null;

// Veryfi Upload Endpoint
app.post("/upload", upload.single("file"), (req, res) => {
  const filePath = req.file.path;

  const options = {
    method: "POST",
    url: process.env.VERYFI_API_URL,
    headers: {
      "Content-Type": "multipart/form-data",
      Accept: "application/json",
      "CLIENT-ID": process.env.VERYFI_CLIENT_ID,
      AUTHORIZATION: process.env.VERYFI_AUTHORIZATION,
    },
    formData: { file: fs.createReadStream(filePath) },
  };

  request(options, (error, response) => {
    fs.unlinkSync(filePath); // cleanup temp file

    if (error) return res.status(500).json({ error: error.message });

    try {
      res.json(JSON.parse(response.body));
    } catch {
      res.status(500).json({ error: "Invalid Veryfi response" });
    }
  });
});

// Google OAuth Helpers
function initOAuthClient() {
  if (oauth2Client) return oauth2Client;

  if (!OAUTH_CLIENT_ID || !OAUTH_CLIENT_SECRET) {
    console.error(
      "Missing GOOGLE_OAUTH_CLIENT_ID or GOOGLE_OAUTH_CLIENT_SECRET"
    );
    return null;
  }

  oauth2Client = new google.auth.OAuth2(
    OAUTH_CLIENT_ID,
    OAUTH_CLIENT_SECRET,
    OAUTH_REDIRECT
  );
  return oauth2Client;
}

async function loadStoredTokens() {
  if (process.env.GOOGLE_OAUTH_TOKENS) {
    try {
      return JSON.parse(process.env.GOOGLE_OAUTH_TOKENS);
    } catch (err) {
      console.warn("Invalid GOOGLE_OAUTH_TOKENS:", err.message);
    }
  }

  if (fs.existsSync(TOKEN_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(TOKEN_FILE, "utf8"));
    } catch (err) {
      console.warn("Failed reading token file:", err.message);
    }
  }

  return null;
}

/**
 * Saves the given OAuth tokens to a file on disk.
 *
 * @param {Object} tokens An object containing the OAuth tokens to be saved.
 *
 * @throws {Error} If writing the token file fails.
 */
async function saveTokens(tokens) {
  try {
    fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokens));
    console.log("Saved Google OAuth tokens to", TOKEN_FILE);
  } catch (err) {
    console.warn("Failed to write token file:", err.message);
  }
}

/**
 * Returns a Google Sheets client, authenticated with either stored OAuth tokens or
 * service account credentials from the GOOGLE_CREDENTIALS environment variable.
 *
 * @throws {Error} If no OAuth tokens are stored and GOOGLE_CREDENTIALS is not set.
 * @returns {Promise<google.sheets_v4.Sheets>} A Promise resolving to a Google Sheets client.
 */
async function getSheetsClient() {
  if (sheetsClient) return sheetsClient;

  const oauthClient = initOAuthClient();
  if (oauthClient) {
    const tokens = await loadStoredTokens();
    if (tokens) {
      oauthClient.setCredentials(tokens);
      try {
        await oauthClient.getAccessToken(); // refresh if needed
      } catch (err) {
        console.warn("OAuth token refresh warning:", err.message);
      }
      sheetsClient = google.sheets({ version: "v4", auth: oauthClient });
      return sheetsClient;
    }
    throw new Error("No OAuth tokens stored. Authenticate at /api/auth");
  }

  if (!process.env.GOOGLE_CREDENTIALS) {
    throw new Error("No OAuth client or GOOGLE_CREDENTIALS provided");
  }

  let credentials;
  try {
    credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);
  } catch (err) {
    throw new Error("Invalid GOOGLE_CREDENTIALS JSON: " + err.message);
  }

  const { client_email, private_key } = credentials;
  if (!client_email || !private_key) {
    throw new Error(
      "GOOGLE_CREDENTIALS must include client_email & private_key"
    );
  }

  const auth = new google.auth.JWT(
    client_email,
    null,
    private_key.replace(/\\n/g, "\n"),
    SCOPES
  );
  await auth.authorize();

  sheetsClient = google.sheets({ version: "v4", auth });
  return sheetsClient;
}

// API Routes

// Append row to Google Sheets
app.post("/api/append", async (req, res) => {
  try {
    const { date, vendor, amount, category, notes } = req.body || {};
    if (!date || !vendor || !amount || !category) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const sheets = await getSheetsClient();
    const resource = {
      values: [[date, vendor, String(amount), category, notes || ""]],
    };

    const result = await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: SHEET_RANGE,
      valueInputOption: "RAW",
      resource,
    });

    res.status(200).json({ success: true, updates: result.data.updates });
  } catch (err) {
    console.error("Append row error:", err);
    res
      .status(500)
      .json({ error: "Internal server error", details: err.message });
  }
});

// Start OAuth flow
app.get("/api/auth", (req, res) => {
  const client = initOAuthClient();
  if (!client) {
    return res.status(500).json({ error: "OAuth client not configured" });
  }

  const authUrl = client.generateAuthUrl({
    access_type: "offline",
    scope: SCOPES,
    prompt: "consent",
  });
  res.redirect(authUrl);
});

// OAuth callback
app.get("/oauth2callback", async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send("Missing code");

  try {
    const client = initOAuthClient();
    const { tokens } = await client.getToken(code);
    client.setCredentials(tokens);
    await saveTokens(tokens);

    sheetsClient = google.sheets({ version: "v4", auth: client });
    res.redirect("https://giselle-ming.github.io/auto-invoice/");
  } catch (err) {
    console.error("OAuth callback error:", err);
    res.status(500).send("Authentication failed");
  }
});

// Check authentication status
app.get("/api/auth-status", async (req, res) => {
  try {
    await getSheetsClient();
    res.json({ authenticated: true });
  } catch (err) {
    res.json({ authenticated: false, error: err.message });
  }
});

// Startup
getSheetsClient()
  .then(() => console.log("Google Sheets client ready"))
  .catch((err) =>
    console.warn("Sheets client not ready at startup:", err.message)
  );

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
