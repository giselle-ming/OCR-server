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

  // Parse GOOGLE_CREDENTIALS from env
  const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);
  const { client_email, private_key } = credentials;

  const auth = new google.auth.JWT(client_email, null, private_key, SCOPES);
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

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
