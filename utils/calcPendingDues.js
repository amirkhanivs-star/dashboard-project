// utils/calcPendingDues.js

export const BILLING_MONTHS = [
  { key: "january", label: "January" },
  { key: "february", label: "February" },
  { key: "march", label: "March" },
  { key: "april", label: "April" },
  { key: "may", label: "May" },
  { key: "june", label: "June" },
  { key: "july", label: "July" },
  { key: "august", label: "August" },
  { key: "september", label: "September" },
  { key: "october", label: "October" },
  { key: "november", label: "November" },
  { key: "december", label: "December" },
];

export const BILLING_STATUS_LIST = [
  "Not admitted",
  "No payment",
  "Partial payment",
  "Full payment",
  "Extra payment",
];

const monthIndex = (() => {
  const m = new Map();
  BILLING_MONTHS.forEach((x, i) => m.set(x.key, i));
  return m;
})();

export function safeJsonParse(s) {
  try {
    const v = JSON.parse(s);
    return v && typeof v === "object" ? v : null;
  } catch {
    return null;
  }
}

// "500", "Rs 500", "500/-", "Partial payment | 500" => number
export function parseFirstNumber(val) {
  const s = String(val ?? "");
  const m = s.match(/(-?\d+(\.\d+)?)/);
  if (!m) return 0;
  const n = parseFloat(m[1]);
  return Number.isFinite(n) ? n : 0;
}

// "Full payment | 500" => { status:"Full payment", rest:"500", amount:500 }
export function splitBillingValue(val) {
  const v = String(val || "").trim();
  if (!v) return { status: "", rest: "", amount: 0 };

  for (const st of BILLING_STATUS_LIST) {
    if (v === st) return { status: st, rest: "", amount: 0 };
    if (v.startsWith(st + " | ")) {
      const rest = v.slice((st + " | ").length).trim();
      return { status: st, rest, amount: parseFirstNumber(rest) };
    }
    if (v.startsWith(st + " - ")) {
      const rest = v.slice((st + " - ").length).trim();
      return { status: st, rest, amount: parseFirstNumber(rest) };
    }
  }

  return { status: "", rest: v, amount: parseFirstNumber(v) };
}

export function getCurrentMonthKey() {
  const idx = new Date().getMonth(); // 0-11
  return BILLING_MONTHS[idx]?.key || "january";
}

export function getNextMonthKey() {
  const idx = new Date().getMonth(); // 0-11
  const next = (idx + 1) % 12;
  return BILLING_MONTHS[next]?.key || "january";
}

function normalizeBillingEntry(entry) {
  // NEW format: { status, amount, feeOverride }
  if (entry && typeof entry === "object" && !Array.isArray(entry)) {
    return {
      status: String(entry.status || "").trim(),
      amount: String(entry.amount || "").trim(),
      feeOverride: String(entry.feeOverride || "").trim(),
    };
  }

  // OLD format: string like "Full payment | 500"
  const raw = String(entry || "").trim();
  if (!raw) {
    return { status: "", amount: "", feeOverride: "" };
  }

  const { status, amount } = splitBillingValue(raw);
  return { status: status || "", amount: String(amount || ""), feeOverride: "" };
}

function normalizeFeeHistory(feeHistory, baseFee) {
  let h = feeHistory;

  // allow string in DB
  if (typeof h === "string") h = safeJsonParse(h);

  if (!Array.isArray(h)) h = [];

  const cleaned = h
    .map((x) => ({
      fee: parseFirstNumber(x?.fee),
      effectiveMonthKey: String(x?.effectiveMonthKey || "january").toLowerCase(),
      changedAt: x?.changedAt || "",
      changedBy: x?.changedBy || "",
    }))
    .filter((x) => x.fee > 0 && monthIndex.has(x.effectiveMonthKey));

  // if empty, seed with baseFee so old months remain stable
  if (cleaned.length === 0) {
    const bf = parseFirstNumber(baseFee);
    if (bf > 0) {
      cleaned.push({
        fee: bf,
        effectiveMonthKey: "january",
        changedAt: new Date().toISOString(),
        changedBy: "system",
      });
    }
  }

  cleaned.sort((a, b) => {
    const ai = monthIndex.get(a.effectiveMonthKey);
    const bi = monthIndex.get(b.effectiveMonthKey);
    if (ai !== bi) return ai - bi;
    return String(a.changedAt).localeCompare(String(b.changedAt));
  });

  return cleaned;
}

function feeForMonthKey(history, monthKey, fallbackFee) {
  const idx = monthIndex.get(monthKey);
  if (idx == null) return parseFirstNumber(fallbackFee) || 0;

  let chosen = null;

  for (const h of history) {
    const hi = monthIndex.get(h.effectiveMonthKey);
    if (hi == null) continue;

    if (hi <= idx) chosen = h;
  }

  return chosen ? parseFirstNumber(chosen.fee) : parseFirstNumber(fallbackFee) || 0;
}

/**
 * Returns:
 * { expected, pending, paid, currentFee, hasExtraFee, perMonth }
 */
export function calcPendingDues(baseFee, billingJson, feeHistory = []) {
  const history = normalizeFeeHistory(feeHistory, baseFee);
  const bf = parseFirstNumber(baseFee) || 0;

  let expected = 0;
  let paid = 0;

  const perMonth = {};

  for (const m of BILLING_MONTHS) {
    const entryRaw = billingJson?.[m.key];
    const entry = normalizeBillingEntry(entryRaw);

    const status = String(entry.status || "").trim();
    const amountNum = parseFirstNumber(entry.amount);
    const feeOverrideNum = parseFirstNumber(entry.feeOverride);

    const isBlankMonth = !status && amountNum <= 0 && feeOverrideNum <= 0;

   if (isBlankMonth) {
  const feeByHistory = feeForMonthKey(history, m.key, bf);
  perMonth[m.key] = { fee: feeByHistory, expected: 0, paid: 0, status: "", feeOverride: 0 };
  continue;
}

    if (status === "Not admitted") {
      perMonth[m.key] = { fee: 0, expected: 0, paid: 0, status };
      continue;
    }

    const feeByHistory = feeForMonthKey(history, m.key, bf);
    const monthFee = feeOverrideNum > 0 ? feeOverrideNum : feeByHistory;

    expected += monthFee;

    const isPaidMonth =
      status === "Partial payment" ||
      status === "Full payment" ||
      status === "Extra payment" ||
      (!status && amountNum > 0);

    if (isPaidMonth && amountNum > 0) {
      paid += amountNum;
    }

    perMonth[m.key] = {
      fee: monthFee,
      expected: monthFee,
      paid: isPaidMonth ? amountNum : 0,
      status,
      feeOverride: feeOverrideNum > 0 ? feeOverrideNum : 0,
    };
  }

  const hasExtraFee = paid > expected;
  const pending = Math.max(expected - paid, 0);

  const currentMonthKey = getCurrentMonthKey();
  const currentFee = feeForMonthKey(history, currentMonthKey, bf);

  return {
    expected,
    paid,
    pending,
    currentFee,
    hasExtraFee,
    perMonth,
  };
}
// ✅ Pending months extractor (for challan buttons)
export function getPendingMonths(baseFee, billingJson, feeHistory = []) {
  const r = calcPendingDues(baseFee, billingJson, feeHistory);
  const out = [];

  for (const m of BILLING_MONTHS) {
    const pm = r?.perMonth?.[m.key];
    if (!pm) continue;

    // skip not admitted
    if (String(pm.status || "").trim() === "Not admitted") continue;

    const due = Math.max((pm.expected || 0) - (pm.paid || 0), 0);
    if (due > 0) {
      out.push({
        key: m.key,
        label: m.label,
        due,
        fee: pm.expected || pm.fee || 0,
        paid: pm.paid || 0,
        status: pm.status || "",
      });
    }
  }

  return out; // [{key,label,due,fee,paid,status}]
}