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
let pendingPayments = {};
let issuedTickets = {};
let failedPayments = {};

// =========================
app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "index.html"));
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
// REGISTER
// =========================
app.post("/register", async (req, res) => {

    let { fullname, phone, email, ticket: ticketType } = req.body;

    if (phone.startsWith("07")) phone = "254" + phone.substring(1);
    if (phone.startsWith("+254")) phone = phone.substring(1);

    const prices = {
        skill_showcase: 1000,
        head_to_head: 1000,
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
        console.error("STK ERROR:", error.response?.data || error.message);
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

        const user = pendingPayments[checkoutID];

        // ❌ FAIL OR CANCEL
        if (resultCode !== 0) {
            if (user) failedPayments[user.email] = true;
            delete pendingPayments[checkoutID];
            return res.json({ status: "failed" });
        }

        // ❌ MUST HAVE METADATA
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

        // جلوگیری duplicate ticket
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

            // EMAIL
            try {
                const transporter = nodemailer.createTransport({
                    service: "gmail",
                    auth: {
                        user: process.env.EMAIL_USER,
                        pass: process.env.EMAIL_PASS
                    }
                });

                await transporter.sendMail({
                    from: process.env.EMAIL_USER,
                    to: user.email,
                    subject: "Your Rugby Duel Ticket",
                    html: `<h2>Your Ticket</h2><p>ID: ${ticketID}</p>`,
                    attachments: [{ filename: `${ticketID}.pdf`, path: pdfPath }]
                });

                console.log("Email sent");
            } catch (err) {
                console.error("Email error:", err.message);
            }

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
// DOWNLOAD
// =========================
app.get("/download/:id", (req, res) => {
    const t = issuedTickets[req.params.id];
    if (!t) return res.send("Not found");
    res.download(t.pdfPath);
});

// =========================
// VERIFY (QR SCAN)
// =========================
app.get("/verify/:ticketID", (req, res) => {

    const ticket = issuedTickets[req.params.ticketID];

    if (!ticket) return res.json({ valid: false, message: "Invalid" });

    if (ticket.used) return res.json({ valid: false, message: "Used" });

    ticket.used = true;

    res.json({
        valid: true,
        name: ticket.name,
        category: ticket.category
    });
});

// =========================
app.listen(PORT, () => {
    console.log("Server running on port " + PORT);
});
