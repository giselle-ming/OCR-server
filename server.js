require("dotenv").config();

const express = require("express");
const multer = require("multer");
const fs = require("fs");
const request = require("request");
const cors = require("cors");
const { google } = require("googleapis");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static("public"));

const upload = multer({ dest: "uploads/" });

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
    formData: {
      file: fs.createReadStream(filePath),
    },
  };

  request(options, (error, response) => {
    fs.unlinkSync(filePath);

    if (error) {
      res.status(500).json({ error: error.message });
    } else {
      res.json(JSON.parse(response.body)); // Send the Veryfi API response back to the client
    }
  });
});

const SCOPES = ["https://www.googleapis.com/auth/spreadsheets"];
const SPREADSHEET_ID = "1p3QJw0xi2xqFjM92RVZwFPcI-7I09ntSOvLsowozL7E";
const SHEET_RANGE = "Sheet1!A:E";

let sheetsClient = null;

async function getSheetsClient() {
  if (sheetsClient) return sheetsClient;

  const raw = process.env.GOOGLE_CREDENTIALS;
  if (!raw) throw new Error("GOOGLE_CREDENTIALS env var not set");

  let credentials;
  try {
    credentials = JSON.parse(raw);
  } catch (err) {
    throw new Error("Invalid JSON in GOOGLE_CREDENTIALS: " + err.message);
  }

  const { client_email, private_key } = credentials;
  if (!client_email || !private_key) {
    throw new Error(
      "GOOGLE_CREDENTIALS must include client_email and private_key"
    );
  }

  const normalizedKey = private_key.replace(/\\n/g, "\n");

  const auth = new google.auth.JWT(client_email, null, normalizedKey, SCOPES);
  await auth.authorize();

  sheetsClient = google.sheets({ version: "v4", auth });
  return sheetsClient;
}

app.post("/api/append", async (req, res) => {
  try {
    const { date, vendor, amount, category, notes } = req.body || {};

    if (!date || !vendor || !amount || !category) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const sheets = await getSheetsClient();
    const row = [[date, vendor, String(amount), category, notes || ""]];
    const resource = { values: row };

    const result = await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: SHEET_RANGE,
      valueInputOption: "RAW",
      resource,
    });

    return res.status(200).json({
      success: true,
      updates: result.data.updates,
    });
  } catch (err) {
    console.error("Failed to append row:", err);
    return res.status(500).json({
      error: "Internal server error",
      details: err.message,
    });
  }
});

app.get("/api/auth", async (req, res) => {
  try {
    await getSheetsClient(); // will authorize the JWT if not already done
    return res.status(200).json({ authenticated: true });
  } catch (err) {
    console.error("Google auth failed:", err);
    return res.status(500).json({ authenticated: false, error: err.message });
  }
});

getSheetsClient()
  .then(() => console.log("Google Sheets service account authorized"))
  .catch((err) =>
    console.warn(
      "Google Sheets pre-auth failed (will try on request):",
      err.message
    )
  );

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
