/**
 * PawSome — PayFast ITN Handler
 * Netlify serverless function
 *
 * PayFast calls this the moment a payment completes.
 * We send an email to the store owner via Resend (free).
 */

const https  = require("https");
const crypto = require("crypto");
const qs     = require("querystring");

// ── env vars — set in Netlify → Site configuration → Environment variables ──
const OWNER_EMAIL        = process.env.OWNER_EMAIL           || "britschristiaan6@gmail.com";
const RESEND_API_KEY     = process.env.RESEND_API_KEY        || "";
const PAYFAST_PASSPHRASE = process.env.PAYFAST_PASSPHRASE    || "";
const IS_SANDBOX         = process.env.PAYFAST_SANDBOX       === "true";

// ── main handler ──────────────────────────────────────────────────────
exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 200, body: "OK" };
  }

  try {
    const data = qs.parse(event.body || "");
    console.log("PayFast ITN received:", JSON.stringify(data));

    /* 1 — Only act on completed payments */
    if (data.payment_status !== "COMPLETE") {
      console.log("Ignoring status:", data.payment_status);
      return { statusCode: 200, body: "OK" };
    }

    /* 2 — Verify signature */
    if (PAYFAST_PASSPHRASE) {
      if (!verifySignature(data, PAYFAST_PASSPHRASE)) {
        console.error("Signature mismatch — ignoring ITN");
        return { statusCode: 200, body: "OK" };
      }
    }

    /* 3 — Build email content */
    const orderNum  = data.m_payment_id || ("PS" + Date.now().toString().slice(-6));
    const product   = (data.custom_str1 || data.item_name || "Order").replace(/\\n/g, "<br>");
    const customer  = (data.custom_str2 || `${data.name_first} ${data.name_last}`).replace(/\\n/g, "<br>");
    const addr1     = (data.custom_str3 || "").replace(/\\n/g, "<br>");
    const addr2     = (data.custom_str4 || "").replace(/\\n/g, "<br>");
    const extraInfo = (data.custom_str5 || "").replace(/\\n/g, "<br>");
    const amount    = data.amount_gross || "0.00";

    const subject = `🐾 New Order ${orderNum} — R${amount} received`;

    const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8"/>
  <style>
    body { font-family: Arial, sans-serif; background: #f4f4f4; margin: 0; padding: 20px; }
    .card { background: #fff; border-radius: 12px; max-width: 520px; margin: 0 auto; overflow: hidden; box-shadow: 0 2px 12px rgba(0,0,0,0.08); }
    .header { background: #0e5028; color: #fff; padding: 24px 28px; }
    .header h1 { margin: 0; font-size: 20px; }
    .header p { margin: 4px 0 0; opacity: .8; font-size: 13px; }
    .confirmed { background: #e8f9ee; border-left: 4px solid #22c55e; padding: 14px 20px; margin: 20px; border-radius: 6px; }
    .confirmed strong { color: #15803d; font-size: 18px; }
    .section { padding: 0 28px 20px; }
    .section-title { font-size: 11px; font-weight: 800; text-transform: uppercase; letter-spacing: .07em; color: #888; margin-bottom: 8px; margin-top: 20px; }
    .box { background: #f8f8f8; border-radius: 8px; padding: 14px 16px; font-size: 14px; line-height: 1.7; color: #333; }
    .action { background: #0e5028; color: #fff; text-decoration: none; display: block; text-align: center; padding: 14px; font-weight: 700; font-size: 15px; margin: 24px 28px 28px; border-radius: 10px; }
    .footer { text-align: center; font-size: 11px; color: #bbb; padding: 0 20px 20px; }
  </style>
</head>
<body>
  <div class="card">
    <div class="header">
      <h1>🐾 PawSome — New Order</h1>
      <p>Order ${orderNum} · ${new Date().toLocaleString("en-ZA", {timeZone:"Africa/Johannesburg"})}</p>
    </div>

    <div class="confirmed">
      <strong>✅ R${amount} payment confirmed</strong><br>
      <span style="font-size:13px;color:#166534">Money is on its way to your PayFast account</span>
    </div>

    <div class="section">
      <div class="section-title">📦 What to order from Takealot</div>
      <div class="box">${product}</div>

      <div class="section-title">👤 Customer</div>
      <div class="box">${customer}</div>

      ${addr1 ? `
      <div class="section-title">📍 Ship to this address</div>
      <div class="box">${addr1}<br>${addr2}</div>
      ` : ""}

      ${extraInfo ? `
      <div class="section-title">📝 Extra info</div>
      <div class="box">${extraInfo}</div>
      ` : ""}
    </div>

    <a class="action" href="https://www.takealot.com" target="_blank">
      Go to Takealot to place the order →
    </a>

    <div class="footer">PawSome SA · This email was sent automatically when payment was confirmed.</div>
  </div>
</body>
</html>`;

    /* 4 — Send email via Resend */
    if (!RESEND_API_KEY) {
      console.log("RESEND_API_KEY not set. Would have sent email:\n", subject);
    } else {
      const result = await sendEmail(RESEND_API_KEY, OWNER_EMAIL, subject, html);
      console.log("Resend response:", result);
    }

    return { statusCode: 200, body: "OK" };

  } catch (err) {
    console.error("ITN error:", err);
    return { statusCode: 200, body: "OK" }; // always 200 — PayFast requires it
  }
};

// ── Send email via Resend ─────────────────────────────────────────────
function sendEmail(apiKey, to, subject, html) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      from:    "PawSome Orders <orders@resend.dev>",
      to:      [to],
      subject: subject,
      html:    html
    });

    const options = {
      hostname: "api.resend.com",
      path:     "/emails",
      method:   "POST",
      headers:  {
        "Authorization": "Bearer " + apiKey,
        "Content-Type":  "application/json",
        "Content-Length": Buffer.byteLength(body)
      }
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => resolve(data));
    });

    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// ── Verify PayFast signature ──────────────────────────────────────────
function verifySignature(data, passphrase) {
  const params = Object.keys(data)
    .filter(k => k !== "signature" && data[k] !== "")
    .sort()
    .map(k => k + "=" + encodeURIComponent(data[k]).replace(/%20/g, "+"))
    .join("&");

  const withPass = passphrase
    ? params + "&passphrase=" + encodeURIComponent(passphrase).replace(/%20/g, "+")
    : params;

  const expected = crypto.createHash("md5").update(withPass).digest("hex");
  return expected === data.signature;
}

