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
// STORAGE
// =========================
let pendingPayments = {};
let issuedTickets = {};
let failedPayments = {};

let teams = [];
let pendingTeamPayments = {};
let failedTeamPayments = {};
let completedTeamPayments = {};

const TEAM_PRICE = 5000;
const TEAM_LIMIT = 8;

// =========================
app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "index.html"));
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
// PAYMENT STATUS (TICKETS)
// =========================
app.get("/payment-status", (req, res) => {

    const email = req.query.email;

    if (failedPayments[email]) {
        delete failedPayments[email];
        return res.json({ status: "failed" });
    }

    const entry = Object.entries(issuedTickets)
        .find(([id, t]) => t.email === email);

    if (entry) {
        const [ticketID, ticket] = entry;

        return res.json({
            status: "success",
            ticketID,
            ticket
        });
    }

    return res.json({ status: "pending" });
});

// =========================
// TEAM STATUS (🔥 NEW FIX)
// =========================
app.get("/team_status", (req, res) => {

    const email = req.query.email;

    if (failedTeamPayments[email]) {
        delete failedTeamPayments[email];
        return res.json({ status: "failed" });
    }

    if (completedTeamPayments[email]) {
        return res.json({
            status: "success",
            team: completedTeamPayments[email]
        });
    }

    return res.json({ status: "pending" });
});

// =========================
// TEAM REGISTER (🔥 FIXED)
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
                PartyB: shortcode,
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
        console.log(error.response?.data || error.message);
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
                PartyB: shortcode,
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
        res.status(500).json({ message: "Payment failed" });
    }
});

// =========================
// CALLBACK (🔥 FULL FIX)
// =========================
app.post("/callback", (req, res) => {

    try {
        const callback = req.body?.Body?.stkCallback;
        if (!callback) return res.json({ status: "invalid" });

        const checkoutID = callback.CheckoutRequestID;
        const resultCode = callback.ResultCode;

        // ===== TEAM =====
        if (pendingTeamPayments[checkoutID]) {
            const user = pendingTeamPayments[checkoutID];

            if (resultCode !== 0) {
                failedTeamPayments[user.email] = true;
                delete pendingTeamPayments[checkoutID];
                return res.json({ status: "team_failed" });
            }

            const teamID = "TEAM-" + Date.now();

            const team = {
                id: teamID,
                teamName: user.teamName,
                captainName: user.captainName,
                phone: user.phone,
                email: user.email
            };

            teams.push(team);
            completedTeamPayments[user.email] = team;

            delete pendingTeamPayments[checkoutID];

            return res.json({ status: "team_success" });
        }

        // ===== TICKET =====
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
// 🎟 DOWNLOAD TICKET
// =========================
app.get("/download-ticket", async (req, res) => {

    try {
        const email = req.query.email;

        const entry = Object.entries(issuedTickets)
            .find(([id, t]) => t.email === email);

        if (!entry) return res.status(404).send("Ticket not found");

        const [ticketID, ticket] = entry;

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

        const qrBuffer = Buffer.from(qr.split(",")[1], "base64");
        doc.image(qrBuffer, { fit: [150,150], align: "center" });

        doc.end();

    } catch (err) {
        res.status(500).send("Error generating ticket");
    }
});

// =========================
// 🏉 DOWNLOAD TEAM TICKET (🔥 NEW)
// =========================
app.get("/download-team-ticket", async (req, res) => {

    try {
        const email = req.query.email;
        const team = completedTeamPayments[email];

        if (!team) return res.status(404).send("Team not found");

        const qr = await QRCode.toDataURL(team.id);

        const doc = new PDFDocument();

        res.setHeader("Content-Type", "application/pdf");
        res.setHeader("Content-Disposition", `attachment; filename=${team.id}.pdf`);

        doc.pipe(res);

        doc.fontSize(20).text("🏉 Rugby Duel TEAM Ticket", { align: "center" });
        doc.moveDown();

        doc.text(`Team: ${team.teamName}`);
        doc.text(`Captain: ${team.captainName}`);
        doc.text(`Phone: ${team.phone}`);
        doc.text(`Team ID: ${team.id}`);
        doc.moveDown();

        const qrBuffer = Buffer.from(qr.split(",")[1], "base64");
        doc.image(qrBuffer, { fit: [150,150], align: "center" });

        doc.end();

    } catch (err) {
        res.status(500).send("Error generating team ticket");
    }
});

// =========================
app.listen(PORT, () => {
    console.log("Server running on port " + PORT);
});
