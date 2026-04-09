// public/js/admission-challan.js

function getDetailsBase() {
  return "/dashboard/super";
}

function admissionUrl(admissionId, suffix = "") {
  return `${getDetailsBase()}/admission/${encodeURIComponent(admissionId)}${suffix}`;
}

function familyUrl(familyNumber, suffix = "") {
  return `${getDetailsBase()}/family/${encodeURIComponent(familyNumber)}${suffix}`;
}

document.addEventListener("click", (e) => {
 const monthBtn = e.target.closest(".js-print-month-challan");
const paidBtn = e.target.closest(".js-print-month-paid");
const familyBtn = e.target.closest(".js-print-family-challan");

// ✅ NEW: pending challan button (works for individual + family)
const pendingBtn = e.target.closest(".js-print-pending-challan");
// ✅ Pending-only challan (Individual OR Family)
if (pendingBtn) {
  const admissionId = pendingBtn.getAttribute("data-admission-id");
  const familyNumber = pendingBtn.getAttribute("data-family-number");

  if (admissionId) {
    window.location.href = admissionUrl(admissionId, "/challan/bulk?mode=pending");
    return;
  }

  if (familyNumber) {
    window.location.href = familyUrl(familyNumber, "/challan/bulk?mode=pending");
    return;
  }

  return;
}
  // ✅ Month-wise Fee Challan
  if (monthBtn) {
    const admissionId = monthBtn.getAttribute("data-admission-id");
    const monthKey = monthBtn.getAttribute("data-month-key");

    if (!admissionId || !monthKey) return;

    // downloads PDF
    window.location.href = admissionUrl(admissionId, `/challan/${encodeURIComponent(monthKey)}`);
    return;
  }

  // ✅ Month-wise Paid Challan (Receipt)
  if (paidBtn) {
    const admissionId = paidBtn.getAttribute("data-admission-id");
    const monthKey = paidBtn.getAttribute("data-month-key");

    if (!admissionId || !monthKey) return;

    // downloads PDF (paid receipt)
    window.location.href = admissionUrl(admissionId, `/paid/${encodeURIComponent(monthKey)}`);
    return;
  }

  // ✅ Family combined challan
  if (familyBtn) {
    const familyNumber = familyBtn.getAttribute("data-family-number");
    if (!familyNumber) return;

  window.location.href = familyUrl(familyNumber, "/challan");
  }
});
// ✅ Pending challan modal opener
document.addEventListener("click", async (e) => {
  const btn = e.target.closest(".js-open-pending-challan");
  if (!btn) return;

  const admissionId = btn.getAttribute("data-admission-id");
  const familyNumber = btn.getAttribute("data-family-number");
  const familyCount = Number(btn.getAttribute("data-family-count") || "0");

  const modalEl = document.getElementById("pendingChallanModal");
  const subEl = document.getElementById("pcmSub");
  const bodyEl = document.getElementById("pcmBody");

  if (!modalEl || !subEl || !bodyEl) {
    alert("Modal not found. Please check admission-details.ejs modal code.");
    return;
  }

  const modal = new bootstrap.Modal(modalEl);
  subEl.textContent = "Loading...";
  bodyEl.innerHTML = `<div class="text-muted small">Loading...</div>`;
  modal.show();

  try {
    // ✅ if family has 2+ students -> family API, else single admission
    const url =
      familyNumber && familyCount > 1
        ? `/api/pending/family/${encodeURIComponent(familyNumber)}`
        : `/api/pending/admission/${encodeURIComponent(admissionId)}`;

    const res = await fetch(url);
    const json = await res.json();

    if (!json.success) {
      subEl.textContent = "Error";
      bodyEl.innerHTML = `<div class="text-danger small">${json.message || "Failed"}</div>`;
      return;
    }

   if (json.mode === "single") {
      subEl.textContent = `Admission #${json.admissionId} • ${json.studentName} • ${json.grade} • ${json.currency}`;
      bodyEl.innerHTML = renderPendingTable([
        {
          admissionId: json.admissionId,
          studentName: json.studentName,
          grade: json.grade,
          dept: json.dept,
          currency: json.currency,
          pending: json.pending || [],
        },
      ]);
      return;
    }

    // family
    subEl.textContent = `Family #${json.familyNumber} • Students: ${(json.students || []).length}`;
    bodyEl.innerHTML = renderPendingTable(json.students || []);
  } catch (err) {
    console.error(err);
    subEl.textContent = "Error";
    bodyEl.innerHTML = `<div class="text-danger small">Failed to load pending months.</div>`;
  }
});

document.getElementById("btnAllFeeChallans")?.addEventListener("click", async () => {
  try {
    const familyNo = window.__FAMILY_NUMBER__ || "";
    const admissionId = window.__ADMISSION_ID__;

    const url = familyNo
      ? familyUrl(familyNo, "/challan/bulk?mode=pending")
      : admissionUrl(admissionId, "/challan/bulk?mode=pending");

    window.open(url, "_blank");
  } catch (e) {
    alert("Bulk fee challans failed");
  }
});


document.getElementById("btnAllPaidChallans")?.addEventListener("click", async () => {
  try {
    const familyNo = window.__FAMILY_NUMBER__ || "";
    const admissionId = window.__ADMISSION_ID__;

    const url = familyNo
      ? familyUrl(familyNo, "/paid/bulk?mode=paid")
      : admissionUrl(admissionId, "/paid/bulk?mode=paid");

    window.location.href = url;
  } catch (e) {
    alert("Bulk paid challans failed");
  }
});


function renderPendingTable(students) {
  const rows = [];

  (students || []).forEach((s) => {
    const pending = Array.isArray(s.pending) ? s.pending : [];
    if (!pending.length) return;

    rows.push(`
      <div class="mb-3">
        <div class="fw-bold mb-2">
          ${escapeHtml(s.studentName || "-")} • Admission #${s.admissionId} • ${escapeHtml(s.grade || "-")} • ${escapeHtml(s.currency || "SAR")}
        </div>

        <div class="table-responsive">
          <table class="table table-sm align-middle">
            <thead>
              <tr>
                <th>Month</th>
                <th>Status</th>
                <th>Verification #</th>
                <th>Month Number</th>
                <th>Fee</th>
                <th>Received</th>
                <th>Due</th>
                <th style="width:220px">Actions</th>
              </tr>
            </thead>
            <tbody>
              ${pending
                .map((p) => {
                 const feeChallanUrl = admissionUrl(
  s.admissionId,
  `/challan/${encodeURIComponent(p.monthKey)}`
);

const paidChallanUrl = admissionUrl(
  s.admissionId,
  `/paid/${encodeURIComponent(p.monthKey)}`
);

                  const canPaid = Number(p.received || 0) > 0;

                  return `
                    <tr>
                      <td class="text-capitalize">${escapeHtml(p.monthLabel || p.monthKey)}</td>
                      <td>${escapeHtml(p.status || "-")}</td>
                      <td>${escapeHtml(p.verification || "-")}</td>
                      <td>${escapeHtml(p.number || "-")}</td>
                      <td>${escapeHtml(String(p.fee ?? "-"))}</td>
                      <td>${escapeHtml(String(p.received ?? "-"))}</td>
                      <td><b>${escapeHtml(String(p.due ?? "-"))}</b></td>
                      <td>
                        <a class="btn btn-outline-secondary btn-sm me-2" target="_blank" href="${feeChallanUrl}">
                          Fee Challan
                        </a>
                        ${
                          canPaid
                            ? `<a class="btn btn-outline-secondary btn-sm" target="_blank" href="${paidChallanUrl}">Paid Challan</a>`
                            : `<button class="btn btn-outline-secondary btn-sm" disabled>Paid Challan</button>`
                        }
                      </td>
                    </tr>
                  `;
                })
                .join("")}
            </tbody>
          </table>
        </div>
      </div>
    `);
  });

  if (!rows.length) {
    return `<div class="text-muted small">No pending months found.</div>`;
  }

  return rows.join("");
}

function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}