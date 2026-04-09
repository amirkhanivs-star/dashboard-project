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

export default async function makeBulkPaidReceiptPdf({
  full,
  paidMonths = [],
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

  const monthKeys = Array.isArray(paidMonths) && paidMonths.length
    ? paidMonths.map((m) => String(m?.monthKey || m?.month || "").toLowerCase().trim()).filter(Boolean)
    : billingArr
        .filter((b) => safeNum(b?.amount || 0) > 0)
        .map((b) => String(b?.month || "").toLowerCase().trim());

  const rows = monthKeys.map((mk) => {
    const curBill = billingArr.find(
      (b) => String(b?.month || "").toLowerCase() === mk
    ) || {};

    const receivedAmount = safeNum(curBill?.amount || 0);

    return {
      regNo,
      description: `Monthly Fee Paid\n${studentName}`,
      grade,
      month: monthTitle(mk),
      amount: receivedAmount.toFixed(2),
    };
  });

  const totalReceived = rows.reduce((sum, r) => sum + safeNum(r.amount), 0);

  const monthNames = monthKeys.map(monthTitle).filter(Boolean);
  const receiptMonth =
    monthNames.length === 1
      ? `${monthNames[0]} ${YEAR}`
      : `Bulk Paid Receipt (${YEAR})`;

  const latestReceivedOnRaw = billingArr
    .filter((b) => monthKeys.includes(String(b?.month || "").toLowerCase().trim()))
    .map((b) => b?.receivedOn || b?.received_on || b?.paidOn || b?.paid_on || b?.date || "")
    .filter(Boolean)
    .pop();

  const receivedOn = latestReceivedOnRaw ? fmtDate(latestReceivedOnRaw) : fmtDate(new Date());

  const rowPages = [rows];
  const totalText = `${currency} ${totalReceived.toFixed(2)}`;

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
    receiptMonth,
    statusText: "Paid",
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