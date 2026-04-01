require("dotenv").config();

const express = require("express");
const axios = require("axios");
const bodyParser = require("body-parser");
const QRCode = require("qrcode");
const path = require("path");
const PDFDocument = require("pdfkit");

const app = express();

app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

const PORT = process.env.PORT || 3000;

// =========================
// ENV
// =========================
const {
  CONSUMER_KEY,
  CONSUMER_SECRET,
  SHORTCODE,
  PASSKEY,
  CALLBACK_URL,
  TILL_NUMBER,
  ADMIN_PHONE,
  AT_API_KEY,
  AT_USERNAME
} = process.env;

// =========================
// STORAGE
// =========================
let pendingPayments = {};
let issuedTickets = {};
let failedPayments = {};

let teams = [];
let pendingTeamPayments = {};
let failedTeamPayments = {};
let completedTeamPayments = {};

const TEAM_PRICE = 5;
const TEAM_LIMIT = 8;

// =========================
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// =========================
// ACCESS TOKEN
// =========================
async function getAccessToken() {
  const auth = Buffer.from(`${CONSUMER_KEY}:${CONSUMER_SECRET}`).toString("base64");

  const response = await axios.get(
    "https://api.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials",
    { headers: { Authorization: `Basic ${auth}` } }
  );

  return response.data.access_token;
}

// =========================
// 📩 SMS FUNCTION
// =========================
async function sendSMS(message) {
  try {
    await axios.post(
      "https://api.africastalking.com/version1/messaging",
      new URLSearchParams({
        username: AT_USERNAME,
        to: ADMIN_PHONE,
        message
      }),
      {
        headers: {
          apiKey: AT_API_KEY,
          "Content-Type": "application/x-www-form-urlencoded"
        }
      }
    );
  } catch (err) {
    console.log("SMS ERROR:", err.response?.data || err.message);
  }
}

// =========================
// SLOTS (FIXED)
// =========================
const LIMITS = {
  skill_showcase: 32,
  head_to_head: 32
};

function getCategoryCount(category) {
  return Object.values(issuedTickets).filter(t => t.category === category).length;
}

app.get("/slots", (req, res) => {
  res.json({
    skill_showcase: Math.max(LIMITS.skill_showcase - getCategoryCount("skill_showcase"), 0),
    head_to_head: Math.max(LIMITS.head_to_head - getCategoryCount("head_to_head"), 0)
  });
});

// =========================
// TEAM SLOTS
// =========================
app.get("/team-slots", (req, res) => {
  res.json({ registered: teams.length });
});

// =========================
// PAYMENT STATUS
// =========================
app.get("/payment-status", (req, res) => {
  const email = req.query.email;

  if (failedPayments[email]) {
    delete failedPayments[email];
    return res.json({ status: "failed" });
  }

  const entry = Object.entries(issuedTickets).find(([id, t]) => t.email === email);

  if (entry) {
    const [ticketID, ticket] = entry;
    return res.json({ status: "success", ticketID, ticket });
  }

  return res.json({ status: "pending" });
});

// =========================
// TEAM STATUS
// =========================
app.get("/team_status", (req, res) => {
  const email = req.query.email;

  if (failedTeamPayments[email]) {
    delete failedTeamPayments[email];
    return res.json({ status: "failed" });
  }

  if (completedTeamPayments[email]) {
    return res.json({ status: "success", team: completedTeamPayments[email] });
  }

  return res.json({ status: "pending" });
});

// =========================
// REGISTER TEAM (🔥 FIXED)
// =========================
app.post("/register-team", async (req, res) => {

  let { teamName, captainName, phone, email } = req.body;

  if (!teamName || !captainName || !phone || !email) {
    return res.status(400).json({ message: "All fields required" });
  }

  if (teams.length >= TEAM_LIMIT) {
    return res.status(400).json({ message: "Team slots full" });
  }

  if (phone.startsWith("07")) phone = "254" + phone.substring(1);
  if (phone.startsWith("+254")) phone = phone.substring(1);

  try {
    const token = await getAccessToken();

    const timestamp = new Date().toISOString().replace(/[^0-9]/g, "").slice(0, -3);
    const password = Buffer.from(SHORTCODE + PASSKEY + timestamp).toString("base64");

    const response = await axios.post(
      "https://api.safaricom.co.ke/mpesa/stkpush/v1/processrequest",
      {
        BusinessShortCode: SHORTCODE,
        Password: password,
        Timestamp: timestamp,
        TransactionType: "CustomerBuyGoodsOnline",
        Amount: TEAM_PRICE,
        PartyA: phone,
        PartyB: 6691976, // ✅ FIXED
        PhoneNumber: phone,
        CallBackURL: CALLBACK_URL,
        AccountReference: "TEAM ENTRY",
        TransactionDesc: "Team Registration"
      },
      { headers: { Authorization: `Bearer ${token}` } }
    );

    const checkoutID = response.data.CheckoutRequestID;

    pendingTeamPayments[checkoutID] = {
      teamName,
      captainName,
      phone,
      email
    };

    res.json({ message: "STK sent" });

  } catch (error) {
    console.log("TEAM ERROR:", error.response?.data || error.message);
    res.status(500).json({ message: "Team payment failed" });
  }
});

// =========================
// REGISTER TICKET
// =========================
app.post("/register", async (req, res) => {

  let { fullname, phone, email, ticket: ticketType } = req.body;

  if (phone.startsWith("07")) phone = "254" + phone.substring(1);
  if (phone.startsWith("+254")) phone = phone.substring(1);

  const prices = {
    skill_showcase: 1000,
    head_to_head: 1000,
    spectator: 500
  };

  const amount = prices[ticketType] || 50;

  try {
    const token = await getAccessToken();

    const timestamp = new Date().toISOString().replace(/[^0-9]/g, "").slice(0, -3);
    const password = Buffer.from(SHORTCODE + PASSKEY + timestamp).toString("base64");

    const response = await axios.post(
      "https://api.safaricom.co.ke/mpesa/stkpush/v1/processrequest",
      {
        BusinessShortCode: SHORTCODE,
        Password: password,
        Timestamp: timestamp,
        TransactionType: "CustomerBuyGoodsOnline",
        Amount: amount,
        PartyA: phone,
        PartyB: 6691976, 
        PhoneNumber: phone,
        CallBackURL: CALLBACK_URL,
        AccountReference: "RUGBY DUEL",
        TransactionDesc: "Ticket Payment"
      },
      { headers: { Authorization: `Bearer ${token}` } }
    );

    const checkoutID = response.data.CheckoutRequestID;

    pendingPayments[checkoutID] = {
      fullname,
      phone,
      email,
      ticketType,
      amount
    };

    res.json({ message: "STK sent" });

  } catch (error) {
    res.status(500).json({ message: "Payment failed" });
  }
});

// =========================
// CALLBACK
// =========================
app.post("/callback", async (req, res) => {

  const callback = req.body?.Body?.stkCallback;
  if (!callback) return res.json({ status: "invalid" });

  const checkoutID = callback.CheckoutRequestID;
  const resultCode = callback.ResultCode;

  // TEAM
  if (pendingTeamPayments[checkoutID]) {
    const user = pendingTeamPayments[checkoutID];

    if (resultCode !== 0) {
      failedTeamPayments[user.email] = true;
      delete pendingTeamPayments[checkoutID];
      return res.json({ status: "team_failed" });
    }

    const teamID = "TEAM-" + Date.now();

    const team = { id: teamID, ...user };

    teams.push(team);
    completedTeamPayments[user.email] = team;

    await sendSMS(`🏉 NEW TEAM: ${team.teamName} | Captain: ${team.captainName}`);

    delete pendingTeamPayments[checkoutID];

    return res.json({ status: "team_success" });
  }

  // TICKET
  if (pendingPayments[checkoutID]) {
    const user = pendingPayments[checkoutID];

    if (resultCode !== 0) {
      failedPayments[user.email] = true;
      delete pendingPayments[checkoutID];
      return res.json({ status: "failed" });
    }

    const ticketID = "RUGBY-" + Date.now();

    issuedTickets[ticketID] = {
      name: user.fullname,
      email: user.email,
      category: user.ticketType,
      amount: user.amount
    };

    await sendSMS(`🎟 NEW TICKET: ${user.fullname} | ${user.ticketType}`);

    delete pendingPayments[checkoutID];

    return res.json({ status: "success" });
  }

  res.json({ status: "unknown" });
});

// =========================
app.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});
