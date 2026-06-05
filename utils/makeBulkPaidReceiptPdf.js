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
function imgDataUri(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return "";

    const ext = path.extname(filePath).toLowerCase();
    const mime =
      ext === ".jpg" || ext === ".jpeg"
        ? "image/jpeg"
        : ext === ".png"
        ? "image/png"
        : "image/png";

    const data = fs.readFileSync(filePath).toString("base64");
    return `data:${mime};base64,${data}`;
  } catch {
    return "";
  }
}

function publicImg(fileName) {
  const projectRoot = path.resolve(__dirname, "..", "..", "..").split("node_modules")[0].replace(/[\\/]src.*/, "");
  const tryPaths = [
    path.join(process.cwd(), "public", "img", fileName),
    path.join(__dirname, "..", "public", "img", fileName),
    path.join(__dirname, "..", "..", "public", "img", fileName),
    path.join(__dirname, "..", "..", "..", "public", "img", fileName),
  ];
  for (const p of tryPaths) {
    if (fs.existsSync(p)) return imgDataUri(p);
  }
  return "";
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
  "",

registrationFeeTotal: safeNum(e.registrationFeeTotal || 0),
registrationFeeReceived: safeNum(e.registrationFeeReceived || 0),
registrationFeeStatus: String(e.registrationFeeStatus || "").trim(),
registrationFeeVerification: String(e.registrationFeeVerification || "").trim(),
registrationFeeBank: String(e.registrationFeeBank || "").trim(),
registrationFeePaymentDate: String(e.registrationFeePaymentDate || "").trim()
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
    const familyNumber =
  full?.familyNumber ||
  full?.accounts?.familyNumber ||
  full?.accounts_family_number ||
  full?.accounts?.family_number ||
  "";

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

  const paidItems = Array.isArray(paidMonths) && paidMonths.length
  ? paidMonths
      .map((m) => {
        const monthKey = String(m?.monthKey || m?.month || "").toLowerCase().trim();
        const isRegistrationFee =
          m?.isRegistrationFee === true ||
          String(m?.feeType || "").toLowerCase().includes("registration");

        return {
          admissionId: Number(m?.admissionId || full?.id || 0),
          studentName: String(m?.studentName || studentName || "-").trim(),
          grade: String(m?.grade || grade || "-").trim(),
          registrationNumber: String(m?.registrationNumber || regNo || "-").trim(),
          familyNumber: String(m?.familyNumber || familyNumber || "").trim(),

          monthKey,
          monthLabel: m?.monthLabel || monthTitle(monthKey),
          feeType: isRegistrationFee ? "Registration Fee" : "Monthly Fee",
          isRegistrationFee,
          received: safeNum(m?.received ?? m?.used ?? m?.amount ?? 0),
        };
      })
      .filter((x) => x.monthKey && x.received > 0)
  : billingArr
      .filter((b) => safeNum(b?.amount || 0) > 0)
      .map((b) => ({
        admissionId: Number(full?.id || 0),
        studentName,
        grade,
        registrationNumber: regNo,
        familyNumber,

        monthKey: String(b?.month || "").toLowerCase().trim(),
        monthLabel: monthTitle(b?.month || ""),
        feeType: "Monthly Fee",
        isRegistrationFee: false,
        received: safeNum(b?.amount || 0),
      }));

const rows = paidItems.map((item) => {
  return {
    regNo: item.registrationNumber || regNo,
    familyNumber: item.familyNumber || familyNumber || "",
    description: `${item.feeType} Paid\n${item.studentName || studentName}`,
    grade: item.grade || grade,
    month: item.monthLabel || monthTitle(item.monthKey),
    amount: item.received.toFixed(2),
  };
});

  const totalReceived = rows.reduce((sum, r) => sum + safeNum(r.amount), 0);

  const uniqueMonthLabels = [...new Set(
  paidItems
    .map((x) => String(x.monthLabel || monthTitle(x.monthKey) || "").trim())
    .filter(Boolean)
)];

const receiptMonth =
  uniqueMonthLabels.length === 1
    ? `${uniqueMonthLabels[0]} ${YEAR}`
    : uniqueMonthLabels.length > 1
      ? `${uniqueMonthLabels.join(", ")} ${YEAR}`
      : `Paid Receipt (${YEAR})`;

const paidItemMonthKeys = paidItems
  .map((x) => String(x.monthKey || "").toLowerCase().trim())
  .filter(Boolean);

const latestReceivedOnRaw = billingArr
  .filter((b) => paidItemMonthKeys.includes(String(b?.month || "").toLowerCase().trim()))
  .map((b) => b?.receivedOn || b?.received_on || b?.paidOn || b?.paid_on || b?.date || "")
  .filter(Boolean)
  .pop();
  const receivedOn = latestReceivedOnRaw ? fmtDate(latestReceivedOnRaw) : fmtDate(new Date());

  const rowPages = [rows];
  const totalText = `${currency} ${totalReceived.toFixed(2)}`;

  const bannerSrcAbs =
  bannerPath && fs.existsSync(bannerPath)
    ? imgDataUri(bannerPath)
    : publicImg("ivs-banner.jpg") || publicImg("ivs-banner.png");

const paidStampSrcAbs = publicImg("fee-paid-stamp.png");
const receiptQrSrcAbs = publicImg("receipt-qr.jpg");
const receiptSignSrcAbs = publicImg("receipt-sign.jpg");

  const html = await ejs.renderFile(templatePath, {
    baseUrl: BASE,
    bannerSrcAbs,
bannerSrc: bannerSrcAbs,
    currency,
    receiptNo: full?.receiptNo || full?.receipt_no || full?.id || "",
receiptMonth,
statusText: "Paid",
familyNumber: familyNumber || "N/A",
paidBy,
receivedOn,
rows,
    rowPages,
    totalText,

    paidStampSrc: paidStampSrcAbs,
receiptQrSrc: receiptQrSrcAbs,
receiptSignSrc: receiptSignSrcAbs,
    formLink: "https://forms.gle/W4y3Q1VjyU8cRDvp7",

    settings: {
      phone: "+92 305 5245551",
      email: "acivs2021@gmail.com",
      website: "iqravirtualschool.com",
    },
  });

  const browser = await puppeteer.launch({
    headless: "new",
    timeout: 60000,
    protocolTimeout: 60000,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--disable-software-rasterizer",
      "--disable-background-networking",
      "--disable-default-apps",
      "--disable-extensions",
      "--disable-sync",
      "--disable-translate",
      "--hide-scrollbars",
      "--mute-audio",
      "--no-first-run",
      "--no-zygote",
      "--single-process"
    ],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1600, height: 2200, deviceScaleFactor: 1 });
    page.setDefaultNavigationTimeout(0);
page.setDefaultTimeout(0);
    await page.setContent(html, {
  waitUntil: "domcontentloaded",
  timeout: 0,
});
    await page.emulateMediaType("print");
    await new Promise((resolve) => setTimeout(resolve, 500));

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