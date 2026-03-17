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
let pendingPayments = {}; // { checkoutID: { fullname, phone, email, ticketType } }
let issuedTickets = {};   // { ticketID: { name, email, used, category, amount, receipt, pdfPath } }

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
        pendingPayments[checkoutID] = { fullname, phone, email, ticketType, amount };
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
        if (!callback) return res.status(400).json({ status: "Invalid callback" });

        const checkoutID = callback.CheckoutRequestID;
        const resultCode = callback.ResultCode;
        const metadata = callback.CallbackMetadata?.Item || [];

        if (resultCode !== 0) {
            console.log("❌ Payment Failed:", callback.ResultDesc);
            delete pendingPayments[checkoutID];
            return res.json({ status: "failed" });
        }

        const user = pendingPayments[checkoutID];
        if (!user) return res.json({ status: "user_not_found" });

        let receipt = "N/A";
        metadata.forEach(item => { if(item.Name==="MpesaReceiptNumber") receipt=item.Value; });

        const ticketID = "RUGBY-" + Date.now();
        const qrData = await QRCode.toDataURL(ticketID);

        // Generate PDF ticket
        const pdfPath = path.join(__dirname, "tickets", `${ticketID}.pdf`);
        if (!fs.existsSync(path.join(__dirname, "tickets"))) fs.mkdirSync(path.join(__dirname, "tickets"));

        const doc = new PDFDocument({ size: 'A4', margin: 50 });
        doc.pipe(fs.createWriteStream(pdfPath));
        doc.fontSize(22).text("🏉 Rugby Duel Ticket", { align: "center" });
        doc.moveDown();
        doc.fontSize(16).text(`Name: ${user.fullname}`);
        doc.text(`Ticket ID: ${ticketID}`);
        doc.text(`Category: ${user.ticketType}`);
        doc.text(`Amount Paid: Ksh ${user.amount}`);
        doc.text(`M-Pesa Receipt: ${receipt}`);
        doc.text(`Date: 18th April 2026`);
        doc.text(`Venue: Eldoret Sports Club`);
        doc.moveDown();
        doc.image(qrData, { fit: [200, 200], align: "center" });
        doc.end();

        issuedTickets[ticketID] = {
            name: user.fullname,
            email: user.email,
            used: false,
            category: user.ticketType,
            amount: user.amount,
            receipt,
            pdfPath
        };

        // Send email with PDF attachment
        try {
            const transporter = nodemailer.createTransport({
                service: "gmail",
                auth: { user: "ivankemei3@gmail.com", pass: "yjzx rltb qjle wchc" }
            });

            await transporter.sendMail({
                from: "ivankemei3@gmail.com",
                to: user.email,
                subject: "🎟️ Your Rugby Duel Ticket",
                html: `<h2>🏉 Rugby Duel Ticket</h2><p>Hi ${user.fullname}, attached is your ticket.</p>`,
                attachments: [{ filename: `${ticketID}.pdf`, path: pdfPath }]
            });
            console.log("📧 Ticket sent to:", user.email);
        } catch (err) { console.error("❌ Email Error:", err.message); }

        delete pendingPayments[checkoutID];
        res.json({ status: "success" });

    } catch (err) {
        console.error("❌ Callback Error:", err.message);
        res.json({ status: "error" });
    }
});

// =========================
// TICKET STATUS (frontend polls)
// =========================
app.get("/ticket_status", (req, res) => {
    const email = req.query.email;
    const ticketEntry = Object.entries(issuedTickets).find(([id, t]) => t.email === email);
    if (ticketEntry) {
        const [id, t] = ticketEntry;
        return res.json({
            status: "paid",
            ticket: { id, name: t.name, category: t.category, amount: t.amount }
        });
    }
    res.json({ status: "pending" });
});

// =========================
// VIEW TICKET (web page)
// =========================
app.get("/ticket/:id", (req, res) => {
    const ticketID = req.params.id;
    const t = issuedTickets[ticketID];
    if (!t) return res.send("Ticket not found");

    res.send(`
        <h1>🏉 Rugby Duel Ticket</h1>
        <p>Ticket ID: ${ticketID}</p>
        <p>Name: ${t.name}</p>
        <p>Category: ${t.category}</p>
        <p>Amount Paid: Ksh ${t.amount}</p>
        <a href="/download/${ticketID}" download>📥 Download PDF</a>
        <br/><img src="${t.qr}" />
    `);
});

// =========================
// DOWNLOAD PDF TICKET
// =========================
app.get("/download/:id", (req, res) => {
    const t = issuedTickets[req.params.id];
    if (!t) return res.send("Ticket not found");
    res.download(t.pdfPath);
});

// =========================
// VERIFY TICKET (QR scan)
// =========================
app.get("/verify/:ticketID", (req, res) => {
    const ticket = issuedTickets[req.params.ticketID];
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
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));