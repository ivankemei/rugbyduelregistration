require("dotenv").config();

const express = require("express");
const axios = require("axios");
const bodyParser = require("body-parser");
const QRCode = require("qrcode");
const nodemailer = require("nodemailer");
const path = require("path");
const PDFDocument = require("pdfkit");
const fs = require("fs");

const app = express();

// ✅ OPTIONAL (fixes fetch issues if frontend/backend differ)
const cors = require("cors");
app.use(cors());

app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

const PORT = process.env.PORT || 3000;

// =========================
// ENV VARIABLES
// =========================
const consumerKey = process.env.CONSUMER_KEY;
const consumerSecret = process.env.CONSUMER_SECRET;
const shortcode = process.env.SHORTCODE;
const passkey = process.env.PASSKEY;
const callbackURL = process.env.CALLBACK_URL;

// =========================
// LIMITS
// =========================
const LIMITS = {
    skill_showcase: 32,
    head_to_head: 32,
    spectator: Infinity
};

// =========================
// TEAM SYSTEM (UPDATED 🔥)
// =========================
const TEAM_LIMIT = 8;
const TEAM_PRICE = 5000;

let teams = [];
let pendingTeamPayments = {};
let failedTeamPayments = {};
let completedTeamPayments = {}; // ✅ NEW

// =========================
let pendingPayments = {};
let issuedTickets = {};
let failedPayments = {};

// =========================
app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "index.html"));
});

// =========================
// COUNT FUNCTION
// =========================
function getCategoryCount(category) {
    return Object.values(issuedTickets).filter(t => t.category === category).length;
}

// =========================
// SLOTS ENDPOINT
// =========================
app.get("/slots", (req, res) => {
    const remaining = {
        skill_showcase: Math.max(LIMITS.skill_showcase - getCategoryCount("skill_showcase"), 0),
        head_to_head: Math.max(LIMITS.head_to_head - getCategoryCount("head_to_head"), 0)
    };
    res.json(remaining);
});

// =========================
// TEAM SLOTS
// =========================
function getTeamSlots() {
    return {
        total: TEAM_LIMIT,
        registered: teams.length,
        remaining: Math.max(TEAM_LIMIT - teams.length, 0),
        teams
    };
}

app.get("/team_slots", (req, res) => res.json(getTeamSlots()));
app.get("/team-slots", (req, res) => res.json(getTeamSlots()));

// =========================
// TEAM REGISTER (STK)
// =========================
app.post("/register-team", async (req, res) => {

    let { teamName, captainName, phone, email } = req.body;

    if (!teamName || !captainName || !phone || !email) {
        return res.status(400).json({ message: "All fields required" });
    }

    if (teams.length >= TEAM_LIMIT) {
        return res.status(400).json({ message: "All team slots are taken" });
    }

    const exists = teams.find(
        t => t.teamName.toLowerCase() === teamName.toLowerCase()
    );

    if (exists) {
        return res.status(400).json({ message: "Team already registered" });
    }

    if (phone.startsWith("07")) phone = "254" + phone.substring(1);
    if (phone.startsWith("+254")) phone = phone.substring(1);

    try {
        const token = await getAccessToken();

        const timestamp = new Date().toISOString().replace(/[^0-9]/g, "").slice(0, -3);
        const password = Buffer.from(shortcode + passkey + timestamp).toString("base64");

        const response = await axios.post(
            "https://api.safaricom.co.ke/mpesa/stkpush/v1/processrequest",
            {
                BusinessShortCode: shortcode,
                Password: password,
                Timestamp: timestamp,
                TransactionType: "CustomerBuyGoodsOnline",
                Amount: TEAM_PRICE,
                PartyA: phone,
                PartyB: "6691976",
                PhoneNumber: phone,
                CallBackURL: callbackURL,
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

        res.json({ message: "STK push sent for team" });

    } catch (error) {
        console.error("TEAM STK ERROR:", error.response?.data || error.message);
        res.status(500).json({ message: "Team payment failed." });
    }
});

// =========================
async function getAccessToken() {
    const auth = Buffer.from(`${consumerKey}:${consumerSecret}`).toString("base64");

    const response = await axios.get(
        "https://api.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials",
        { headers: { Authorization: `Basic ${auth}` } }
    );

    return response.data.access_token;
}

// =========================
// TEAM STATUS (NEW ✅)
// =========================
app.get("/team_status", (req, res) => {

    const email = req.query.email;

    if (failedTeamPayments[email]) {
        delete failedTeamPayments[email];
        return res.json({ status: "failed" });
    }

    if (completedTeamPayments[email]) {
        const team = completedTeamPayments[email];
        return res.json({
            status: "paid",
            team
        });
    }

    res.json({ status: "pending" });
});

// =========================
// REGISTER (UNCHANGED)
// =========================
app.post("/register", async (req, res) => {

    let { fullname, phone, email, ticket: ticketType } = req.body;

    if (phone.startsWith("07")) phone = "254" + phone.substring(1);
    if (phone.startsWith("+254")) phone = phone.substring(1);

    const currentCount = getCategoryCount(ticketType);
    const limit = LIMITS[ticketType];

    if (currentCount >= limit) {
        return res.status(400).json({ message: "Category is full" });
    }

    const prices = {
        skill_showcase: 1000,
        head_to_head: 1000,
        spectator: 500
    };

    const amount = prices[ticketType] || 50;

    try {
        const token = await getAccessToken();

        const timestamp = new Date().toISOString().replace(/[^0-9]/g, "").slice(0, -3);
        const password = Buffer.from(shortcode + passkey + timestamp).toString("base64");

        const response = await axios.post(
            "https://api.safaricom.co.ke/mpesa/stkpush/v1/processrequest",
            {
                BusinessShortCode: shortcode,
                Password: password,
                Timestamp: timestamp,
                TransactionType: "CustomerBuyGoodsOnline",
                Amount: amount,
                PartyA: phone,
                PartyB: "6691976",
                PhoneNumber: phone,
                CallBackURL: callbackURL,
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

        res.json({ message: "STK push sent" });

    } catch (error) {
        console.error("STK ERROR:", error.response?.data || error.message);
        res.status(500).json({ message: "Payment failed." });
    }
});

// =========================
// ✅ ADMIN DATA (ADDED ONLY)
// =========================
app.get("/admin-data", (req, res) => {
    try {
        const skill = getCategoryCount("skill_showcase");
        const head = getCategoryCount("head_to_head");
        const spectator = getCategoryCount("spectator");

        const total = skill + head + spectator;

        res.json({
            total,
            skill_showcase: skill,
            head_to_head: head,
            spectator,
            teams: teams.length
        });

    } catch (err) {
        console.error("Admin data error:", err.message);
        res.status(500).json({ message: "Failed to load admin data" });
    }
});

// =========================
// CALLBACK (UNCHANGED)
// =========================
app.post("/callback", async (req, res) => {

    try {
        const callback = req.body?.Body?.stkCallback;
        if (!callback) return res.json({ status: "invalid" });

        const checkoutID = callback.CheckoutRequestID;
        const resultCode = callback.ResultCode;

        const teamUser = pendingTeamPayments[checkoutID];

        if (teamUser) {

            if (resultCode !== 0) {
                failedTeamPayments[teamUser.email] = true;
                delete pendingTeamPayments[checkoutID];
                return res.json({ status: "failed" });
            }

            const team = {
                id: "TEAM-" + Date.now(),
                teamName: teamUser.teamName,
                captainName: teamUser.captainName,
                phone: teamUser.phone
            };

            teams.push(team);

            completedTeamPayments[teamUser.email] = team;

            delete pendingTeamPayments[checkoutID];

            return res.json({ status: "team_registered" });
        }

        const user = pendingPayments[checkoutID];

        if (resultCode !== 0) {
            if (user) failedPayments[user.email] = true;
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

        delete pendingPayments[checkoutID];

        res.json({ status: "success" });

    } catch (err) {
        console.error("Callback Error:", err.message);
        res.json({ status: "error" });
    }
});

// =========================
app.listen(PORT, () => {
    console.log("Server running on port " + PORT);
});
