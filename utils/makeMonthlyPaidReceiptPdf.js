import puppeteer from "puppeteer";
import path from "path";
import fs from "fs";
import ejs from "ejs";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MONTH_ORDER = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december"
];

function monthTitle(monthKey) {
  const m = String(monthKey || "").trim().toLowerCase();
  if (!m) return "";
  return m.charAt(0).toUpperCase() + m.slice(1);
}

function safeNum(v) {
  const n = Number(v);
  if (Number.isFinite(n)) return n;
  const s = String(v ?? "").replace(/[^\d.]/g, "");
  const n2 = Number(s);
  return Number.isFinite(n2) ? n2 : 0;
}

function fmtDate(d) {
  try {
    const dt = d ? new Date(d) : new Date();
    if (Number.isNaN(dt.getTime())) return "";
    const dd = String(dt.getDate()).padStart(2, "0");
    const mm = dt.toLocaleString("en-US", { month: "long" });
    const yy = dt.getFullYear();
    return `${dd}-${mm}-${yy}`;
  } catch {
    return "";
  }
}

function normalizeStatus(s) {
  return String(s || "").trim();
}

function statusTextForReceipt(statusRaw, received, fee) {
  const st = String(statusRaw || "").trim().toLowerCase();
  const r = safeNum(received);
  const f = safeNum(fee);

  if (st === "full payment") return "Full payment";
  if (st === "partial payment") return "Partial payment";
  if (st === "extra payment") return "Extra payment";
  if (st === "paid") return "Paid";

  if (r <= 0) return "No payment";
  if (f > 0) {
    if (r === f) return "Full payment";
    if (r < f) return "Partial payment";
    if (r > f) return "Extra payment";
  }
  return "Paid";
}

function billingJsonToArray(billingJson) {
  const bj = billingJson && typeof billingJson === "object" ? billingJson : {};
  return MONTH_ORDER.map((m) => {
    const e = bj[m] || {};
    return {
      month: m,
      status: String(e.status || "").trim(),
      amount: safeNum(e.amount || 0),
      feeOverride: safeNum(e.feeOverride || 0),
      verification: String(e.verification || "").trim(),
      number: String(e.number || "").trim(),
      receivedOn:
        e.receivedOn ||
        e.received_on ||
        e.paidOn ||
        e.paid_on ||
        e.date ||
        ""
    };
  });
}

export default async function makeMonthlyPaidReceiptPdf({
  full,
  monthKey,
  year,
  bannerPath,
  baseUrl = ""
}) {
  const BASE =
    baseUrl ||
    process.env.APP_BASE_URL ||
    process.env.BASE_URL ||
    `http://localhost:${process.env.PORT || 3000}`;

  const templatePath = path.join(__dirname, "..", "views", "pdf", "challan-receipt.ejs");

  const issuedOn = new Date();
  const YEAR = Number(year) || issuedOn.getFullYear();

  const currency =
    full?.currency_code ||
    full?.currencyCode ||
    full?.admission?.currencyCode ||
    "SAR";

  const studentName = full?.student || full?.studentName || "-";
  const grade = full?.grade || "-";

  const regNo =
    full?.accounts?.registrationNumber ||
    full?.accounts_registration_number ||
    full?.accounts?.registration_number ||
    "-";

  const paidBy =
    full?.father ||
    full?.fatherName ||
    full?.father_name ||
    full?.guardian ||
    full?.guardianName ||
    "-";

  const billingArr = Array.isArray(full?.billing)
    ? full.billing
    : billingJsonToArray(full?.billingJson || full?.billing_json || full?.billing || {});

  const mk = String(monthKey || "").toLowerCase().trim();
  const curBill = billingArr.find(
    (b) => String(b?.month || "").toLowerCase() === mk
  ) || {};

  const receivedAmount = safeNum(curBill?.amount || 0);

  const baseFee =
    safeNum(curBill?.feeOverride || 0) ||
    safeNum(curBill?.fee || 0) ||
    safeNum(full?.admission?.fees || 0) ||
    safeNum(full?.admission_fees || 0) ||
    safeNum(full?.monthly_fee_current || 0) ||
    0;

  const statusRaw = normalizeStatus(curBill?.status || "");
  const statusText = statusTextForReceipt(statusRaw, receivedAmount, baseFee);

  const receivedOnRaw =
    curBill?.receivedOn ||
    curBill?.received_on ||
    curBill?.paidOn ||
    curBill?.paid_on ||
    curBill?.date ||
    "";

  const receivedOn = receivedOnRaw ? fmtDate(receivedOnRaw) : fmtDate(new Date());

  const rows = [
    {
      regNo,
      description: `Monthly Fee Paid\n${studentName}`,
      grade,
      month: monthTitle(mk),
      amount: receivedAmount.toFixed(2),
    },
  ];

  const rowPages = [rows];
  const totalText = `${currency} ${receivedAmount.toFixed(2)}`;

  let bannerSrc = "/img/ivs-banner.jpg";
  try {
    if (bannerPath && fs.existsSync(bannerPath)) {
      const publicDir = path.join(__dirname, "..", "public");
      const rel = path.relative(publicDir, bannerPath);
      if (!rel.startsWith("..")) {
        bannerSrc = "/" + rel.replaceAll("\\", "/");
      }
    }
  } catch {}

  const html = await ejs.renderFile(templatePath, {
    baseUrl: BASE,
    bannerSrcAbs: `${BASE}${bannerSrc}`,
    currency,
    receiptNo: full?.receiptNo || full?.receipt_no || full?.id || "",
    receiptMonth: `${monthTitle(mk)} ${YEAR}`,
    statusText,
    paidBy,
    receivedOn,
    rows,
    rowPages,
    totalText,

    paidStampSrc: "/img/fee-paid-stamp.png",
    formLink: "https://forms.gle/W4y3Q1VjyU8cRDvp7",

    settings: {
      phone: "+92 305 5245551",
      email: "acivs2021@gmail.com",
      website: "iqravirtualschool.com",
    },
  });

  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1600, height: 2200, deviceScaleFactor: 1 });
    await page.setContent(html, { waitUntil: "networkidle0" });
    await page.emulateMediaType("print");

    const pdfUint8 = await page.pdf({
      format: "A4",
      printBackground: true,
      preferCSSPageSize: true,
      margin: { top: "0mm", right: "0mm", bottom: "0mm", left: "0mm" }
    });

    return Buffer.from(pdfUint8);
  } finally {
    await browser.close();
  }
}