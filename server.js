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
// MPESA CREDENTIALS (UNCHANGED)
// =========================
const consumerKey = "WMIqR7H4yTbcpFwUtudit8OoFDzVd0XrAYx5BFShiX0UdZKV";
const consumerSecret = "NzvROHYIG5PIDlw3LocL8Dh8uFYJaUwIAenBaOXLtDSQ0cA9aHhEmuqLBoww9JsU";
const shortcode = "7677179";
const passkey = "4cb92696ef3d16e754f85c0be0e807dba47c65e56629a8f1dd726c8fb8290c66";

const callbackURL = "https://rugbyduelregistration.onrender.com/callback";

// =========================
let pendingPayments = {};
let issuedTickets = {};

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

        res.json({ message: "Check your phone and enter your M-Pesa PIN." });

    } catch (error) {
        console.error("STK ERROR:", error.response?.data || error.message);
        res.status(500).json({ message: "Payment failed." });
    }
});

// =========================
// CALLBACK (FIXED)
// =========================
app.post("/callback", async (req, res) => {

    try {

        const callback = req.body?.Body?.stkCallback;
        if (!callback) return res.json({ status: "invalid" });

        const checkoutID = callback.CheckoutRequestID;
        const resultCode = callback.ResultCode;

        // ❌ STOP if cancelled or failed
        if (resultCode !== 0) {
            console.log("Payment cancelled or failed");
            delete pendingPayments[checkoutID];
            return res.json({ status: "failed" });
        }

        const user = pendingPayments[checkoutID];
        if (!user) return res.json({ status: "user_not_found" });

        let receipt = "N/A";
        const metadata = callback.CallbackMetadata?.Item || [];

        metadata.forEach(item => {
            if (item.Name === "MpesaReceiptNumber") {
                receipt = item.Value;
            }
        });

        const ticketID = "RUGBY-" + Date.now();
        const qr = await QRCode.toDataURL(ticketID);

        // =========================
        // CREATE PDF
        // =========================
        const dir = path.join(__dirname, "tickets");
        if (!fs.existsSync(dir)) fs.mkdirSync(dir);

        const pdfPath = path.join(dir, `${ticketID}.pdf`);
        const doc = new PDFDocument({ size: "A4" });

        doc.pipe(fs.createWriteStream(pdfPath));

        // Background
        doc.rect(0, 0, doc.page.width, doc.page.height).fill("#f0f4ff");

        doc.fillColor("#1a237e").fontSize(26).text("RUGBY DUEL TICKET", { align: "center" });
        doc.moveDown();

        doc.fillColor("#000").fontSize(16);
        doc.text(`Name: ${user.fullname}`);
        doc.text(`Ticket ID: ${ticketID}`);
        doc.text(`Category: ${user.ticketType}`);
        doc.text(`Amount: Ksh ${user.amount}`);
        doc.text(`Receipt: ${receipt}`);
        doc.text(`Date: 18 April 2026`);
        doc.text(`Venue: Eldoret Sports Club`);

        doc.moveDown();
        doc.image(qr, { fit: [150, 150], align: "center" });

        doc.end();

        // =========================
        // SAVE
        // =========================
        issuedTickets[ticketID] = {
            name: user.fullname,
            email: user.email,
            used: false,
            category: user.ticketType,
            amount: user.amount,
            receipt,
            pdfPath,
            qr
        };

        // =========================
        // SEND EMAIL
        // =========================
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
            subject: "Your Rugby Duel Ticket",
            html: `
                <h2>Your Ticket is Ready</h2>
                <p>Name: ${user.fullname}</p>
                <p>Ticket ID: ${ticketID}</p>
                <p>Category: ${user.ticketType}</p>
                <p>Download attached ticket</p>
            `,
            attachments: [
                {
                    filename: `${ticketID}.pdf`,
                    path: pdfPath
                }
            ]
        });

        delete pendingPayments[checkoutID];

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
app.get("/download/:id", (req, res) => {
    const t = issuedTickets[req.params.id];
    if (!t) return res.send("Not found");
    res.download(t.pdfPath);
});

// =========================
app.listen(PORT, () => {
    console.log("Server running on port " + PORT);
});
