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
// MPESA DARAJA CREDENTIALS (UNCHANGED)
// =========================
const consumerKey = "WMIqR7H4yTbcpFwUtudit8OoFDzVd0XrAYx5BFShiX0UdZKV";
const consumerSecret = "NzvROHYIG5PIDlw3LocL8Dh8uFYJaUwIAenBaOXLtDSQ0cA9aHhEmuqLBoww9JsU";
const shortcode = "7677179";
const passkey = "4cb92696ef3d16e754f85c0be0e807dba47c65e56629a8f1dd726c8fb8290c66";

const callbackURL = "https://rugbyduelregistration.onrender.com/callback";

// =========================
// TEMP STORAGE
// =========================
let pendingPayments = {}; // { checkoutID: { fullname, phone, email, ticket } }
let issuedTickets = {};   // { ticketID: { name, email, used, qr, category } }

// =========================
// SERVE FRONTEND
// =========================
app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "index.html"));
});

// =========================
// GET ACCESS TOKEN
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
    let { fullname, phone, email, ticket: ticketType } = req.body;

    if (phone.startsWith("07")) phone = "254" + phone.substring(1);
    if (phone.startsWith("+254")) phone = phone.substring(1);

    // Ticket type -> amount mapping
    const ticketPrices = {
        skill_showcase: 1000,
        head_to_head: 1000,
        spectator: 50
    };
    const amount = ticketPrices[ticketType] || 50;

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
                AccountReference: "IVAN KIPLAGAT KEMEI",
                TransactionDesc: "Ticket Payment"
            },
            { headers: { Authorization: `Bearer ${token}` } }
        );

        const checkoutID = response.data.CheckoutRequestID;

        pendingPayments[checkoutID] = { fullname, phone, email, ticketType };

        console.log("📤 STK RESPONSE:", response.data);

        res.json({ message: "Check your phone and enter your M-Pesa PIN." });

    } catch (error) {
        console.error("❌ STK ERROR:", error.response?.data || error.message);
        res.status(500).json({ message: "Payment failed." });
    }
});

// =========================
// MPESA CALLBACK
// =========================
app.post("/callback", async (req, res) => {
    try {
        const callback = req.body?.Body?.stkCallback;

        if (!callback) {
            console.log("❌ Invalid callback:", req.body);
            return res.status(400).json({ status: "Invalid callback" });
        }

        console.log("📩 MPESA CALLBACK:", callback);

        const checkoutID = callback.CheckoutRequestID;
        const resultCode = callback.ResultCode;
        const metadata = callback.CallbackMetadata?.Item || [];

        if (resultCode !== 0) {
            console.log("❌ Payment Failed:", callback.ResultDesc);
            delete pendingPayments[checkoutID];
            return res.json({ status: "failed" });
        }

        const user = pendingPayments[checkoutID];
        if (!user) {
            console.log("⚠️ User not found:", checkoutID);
            return res.json({ status: "user_not_found" });
        }

        let amount = 0;
        let receipt = "N/A";
        metadata.forEach(item => {
            if (item.Name === "Amount") amount = item.Value;
            if (item.Name === "MpesaReceiptNumber") receipt = item.Value;
        });

        const ticketID = "RUGBY-" + Date.now();
        const qr = await QRCode.toDataURL(ticketID);

        issuedTickets[ticketID] = {
            name: user.fullname,
            email: user.email,
            used: false,
            qr,
            category: user.ticketType,
            amount,
            receipt
        };

        // Send ticket via email
        try {
            const transporter = nodemailer.createTransport({
                service: "gmail",
                auth: {
                    user: "ivankemei3@gmail.com",
                    pass: "yjzx rltb qjle wchc"
                }
            });

            await transporter.sendMail({
                from: "ivankemei3@gmail.com",
                to: user.email,
                subject: "🎟️ Your Rugby Duel Ticket",
                html: `
                    <h2>🏉 Rugby Duel Ticket</h2>
                    <p><b>Name:</b> ${user.fullname}</p>
                    <p><b>Ticket ID:</b> ${ticketID}</p>
                    <p><b>Category:</b> ${user.ticketType}</p>
                    <p><b>Amount Paid:</b> Ksh ${amount}</p>
                    <p><b>Receipt:</b> ${receipt}</p>
                    <p><b>Date:</b> 18th April 2026</p>
                    <p><b>Venue:</b> Eldoret Sports Club</p>
                    <img src="${qr}" />
                    <p><a href="https://rugbyduelregistration.onrender.com/ticket/${ticketID}">View Your Ticket</a></p>
                `
            });
            console.log("📧 Ticket sent to:", user.email);
        } catch (err) {
            console.error("❌ Email Error:", err.message);
        }

        delete pendingPayments[checkoutID];
        res.json({ status: "success" });

    } catch (err) {
        console.error("❌ Callback Error:", err.message);
        res.json({ status: "error" });
    }
});

// =========================
// TICKET STATUS ENDPOINT (frontend polling)
// =========================
app.get("/ticket_status", (req, res) => {
    const email = req.query.email;
    const ticket = Object.entries(issuedTickets).find(([id, t]) => t.email === email);
    if (ticket) {
        const [id, t] = ticket;
        return res.json({
            status: "paid",
            ticket: {
                id,
                name: t.name,
                qr: t.qr,
                category: t.category,
                amount: t.amount
            }
        });
    }
    res.json({ status: "pending" });
});

// =========================
// VIEW TICKET
// =========================
app.get("/ticket/:id", async (req, res) => {
    const ticketID = req.params.id;
    const ticket = issuedTickets[ticketID];
    if (!ticket) return res.send("Ticket not found");
    res.send(`
        <h1>🏉 Rugby Duel Ticket</h1>
        <p>Ticket ID: ${ticketID}</p>
        <p>Category: ${ticket.category}</p>
        <img src="${ticket.qr}" />
    `);
});

// =========================
// VERIFY (QR SCAN)
// =========================
app.get("/verify/:ticketID", (req, res) => {
    const ticketID = req.params.ticketID;
    const ticket = issuedTickets[ticketID];
    if (!ticket) return res.json({ valid: false, message: "Invalid ticket" });
    if (ticket.used) return res.json({ valid: false, message: "Ticket already used" });
    ticket.used = true;
    res.json({ valid: true, name: ticket.name });
});

// =========================
// ADMIN DASHBOARD
// =========================
app.get("/admin", (req, res) => {
    let rows = "";
    for (const id in issuedTickets) {
        const t = issuedTickets[id];
        rows += `<tr><td>${id}</td><td>${t.name}</td><td>${t.used ? "USED" : "VALID"}</td></tr>`;
    }
    res.send(`
        <h1>Rugby Duel Admin</h1>
        <table border="1">
        <tr><th>Ticket</th><th>Name</th><th>Status</th></tr>
        ${rows}
        </table>
    `);
});

// =========================
// START SERVER
// =========================
app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
});
