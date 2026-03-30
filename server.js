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
let teams = [];

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
// TEAM SLOTS (FIXED ✅)
// =========================
function getTeamSlots() {
    return {
        total: TEAM_LIMIT,
        registered: teams.length,
        remaining: Math.max(TEAM_LIMIT - teams.length, 0),
        teams
    };
}

// Support BOTH routes
app.get("/team_slots", (req, res) => {
    res.json(getTeamSlots());
});

app.get("/team-slots", (req, res) => {
    res.json(getTeamSlots());
});

// =========================
// TEAM REGISTRATION (FIXED ROUTES)
// =========================
function registerTeamHandler(req, res) {
    const { teamName, captainName, phone } = req.body;

    if (!teamName || !captainName || !phone) {
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

    const team = {
        id: "TEAM-" + Date.now(),
        teamName,
        captainName,
        phone
    };

    teams.push(team);

    res.json({
        message: "Team registered successfully",
        team
    });
}

// Support BOTH routes
app.post("/register_team", registerTeamHandler);
app.post("/register-team", registerTeamHandler);

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
// REGISTER
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
// CALLBACK (UNCHANGED)
// =========================
app.post("/callback", async (req, res) => {

    try {
        const callback = req.body?.Body?.stkCallback;
        if (!callback) return res.json({ status: "invalid" });

        const checkoutID = callback.CheckoutRequestID;
        const resultCode = callback.ResultCode;

        const user = pendingPayments[checkoutID];

        if (resultCode !== 0) {
            if (user) failedPayments[user.email] = true;
            delete pendingPayments[checkoutID];
            return res.json({ status: "failed" });
        }

        if (!callback.CallbackMetadata) {
            if (user) failedPayments[user.email] = true;
            delete pendingPayments[checkoutID];
            return res.json({ status: "failed" });
        }

        const metadata = callback.CallbackMetadata.Item || [];

        let receipt = null;
        let amount = null;

        metadata.forEach(item => {
            if (item.Name === "MpesaReceiptNumber") receipt = item.Value;
            if (item.Name === "Amount") amount = item.Value;
        });

        if (!receipt || !amount) {
            if (user) failedPayments[user.email] = true;
            delete pendingPayments[checkoutID];
            return res.json({ status: "failed" });
        }

        if (!user) return res.json({ status: "user_not_found" });

        const currentCount = getCategoryCount(user.ticketType);
        const limit = LIMITS[user.ticketType];

        if (currentCount >= limit) {
            delete pendingPayments[checkoutID];
            return res.json({ status: "limit_reached" });
        }

        const existing = Object.values(issuedTickets).find(t => t.receipt === receipt);
        if (existing) {
            delete pendingPayments[checkoutID];
            return res.json({ status: "duplicate" });
        }

        const ticketID = "RUGBY-" + Date.now();
        const qr = await QRCode.toDataURL(ticketID);

        const dir = path.join(__dirname, "tickets");
        if (!fs.existsSync(dir)) fs.mkdirSync(dir);

        const pdfPath = path.join(dir, `${ticketID}.pdf`);
        const doc = new PDFDocument({ size: "A4" });
        const stream = fs.createWriteStream(pdfPath);

        doc.pipe(stream);

        doc.text("RUGBY DUEL TICKET");
        doc.text(`Name: ${user.fullname}`);
        doc.text(`Ticket ID: ${ticketID}`);
        doc.text(`Category: ${user.ticketType}`);
        doc.text(`Amount: Ksh ${amount}`);
        doc.text(`Receipt: ${receipt}`);

        doc.image(qr, { fit: [150, 150] });

        doc.end();

        stream.on("finish", async () => {

            issuedTickets[ticketID] = {
                name: user.fullname,
                email: user.email,
                used: false,
                category: user.ticketType,
                amount,
                receipt,
                pdfPath,
                qr
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
// STATUS
// =========================
app.get("/ticket_status", (req, res) => {

    const email = req.query.email;

    if (failedPayments[email]) {
        delete failedPayments[email];
        return res.json({ status: "failed" });
    }

    const entry = Object.entries(issuedTickets).find(([id, t]) => t.email === email);

    if (entry) {
        const [id, t] = entry;
        return res.json({
            status: "paid",
            ticket: {
                id,
                name: t.name,
                category: t.category,
                amount: t.amount,
                qr: t.qr
            }
        });
    }

    res.json({ status: "pending" });
});

// =========================
app.listen(PORT, () => {
    console.log("Server running on port " + PORT);
});
