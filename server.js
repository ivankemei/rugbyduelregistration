const express = require("express");
const axios = require("axios");
const bodyParser = require("body-parser");
const QRCode = require("qrcode");
const nodemailer = require("nodemailer");
const path = require("path");

const app = express();
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

const PORT = process.env.PORT || 3000;

// =========================
// MPESA DARAJA CREDENTIALS
// =========================
const consumerKey = "WMIqR7H4yTbcpFwUtudit8OoFDzVd0XrAYx5BFShiX0UdZKV";
const consumerSecret = "NzvROHYIG5PIDlw3LocL8Dh8uFYJaUwIAenBaOXLtDSQ0cA9aHhEmuqLBoww9JsU";
const shortcode = "7677179";
const passkey = "4cb92696ef3d16e754f85c0be0e807dba47c65e56629a8f1dd726c8fb8290c66";

const callbackURL = "https://rugbyduelregistration.onrender.com/callback";

// Temporary memory storage
let pendingPayments = {};
let issuedTickets = {};

// =========================
// Serve Frontend
// =========================
app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "index.html"));
});

// =========================
// Access Token
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
// REGISTER + STK PUSH
// =========================
app.post("/register", async (req, res) => {

    let { fullname, phone, email, ticket: amount } = req.body;

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
                TransactionType: "CustomerPayBillOnline",
                Amount: amount,
                PartyA: phone,
                PartyB: shortcode,
                PhoneNumber: phone,
                CallBackURL: callbackURL,
                AccountReference: "RugbyDuel",
                TransactionDesc: "Ticket Payment"
            },
            {
                headers: { Authorization: `Bearer ${token}` }
            }
        );

        console.log("STK RESPONSE:", response.data);

        const checkoutID = response.data.CheckoutRequestID;

        pendingPayments[checkoutID] = {
            fullname,
            phone,
            email,
            amount
        };

        res.json({
            message: "STK Push sent. Check your phone and enter your M-Pesa PIN."
        });

    } catch (error) {

        console.error("STK ERROR:", error.response?.data || error.message);

        res.status(500).json({
            message: "Payment failed."
        });

    }

});

// =========================
// MPESA CALLBACK
// =========================
app.post("/callback", async (req, res) => {

    const data = req.body.Body?.stkCallback;

    if (!data) return res.status(400).json({ status: "Invalid callback" });

    const checkoutID = data.CheckoutRequestID;
    const resultCode = data.ResultCode;

    console.log("MPESA CALLBACK:", data);

    if (resultCode === 0) {

        const user = pendingPayments[checkoutID];
        if (!user) return res.json({ status: "User not found" });

        try {

            const ticketID = "RUGBY-" + Math.floor(Math.random() * 1000000);

            issuedTickets[ticketID] = {
                name: user.fullname,
                used: false
            };

            const qr = await QRCode.toDataURL(ticketID);

            const transporter = nodemailer.createTransport({
                service: "gmail",
                auth: {
                    user: "ivankemei3@gmail.com",
                    pass: "YOUR_GMAIL_APP_PASSWORD"
                }
            });

            const mailOptions = {
                from: "ivankemei3@gmail.com",
                to: user.email,
                subject: "Your Rugby Duel Ticket",
                html: `
                    <h2>Rugby Duel Ticket</h2>
                    <p>Name: ${user.fullname}</p>
                    <p>Ticket ID: ${ticketID}</p>
                    <p>Date: 18th April 2026</p>
                    <p>Venue: Eldoret Sports Club</p>
                    <img src="${qr}" />
                    <p>View ticket: https://rugbyduelregistration.onrender.com/ticket/${ticketID}</p>
                `
            };

            await transporter.sendMail(mailOptions);

            console.log("Ticket sent to:", user.email);

            delete pendingPayments[checkoutID];

        } catch (err) {

            console.error("Email error:", err.message);

        }

    }

    res.json({ status: "received" });

});

// =========================
// VIEW TICKET PAGE
// =========================
app.get("/ticket/:id", async (req, res) => {

    const ticketID = req.params.id;

    if (!issuedTickets[ticketID]) {
        return res.send("Ticket not found");
    }

    const qr = await QRCode.toDataURL(ticketID);

    res.send(`
        <h1>Rugby Duel Ticket</h1>
        <p>Ticket ID: ${ticketID}</p>
        <img src="${qr}" />
    `);

});

// =========================
// VERIFY TICKET (QR SCAN)
// =========================
app.get("/verify/:ticketID", (req, res) => {

    const ticketID = req.params.ticketID;

    const ticket = issuedTickets[ticketID];

    if (!ticket) {
        return res.json({ valid: false, message: "Invalid ticket" });
    }

    if (ticket.used) {
        return res.json({ valid: false, message: "Ticket already used" });
    }

    ticket.used = true;

    res.json({
        valid: true,
        name: ticket.name
    });

});

// =========================
// ADMIN DASHBOARD
// =========================
app.get("/admin", (req, res) => {

    let rows = "";

    for (const id in issuedTickets) {

        const ticket = issuedTickets[id];

        rows += `
        <tr>
            <td>${id}</td>
            <td>${ticket.name}</td>
            <td>${ticket.used ? "USED" : "VALID"}</td>
        </tr>
        `;

    }

    res.send(`
        <h1>Rugby Duel Admin</h1>
        <table border="1">
        <tr>
            <th>Ticket</th>
            <th>Name</th>
            <th>Status</th>
        </tr>
        ${rows}
        </table>
    `);

});

// =========================
// START SERVER
// =========================
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});