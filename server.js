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
// TEAM SYSTEM
// =========================
const TEAM_LIMIT = 8;
const TEAM_PRICE = 5000;

let teams = [];
let pendingTeamPayments = {};
let failedTeamPayments = {};
let completedTeamPayments = {};

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
// ✅ PAYMENT STATUS (🔥 FIX)
// =========================
app.get("/payment-status", (req, res) => {

    const email = req.query.email;

    // ❌ Failed
    if (failedPayments[email]) {
        delete failedPayments[email];
        return res.json({ status: "failed" });
    }

    // ✅ Success
    const ticket = Object.values(issuedTickets).find(t => t.email === email);

    if (ticket) {
        return res.json({ status: "success", ticket });
    }

    // ⏳ Still waiting
    return res.json({ status: "pending" });
});

// =========================
// TEAM STATUS (ALREADY GOOD)
// =========================
app.get("/team_status", (req, res) => {

    const email = req.query.email;

    if (failedTeamPayments[email]) {
        delete failedTeamPayments[email];
        return res.json({ status: "failed" });
    }

    if (completedTeamPayments[email]) {
        return res.json({
            status: "paid",
            team: completedTeamPayments[email]
        });
    }

    res.json({ status: "pending" });
});

// =========================
// SLOTS
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
// ACCESS TOKEN
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
// TEAM REGISTER
// =========================
app.post("/register-team", async (req, res) => {

    let { teamName, captainName, phone, email } = req.body;

    if (!teamName || !captainName || !phone || !email) {
        return res.status(400).json({ message: "All fields required" });
    }

    if (teams.length >= TEAM_LIMIT) {
        return res.status(400).json({ message: "All team slots are taken" });
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
        res.status(500).json({ message: "Team payment failed." });
    }
});

// =========================
// REGISTER (TICKET)
// =========================
app.post("/register", async (req, res) => {

    let { fullname, phone, email, ticket: ticketType } = req.body;

    if (phone.startsWith("07")) phone = "254" + phone.substring(1);
    if (phone.startsWith("+254")) phone = phone.substring(1);

    const prices = {
        skill_showcase: 1000,
        head_to_head: 5,
        spectator: 5
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
        res.status(500).json({ message: "Payment failed." });
    }
});

// =========================
// CALLBACK
// =========================
app.post("/callback", async (req, res) => {

    try {
        const callback = req.body?.Body?.stkCallback;
        if (!callback) return res.json({ status: "invalid" });

        const checkoutID = callback.CheckoutRequestID;
        const resultCode = callback.ResultCode;

        // TEAM
        if (pendingTeamPayments[checkoutID]) {
            const teamUser = pendingTeamPayments[checkoutID];

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

            delete pendingPayments[checkoutID];

            return res.json({ status: "success" });
        }

        res.json({ status: "unknown" });

    } catch (err) {
        res.json({ status: "error" });
    }
});

// =========================
app.listen(PORT, () => {
    console.log("Server running on port " + PORT);
});
