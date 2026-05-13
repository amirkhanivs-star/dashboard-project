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
  if (!monthKey) return "";
  const m = String(monthKey).trim().toLowerCase();
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
    const dt = new Date(d);
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
      fee: safeNum(e.feeOverride || 0),
      verification: String(e.verification || "").trim(),
      number: String(e.number || "").trim(),
      receivedOn:
        e.receivedOn || e.received_on || e.paidOn || e.paid_on || e.date || ""
    };
  });
}

function normalizeStatus(s) {
  return String(s || "").trim().toLowerCase();
}

function splitRowsIntoPages(allRows) {
  const firstPageLimit = 10;
  const nextPageLimit = 12;

  const out = [];
  let index = 0;

  if (!Array.isArray(allRows) || allRows.length === 0) return out;

  if (allRows.length <= firstPageLimit) {
    out.push(allRows.slice(0, firstPageLimit));
    return out;
  }

  out.push(allRows.slice(0, firstPageLimit));
  index = firstPageLimit;

  while (index < allRows.length) {
    out.push(allRows.slice(index, index + nextPageLimit));
    index += nextPageLimit;
  }

  return out;
}

function imgDataUri(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return "";
    const ext = path.extname(filePath).toLowerCase();
    const mime = ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : "image/png";
    const data = fs.readFileSync(filePath).toString("base64");
    return `data:${mime};base64,${data}`;
  } catch { return ""; }
}

function publicImg(fileName) {
  const tryPaths = [
    path.join(process.cwd(), "public", "img", fileName),
    path.join(__dirname, "..", "public", "img", fileName),
    path.join(__dirname, "..", "..", "public", "img", fileName),
  ];
  for (const p of tryPaths) {
    if (fs.existsSync(p)) return imgDataUri(p);
  }
  return "";
}

export default async function makeMonthlyChallanPdf({
  full,
  monthKey,
  year,
  bannerPath,
  baseUrl = "",
  pendingOnly = false,
  pendingMonths = null
}) {
  const BASE =
    baseUrl ||
    process.env.APP_BASE_URL ||
    process.env.BASE_URL ||
    `http://localhost:${process.env.PORT || 3000}`;

  const templatePath = path.join(__dirname, "..", "views", "pdf", "challan-invoice.ejs");

  const issuedOn = new Date();
  const dueOn = new Date();
  dueOn.setDate(dueOn.getDate() + 10);

  const YEAR = Number(year) || issuedOn.getFullYear();

  const currency =
    full?.currency_code ||
    full?.currencyCode ||
    full?.admission?.currencyCode ||
    "SAR";

  const familyNo =
    full?.accounts?.familyNumber ||
    full?.accounts_family_number ||
    full?.accounts?.family_number ||
    "-";

  const regNo =
    full?.accounts?.registrationNumber ||
    full?.accounts_registration_number ||
    full?.accounts?.registration_number ||
    "-";

  const parentName =
    full?.father ||
    full?.fatherName ||
    full?.father_name ||
    full?.guardian ||
    full?.guardianName ||
    "-";

  const studentName = full?.student || full?.studentName || "-";
  const grade = full?.grade || "-";

  const billingArr = Array.isArray(full?.billing)
    ? full.billing
    : billingJsonToArray(full?.billingJson || full?.billing_json || full?.billing || {});

  const monthFeesMap = full?.monthFees || full?.month_fees || null;

  function feeForMonth(mk, fallbackFee) {
    const b = billingArr.find(
      (x) => String(x?.month || "").toLowerCase() === String(mk || "").toLowerCase()
    );

    const byOverride = safeNum(b?.fee || 0);
    if (byOverride > 0) return byOverride;

    const byMap = monthFeesMap ? safeNum(monthFeesMap[mk] || 0) : 0;
    if (byMap > 0) return byMap;

    return safeNum(fallbackFee || 0);
  }

  const curKey = String(monthKey || "").toLowerCase();
  const curIdx = MONTH_ORDER.indexOf(curKey);

  const curBill = billingArr.find(
    (b) => String(b?.month || "").toLowerCase() === curKey
  );

  const registrationFeeForChallan =
  full?.registrationFeeForChallan && typeof full.registrationFeeForChallan === "object"
    ? full.registrationFeeForChallan
    : {};

const registrationFeeByMonth =
  full?.registrationFeeByMonth && typeof full.registrationFeeByMonth === "object"
    ? full.registrationFeeByMonth
    : {};

function getRegistrationFeeRowForMonth(mk) {
  const cleanMk = String(mk || "").trim().toLowerCase();

  const direct =
    registrationFeeForChallan.enabled === true &&
    String(registrationFeeForChallan.monthKey || "").trim().toLowerCase() === cleanMk
      ? registrationFeeForChallan
      : null;

  const fromMap =
    registrationFeeByMonth[cleanMk] && typeof registrationFeeByMonth[cleanMk] === "object"
      ? registrationFeeByMonth[cleanMk]
      : null;

  const picked = direct || fromMap || null;

  if (!picked || picked.enabled !== true || safeNum(picked.due || 0) <= 0) {
    return null;
  }

  return picked;
}

const registrationFeeForCurrentMonth = getRegistrationFeeRowForMonth(curKey);
const hasRegistrationFeeForThisMonth = !!registrationFeeForCurrentMonth;

  const curStatus = normalizeStatus(curBill?.status || "");
  const isCurrentNotAdmitted = curStatus === "not admitted";

  const currentMonthFee =
    safeNum(curBill?.fee) ||
    safeNum(full?.admission?.fees) ||
    safeNum(full?.admission_fees) ||
    safeNum(full?.monthly_fee_current) ||
    0;

  const rows = [];

  if (pendingOnly) {
   const list = Array.isArray(pendingMonths) && pendingMonths.length
      ? pendingMonths.map((x) => String(x).toLowerCase())
      : [];

    const registrationMonthsForBulk = Object.keys(registrationFeeByMonth || {})
  .map((x) => String(x || "").trim().toLowerCase())
  .filter(Boolean);

for (const regMonthKey of registrationMonthsForBulk) {
  const regInfo = getRegistrationFeeRowForMonth(regMonthKey);

  if (!regInfo) continue;
  if (list.length && !list.includes(regMonthKey)) continue;

  rows.push({
    regNo,
    description: `Registration Fee\n${studentName}`,
    grade,
    month: monthTitle(regMonthKey),
    amount: safeNum(regInfo.due || 0).toFixed(2)
  });
}
      
    for (const mk of list) {
      const b =
        billingArr.find((x) => String(x?.month || "").toLowerCase() === mk) || {};

      const st = normalizeStatus(b?.status);
      if (st === "not admitted") continue;

      const fee = feeForMonth(
        mk,
        full?.admission?.fees ||
          full?.admission_fees ||
          full?.monthly_fee_current ||
          0
      );

      const rec = safeNum(b?.amount || 0);
      const due = Math.max(0, fee - rec);

      if (due > 0) {
        rows.push({
          regNo,
          description: `Monthly Fee\n${studentName}`,
          grade,
          month: monthTitle(mk),
          amount: due.toFixed(2)
        });
      }
    }
  } else {
    if (!isCurrentNotAdmitted) {
  rows.push({
    regNo,
    description: `Monthly Fee\n${studentName}`,
    grade,
    month: monthTitle(monthKey),
    amount: currentMonthFee.toFixed(2)
  });

  if (hasRegistrationFeeForThisMonth) {
    rows.push({
      regNo,
      description: `Registration Fee\n${studentName}`,
      grade,
      month: monthTitle(monthKey),
      amount: safeNum(registrationFeeForCurrentMonth.due || 0).toFixed(2)
    });
  }
}

    if (curIdx === -1) {
      const registrationMonthsForBulk = Object.keys(registrationFeeByMonth || {})
        .map((x) => String(x || "").trim().toLowerCase())
        .filter(Boolean);

      for (const regMonthKey of registrationMonthsForBulk) {
        const regInfo = getRegistrationFeeRowForMonth(regMonthKey);

        if (!regInfo) continue;

        rows.push({
          regNo,
          description: `Registration Fee\n${studentName}`,
          grade,
          month: monthTitle(regMonthKey),
          amount: safeNum(regInfo.due || 0).toFixed(2)
        });
      }
    }

    for (const b of billingArr) {
      const mk = String(b?.month || "").toLowerCase();
      const bi = MONTH_ORDER.indexOf(mk);

      if (bi < 0 || (curIdx >= 0 && bi >= curIdx)) continue;

      const st = normalizeStatus(b?.status || "");
      if (st === "not admitted") continue;

      const fee = safeNum(b?.fee) || currentMonthFee;
      const rec = safeNum(b?.amount);
      const due = Math.max(0, fee - rec);

      if (due > 0) {
        rows.push({
          regNo,
          description: `Previous Dues (${monthTitle(mk)} ${YEAR})\n${studentName}`,
          grade,
          month: monthTitle(mk),
          amount: due.toFixed(2)
        });
      }
    }
  }

  if (!rows.length) {
    throw new Error("No challan rows to generate for this month");
  }

  const rowPages = splitRowsIntoPages(rows);
  const totalNum = rows.reduce((sum, r) => sum + safeNum(r.amount), 0);

  // Keep empty so bulk month strip does not appear in All Fee Challans
  const sixMonthsHistory = Array.isArray(full?.sixMonthsHistory)
  ? full.sixMonthsHistory
  : [];

const monthStrip = sixMonthsHistory.map((item) => {
  const statusRaw = String(item?.status || "").trim();
  const amount = safeNum(item?.amount || 0);

  let amountText = "";
  if (statusRaw) {
   if (
  statusRaw.toLowerCase() === "partial payment" ||
  statusRaw.toLowerCase() === "full payment"
) {
  amountText = amount > 0 ? `${currency} ${amount}` : statusRaw;
} else {
  amountText = statusRaw;
}
  } else {
    amountText = "";
  }

  return {
    labelTop: monthTitle(item?.monthKey || item?.monthLabel || ""),
    labelBottom: amountText,
  };
});

  const bannerSrcAbs =
    bannerPath && fs.existsSync(bannerPath)
      ? imgDataUri(bannerPath)
      : publicImg("ivs-banner.jpg") || publicImg("ivs-banner.png");

  const html = await ejs.renderFile(templatePath, {
    baseUrl: BASE,
    bannerSrcAbs,
    bannerSrc: bannerSrcAbs,
    receiptQrSrc: publicImg("receipt-qr.jpg"),
    receiptSignSrc: publicImg("receipt-sign.jpg"),
    currency,
    invoiceNo: full?.invoiceNo || full?.invoice_no || full?.id || "",
    parentName,
    familyNo,
    issuedOn: fmtDate(issuedOn),
    dueOn: fmtDate(dueOn),
    rows,
    rowPages,
    totalText: `${currency} ${totalNum.toFixed(2)}`,
    monthStrip,
    settings: {
      phone: "+92 305 5245551",
      email: "acivs2021@gmail.com",
      website: "iqravirtualschool.com"
    }
  });

  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  try {
    const page = await browser.newPage();

page.setDefaultNavigationTimeout(0);
page.setDefaultTimeout(0);

await page.setViewport({ width: 1600, height: 2200, deviceScaleFactor: 1 });

await page.setContent(html, {
  waitUntil: "domcontentloaded",
  timeout: 0
});

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