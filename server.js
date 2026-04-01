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
// STORAGE
// =========================
let pendingPayments = {};
let issuedTickets = {};
let failedPayments = {};

let teams = [];
let pendingTeamPayments = {};
let failedTeamPayments = {};
let completedTeamPayments = {};

// =========================
app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "index.html"));
});

// =========================
// PAYMENT STATUS (FIXED)
// =========================
app.get("/payment-status", (req, res) => {

    const email = req.query.email;

    if (failedPayments[email]) {
        delete failedPayments[email];
        return res.json({ status: "failed" });
    }

    const ticketEntry = Object.entries(issuedTickets)
        .find(([id, t]) => t.email === email);

    if (ticketEntry) {
        const [ticketID, ticket] = ticketEntry;

        return res.json({
            status: "success",
            ticketID,
            ticket
        });
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
function getCategoryCount(category) {
    return Object.values(issuedTickets)
        .filter(t => t.category === category).length;
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
const TEAM_LIMIT = 8;

app.get("/team-slots", (req, res) => {
    res.json({
        registered: teams.length
    });
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
// REGISTER TICKET
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
app.post("/callback", (req, res) => {

    try {
        const callback = req.body?.Body?.stkCallback;
        if (!callback) return res.json({ status: "invalid" });

        const checkoutID = callback.CheckoutRequestID;
        const resultCode = callback.ResultCode;

        const user = pendingPayments[checkoutID];

        if (!user) return res.json({ status: "not_found" });

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

        res.json({ status: "success" });

    } catch (err) {
        res.json({ status: "error" });
    }
});

// =========================
// 🎟 DOWNLOAD TICKET (🔥 MAIN FIX)
// =========================
app.get("/download-ticket", async (req, res) => {

    try {
        const email = req.query.email;

        const ticketEntry = Object.entries(issuedTickets)
            .find(([id, t]) => t.email === email);

        if (!ticketEntry) {
            return res.status(404).send("Ticket not found");
        }

        const [ticketID, ticket] = ticketEntry;

        const qr = await QRCode.toDataURL(ticketID);

        const doc = new PDFDocument();

        res.setHeader("Content-Type", "application/pdf");
        res.setHeader("Content-Disposition", `attachment; filename=${ticketID}.pdf`);

        doc.pipe(res);

        doc.fontSize(20).text("🏉 Rugby Duel Ticket", { align: "center" });
        doc.moveDown();

        doc.text(`Name: ${ticket.name}`);
        doc.text(`Email: ${ticket.email}`);
        doc.text(`Category: ${ticket.category}`);
        doc.text(`Ticket ID: ${ticketID}`);
        doc.moveDown();

        const qrImage = qr.replace(/^data:image\/png;base64,/, "");
        const qrBuffer = Buffer.from(qrImage, "base64");

        doc.image(qrBuffer, { fit: [150,150], align: "center" });

        doc.moveDown();
        doc.text("Show this QR at entry", { align: "center" });

        doc.end();

    } catch (err) {
        res.status(500).send("Error generating ticket");
    }
});

// =========================
app.listen(PORT, () => {
    console.log("Server running on port " + PORT);
});
