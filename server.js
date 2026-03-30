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
let pendingTeamPayments = {}; // 🔥 NEW

// =========================
let pendingPayments = {};
let issuedTickets = {};
let failedPayments = {};
let failedTeamPayments = {}; // 🔥 NEW

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

app.get("/team-slots", (req, res) => {
    res.json(getTeamSlots());
});

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
// 🆕 TEAM REGISTER (WITH PAYMENT)
// =========================
app.post("/register-team", async (req, res) => {

    let { teamName, captainName, phone } = req.body;

    if (!teamName || !captainName || !phone) {
        return res.status(400).json({ message: "All fields required" });
    }

    if (teams.length >= TEAM_LIMIT) {
        return res.status(400).json({ message: "All team slots are taken" });
    }

    const exists = teams.find(t =>
        t.teamName.toLowerCase() === teamName.toLowerCase()
    );

    if (exists) {
        return res.status(400).json({ message: "Team already registered" });
    }

    // FORMAT PHONE
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
            phone
        };

        res.json({ message: "STK push sent for team registration" });

    } catch (error) {
        console.error("TEAM STK ERROR:", error.response?.data || error.message);
        res.status(500).json({ message: "Team payment failed" });
    }
});

// =========================
// CALLBACK (UPDATED)
// =========================
app.post("/callback", async (req, res) => {

    try {
        const callback = req.body?.Body?.stkCallback;
        if (!callback) return res.json({ status: "invalid" });

        const checkoutID = callback.CheckoutRequestID;
        const resultCode = callback.ResultCode;

        // ================= TEAM PAYMENT =================
        const teamUser = pendingTeamPayments[checkoutID];

        if (teamUser) {

            if (resultCode !== 0) {
                failedTeamPayments[teamUser.phone] = true;
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
            delete pendingTeamPayments[checkoutID];

            return res.json({ status: "team_registered" });
        }

        // ================= NORMAL TICKET FLOW =================
        const user = pendingPayments[checkoutID];

        if (resultCode !== 0) {
            if (user) failedPayments[user.email] = true;
            delete pendingPayments[checkoutID];
            return res.json({ status: "failed" });
        }

        if (!user) return res.json({ status: "user_not_found" });

        const ticketID = "RUGBY-" + Date.now();
        const qr = await QRCode.toDataURL(ticketID);

        const dir = path.join(__dirname, "tickets");
        if (!fs.existsSync(dir)) fs.mkdirSync(dir);

        const pdfPath = path.join(dir, `${ticketID}.pdf`);
        const doc = new PDFDocument();
        const stream = fs.createWriteStream(pdfPath);

        doc.pipe(stream);
        doc.text("RUGBY DUEL TICKET");
        doc.text(`Name: ${user.fullname}`);
        doc.text(`Ticket ID: ${ticketID}`);
        doc.text(`Category: ${user.ticketType}`);
        doc.text(`Amount: Ksh ${user.amount}`);
        doc.image(qr, { fit: [150, 150] });
        doc.end();

        stream.on("finish", () => {
            issuedTickets[ticketID] = {
                name: user.fullname,
                email: user.email,
                category: user.ticketType,
                amount: user.amount,
                pdfPath
            };

            delete pendingPayments[checkoutID];
        });

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
