require("dotenv").config();

const express = require("express");
const multer = require("multer");
const fs = require("fs");
const request = require("request");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());

// Configure multer for file uploads
const upload = multer({ dest: "uploads/" });

app.use(express.json());
app.use(express.static("public"));

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

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
