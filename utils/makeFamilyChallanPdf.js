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

export default async function makeFamilyChallanPdf({
  familyNumber,
  admissionsFull,
  bannerPath,
  monthKey = (() => {
    const i = new Date().getMonth();
    const order = [
      "january", "february", "march", "april", "may", "june",
      "july", "august", "september", "october", "november", "december"
    ];
    return order[i] || "january";
  })(),
  baseUrl = "",
  pendingOnly = false,
  year
}) {
  const BASE =
    baseUrl ||
    process.env.APP_BASE_URL ||
    process.env.BASE_URL ||
    `http://localhost:${process.env.PORT || 3000}`;

  const templatePath = path.join(__dirname, "..", "views", "pdf", "family-invoice.ejs");

  const issuedOn = new Date();
  const dueOn = new Date();
  dueOn.setDate(dueOn.getDate() + 10);

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

  const list = Array.isArray(admissionsFull) ? admissionsFull : [];
  const parentName =
    list[0]?.father ||
    list[0]?.fatherName ||
    list[0]?.father_name ||
    "-";

  const YEAR = Number(year) || new Date().getFullYear();

  const rows = [];
  const familyMonthStripMap = new Map();

  for (const a of list) {
    const currency =
      a?.currency_code ||
      a?.admission?.currencyCode ||
      "SAR";

    const regNo =
      a?.accounts?.registrationNumber ||
      a?.accounts_registration_number ||
      "-";

    const student = a?.student || a?.studentName || "-";
    const grade = a?.grade || "-";
    const monthFeesMap = a?.monthFees || a?.month_fees || null;

    let billArr = Array.isArray(a?.billing) ? a.billing : null;
    if (!billArr) {
      const bj = a?.billingJson || a?.billing_json || a?.billing || {};
      const order = [
        "january", "february", "march", "april", "may", "june",
        "july", "august", "september", "october", "november", "december"
      ];
      billArr = order.map((m) => {
        const e = bj[m] || {};
        return {
          month: m,
          status: String(e.status || "").trim(),
          amount: safeNum(e.amount || 0),
          fee: safeNum(e.feeOverride || 0),
          verification: String(e.verification || "").trim(),
          number: String(e.number || "").trim(),
        };
      });
    }

    const feeFallback =
      safeNum(a?.admission?.fees) ||
      safeNum(a?.admission_fees) ||
      safeNum(a?.monthly_fee_current) ||
      0;

    function feeFor(mk) {
      const b =
        billArr.find(
          (x) =>
            String(x?.month || "").toLowerCase() === String(mk || "").toLowerCase()
        ) || {};

      const byOverride = safeNum(b?.fee || 0);
      if (byOverride > 0) return byOverride;

      const byMap = monthFeesMap ? safeNum(monthFeesMap[mk] || 0) : 0;
      if (byMap > 0) return byMap;

      return feeFallback;
    }

        const sixMonthsHistory = Array.isArray(a?.sixMonthsHistory)
      ? a.sixMonthsHistory
      : [];

    for (const item of sixMonthsHistory) {
      const mk = String(item?.monthKey || "").toLowerCase().trim();
      if (!mk) continue;

      const old = familyMonthStripMap.get(mk) || {
        monthKey: mk,
        monthLabel: monthTitle(item?.monthKey || item?.monthLabel || ""),
        totalAmount: 0,
        statuses: [],
      };

      const itemStatus = String(item?.status || "").trim();
      const itemAmount = safeNum(item?.amount || 0);

      old.totalAmount += itemAmount;

      if (itemStatus && !old.statuses.includes(itemStatus)) {
  old.statuses.push(itemStatus);
}

      familyMonthStripMap.set(mk, old);
    }

    if (pendingOnly) {
      for (const b of billArr) {
        const mk = String(b?.month || "").toLowerCase();
        if (!mk) continue;

        if (String(b?.status || "").trim() === "Not admitted") continue;

        const fee = feeFor(mk);
        const rec = safeNum(b?.amount || 0);
        const due = Math.max(0, fee - rec);

        if (due > 0) {
          rows.push({
            regNo,
            description: `Pending Fee\n${student}`,
            grade,
            month: `${monthTitle(mk)} ${YEAR}`,
            amount: `${currency} ${due.toFixed(2)}`,
            _n: due,
            _currency: currency,
          });
        }
      }
    } else {
      const curBill =
        billArr.find(
          (b) =>
            String(b?.month || "").toLowerCase() === String(monthKey || "").toLowerCase()
        ) || {};

      const monthlyFee =
        safeNum(curBill?.fee) ||
        safeNum(curBill?.amount) ||
        feeFallback ||
        0;

      rows.push({
        regNo,
        description: `Monthly Fee\n${student}`,
        grade,
        month: `${monthTitle(monthKey)} ${YEAR}`,
        amount: `${currency} ${monthlyFee.toFixed(2)}`,
        _n: monthlyFee,
        _currency: currency,
      });

      const dues = safeNum(
        a?.admission?.pendingDues || a?.admission_pending_dues || 0
      );

      if (dues > 0) {
        rows.push({
          regNo,
          description: `Previous Dues\n${student}`,
          grade,
          month: `${monthTitle(monthKey)} ${YEAR}`,
          amount: `${currency} ${dues.toFixed(2)}`,
          _n: dues,
          _currency: currency,
        });
      }
    }
  }

    const monthStrip = MONTH_ORDER
    .filter((mk) => familyMonthStripMap.has(mk))
    .map((mk) => {
      const item = familyMonthStripMap.get(mk);

      let labelBottom = "";
      if ((item?.totalAmount || 0) > 0) {
        labelBottom = `${rows[0]?._currency || "SAR"} ${Number(item.totalAmount || 0).toFixed(2)}`;
      } else if (Array.isArray(item?.statuses) && item.statuses.length > 0) {
        labelBottom = item.statuses.join(", ");
      } else {
        labelBottom = "-";
      }

      return {
        labelTop: item?.monthLabel || monthTitle(mk),
        labelBottom,
      };
    });

      const rowPages = splitRowsIntoPages(rows);

  const currencyForTotal = rows[0]?._currency || "SAR";
  const total = rows.reduce((s, r) => s + (r?._n || 0), 0);

  const html = await ejs.renderFile(templatePath, {
    baseUrl: BASE,
    bannerSrc,
    bannerSrcAbs: `${BASE}${bannerSrc}`,
    familyNo: familyNumber || "-",
    parentName,
    issuedOn: fmtDate(issuedOn),
        dueOn: fmtDate(dueOn),
    rows,
    rowPages,
    monthStrip,
    totalText: `${currencyForTotal} ${total.toFixed(2)}`,
    payment: {
      formLink: "https://forms.gle/W4y3Q1VjUy8cRDvp7",
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
    await page.setViewport({
      width: 1600,
      height: 2200,
      deviceScaleFactor: 1,
    });
    await page.setContent(html, { waitUntil: "networkidle0" });
    await page.emulateMediaType("print");

    const pdfUint8 = await page.pdf({
      format: "A4",
      printBackground: true,
      preferCSSPageSize: true,
      margin: {
        top: "0mm",
        right: "0mm",
        bottom: "0mm",
        left: "0mm",
      },
    });

    return Buffer.from(pdfUint8);
  } finally {
    await browser.close();
  }
}