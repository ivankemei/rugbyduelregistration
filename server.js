const express = require("express");
const axios = require("axios");
const bodyParser = require("body-parser");
const QRCode = require("qrcode");
const nodemailer = require("nodemailer");
const path = require("path");

const app = express();
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

// Use Render dynamic port or fallback to 3000 for local testing
const PORT = process.env.PORT || 3000;

// =========================
// MPESA DARAJA CREDENTIALS
// =========================
const consumerKey = "WMIqR7H4yTbcpFwUtudit8OoFDzVd0XrAYx5BFShiX0UdZKV";
const consumerSecret = "NzvROHYIG5PIDlw3LocL8Dh8uFYJaUwIAenBaOXLtDSQ0cA9aHhEmuqLBoww9JsU";
const shortcode = "7677179";
const passkey = "4cb92696ef3d16e754f85c0be0e807dba47c65e56629a8f1dd726c8fb8290c66";

// Update this to your Render domain
const callbackURL = "https://rugbyduelregistration.onrender.com/callback";

// Temporary in-memory storage for pending payments
let pendingPayments = {};

// =========================
// Serve frontend form
// =========================
app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "index.html"));
});

// =========================
// Get access token from Daraja
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
// Register and send STK Push
// =========================
app.post("/register", async (req, res) => {
    const { fullname, phone, email, ticket: amount } = req.body;

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
            { headers: { Authorization: `Bearer ${token}` } }
        );

        const checkoutID = response.data.CheckoutRequestID;

        // Store user data temporarily
        pendingPayments[checkoutID] = { fullname, phone, email, amount };

        res.json({ message: "STK Push sent. Check your phone and enter your M-Pesa PIN." });
    } catch (error) {
        console.error("STK Push error:", error.response?.data || error.message);
        res.status(500).json({ message: "Payment failed. Try again." });
    }
});

// =========================
// Callback endpoint for Daraja
// =========================
app.post("/callback", async (req, res) => {
    const data = req.body.Body?.stkCallback;
    if (!data) return res.status(400).json({ status: "invalid callback" });

    const { CheckoutRequestID: checkoutID, ResultCode: resultCode } = data;

    if (resultCode === 0) {
        const user = pendingPayments[checkoutID];
        if (!user) return res.json({ status: "unknown user" });

        try {
            // Generate ticket and QR code
            const ticketID = `RUGBY-${Math.floor(Math.random() * 1000000)}`;
            const qrCodeDataURL = await QRCode.toDataURL(ticketID);

            // Send email with ticket
            const transporter = nodemailer.createTransport({
                service: "gmail",
                auth: {
                    user: "ivankemei3@gmail.com",
                    pass: "YOUR_GMAIL_APP_PASSWORD" // ⚠ Use App Password, NOT normal Gmail password
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
                    <img src="${qrCodeDataURL}" />
                `
            };

            await transporter.sendMail(mailOptions);
            console.log(`Ticket sent to ${user.email}`);

            // Remove from pending
            delete pendingPayments[checkoutID];
        } catch (err) {
            console.error("Error sending email:", err.message);
        }
    }

    res.json({ status: "received" });
});

// =========================
// Start server
// =========================
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);

});



