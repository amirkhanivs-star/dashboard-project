// public/js/admission-challan.js

function getActiveBillingYear() {
  const selectedYear =
    document.getElementById("billingYearSelect")?.value;

  const queryYear =
    new URLSearchParams(window.location.search).get("year");

  const globalYear =
    window.__BILLING_YEAR__;

  for (const value of [
    selectedYear,
    queryYear,
    globalYear,
  ]) {
    const year = Number(value);

    if (
      Number.isInteger(year) &&
      year >= 2020 &&
      year <= 2100
    ) {
      return String(year);
    }
  }

  return String(
    new Date().getFullYear()
  );
}

function addQueryParams(url, params = {}) {
  const parsedUrl = new URL(
    String(url || ""),
    window.location.origin
  );

  Object.entries(params).forEach(
    ([key, value]) => {
      const cleanValue =
        String(value ?? "").trim();

      if (cleanValue) {
        parsedUrl.searchParams.set(
          key,
          cleanValue
        );
      }
    }
  );

  return (
    parsedUrl.pathname +
    parsedUrl.search +
    parsedUrl.hash
  );
}

/*
 * Server ke challan routes isi prefix par hain.
 * Ye sirf Super Admin ke liye restricted nahi hain;
 * backend permission/access check karta hai.
 */
function getDetailsBase() {
  return "/dashboard/super";
}

function admissionUrl(
  admissionId,
  suffix = ""
) {
  const url =
    `${getDetailsBase()}/admission/` +
    `${encodeURIComponent(admissionId)}` +
    `${suffix}`;

  return addQueryParams(url, {
    year: getActiveBillingYear(),
  });
}

function familyUrl(
  familyNumber,
  suffix = "",
  admissionId = ""
) {
  const cleanFamilyNumber =
    String(familyNumber || "").trim();

  const cleanAdmissionId =
    String(admissionId || "").trim();

  const url =
    `${getDetailsBase()}/family/` +
    `${encodeURIComponent(cleanFamilyNumber)}` +
    `${suffix}`;

  const params = {
    year: getActiveBillingYear(),
  };

  // Auto-family case mein backend ko admissionId chahiye.
  if (
    cleanFamilyNumber.toLowerCase() === "auto" &&
    cleanAdmissionId
  ) {
    params.admissionId =
      cleanAdmissionId;
  }

  return addQueryParams(
    url,
    params
  );
}

function pendingFamilyApiUrl(
  familyNumber,
  admissionId = ""
) {
  const cleanFamilyNumber =
    String(familyNumber || "").trim();

  const cleanAdmissionId =
    String(admissionId || "").trim();

  const url =
    `/api/pending/family/` +
    `${encodeURIComponent(cleanFamilyNumber)}`;

  const params = {
    year: getActiveBillingYear(),
  };

  if (
    cleanFamilyNumber.toLowerCase() === "auto" &&
    cleanAdmissionId
  ) {
    params.admissionId =
      cleanAdmissionId;
  }

  return addQueryParams(
    url,
    params
  );
}

function pendingAdmissionApiUrl(
  admissionId
) {
  return addQueryParams(
    `/api/pending/admission/${encodeURIComponent(
      admissionId
    )}`,
    {
      year: getActiveBillingYear(),
    }
  );
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
  const familyCount = Number(pendingBtn.getAttribute("data-family-count") || "0");

  if (familyNumber && familyCount > 1) {
    window.location.href = familyUrl(
      familyNumber,
      "/challan/bulk?mode=pending",
      admissionId
    );
    return;
  }

  if (admissionId) {
    window.location.href = admissionUrl(admissionId, "/challan/bulk?mode=pending");
    return;
  }

  if (familyNumber) {
    window.location.href = familyUrl(
      familyNumber,
      "/challan/bulk?mode=pending",
      admissionId
    );
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
  const admissionId =
    familyBtn.getAttribute("data-admission-id") ||
    window.__ADMISSION_ID__ ||
    "";

  if (!familyNumber) return;

  window.location.href = familyUrl(familyNumber, "/challan", admissionId);
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

  if (
    typeof bootstrap === "undefined"
  ) {
    alert(
      "Bootstrap modal is not available."
    );

    return;
  }

  const modal =
    bootstrap.Modal.getOrCreateInstance(
      modalEl
    );

  subEl.textContent =
    "Loading...";

  bodyEl.innerHTML =
    `<div class="text-muted small">Loading...</div>`;

  modal.show();

  try {
    // Family mein 2 ya zyada students hon to family API.
    const url =
      familyNumber &&
      familyCount > 1
        ? pendingFamilyApiUrl(
            familyNumber,
            admissionId
          )
        : pendingAdmissionApiUrl(
            admissionId
          );

    const res = await fetch(
      url,
      {
        method: "GET",
        credentials: "same-origin",
        headers: {
          Accept: "application/json",
        },
      }
    );

    const json = await res
      .json()
      .catch(() => ({}));

    if (
      !res.ok ||
      !json.success
    ) {
      subEl.textContent =
        "Error";

      bodyEl.innerHTML = `
        <div class="text-danger small">
          ${escapeHtml(
            json.message ||
            "Failed to load pending months."
          )}
        </div>
      `;

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
  ? familyUrl(familyNo, "/challan/bulk?mode=pending", admissionId)
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
  ? familyUrl(familyNo, "/paid/bulk?mode=paid", admissionId)
  : admissionUrl(admissionId, "/paid/bulk?mode=paid");

    window.location.href = url;
  } catch (e) {
    alert("Bulk paid challans failed");
  }
});


function renderPendingTable(students) {
  const rows = [];

  (students || []).forEach((s) => {
    const pending =
      Array.isArray(s.pending)
        ? s.pending.filter((p) => {
            return (
              String(p?.status || "")
                .trim()
                .toLowerCase() !==
              "not admitted"
            );
          })
        : [];

    if (!pending.length) {
      return;
    }

    rows.push(`
      <div class="mb-3">
        <div class="fw-bold mb-2">
          ${escapeHtml(
            s.studentName || "-"
          )}
          • Admission #${escapeHtml(
            String(
              s.admissionId || "-"
            )
          )}
          • ${escapeHtml(
            s.grade || "-"
          )}
          • ${escapeHtml(
            s.currency || "SAR"
          )}
        </div>

        <div class="table-responsive">
          <table class="table table-sm align-middle">
            <thead>
              <tr>
                <th>Month</th>
                <th>Status</th>
                <th>Verification #</th>
                <th>Bank</th>
                <th>Fee</th>
                <th>Received</th>
                <th>Due</th>
                <th style="width:220px">
                  Actions
                </th>
              </tr>
            </thead>

            <tbody>
              ${pending
                .map((p) => {
                  const feeChallanUrl =
                    admissionUrl(
                      s.admissionId,
                      `/challan/${encodeURIComponent(
                        p.monthKey
                      )}`
                    );

                  const paidChallanUrl =
                    admissionUrl(
                      s.admissionId,
                      `/paid/${encodeURIComponent(
                        p.monthKey
                      )}`
                    );

                  const monthlyFee =
                    Number(
                      p.fee || 0
                    ) || 0;

                  const registrationFee =
                    Number(
                      p.registrationFeeTotal ||
                      0
                    ) || 0;

                  const monthlyReceived =
                    Number(
                      p.received || 0
                    ) || 0;

                  const registrationReceived =
                    Number(
                      p.registrationFeeReceived ||
                      0
                    ) || 0;

                  const totalFee =
                    monthlyFee +
                    registrationFee;

                  const totalReceived =
                    monthlyReceived +
                    registrationReceived;

                  const canPaid =
                    totalReceived > 0;

                  return `
                    <tr>
                      <td class="text-capitalize">
                        ${escapeHtml(
                          p.monthLabel ||
                          p.monthKey
                        )}
                      </td>

                      <td>
                        ${escapeHtml(
                          p.status || "-"
                        )}
                      </td>

                      <td>
                        ${escapeHtml(
                          p.verification || "-"
                        )}
                      </td>

                      <td>
                        ${escapeHtml(
                          p.bank || "-"
                        )}
                      </td>

                      <td>
                        ${escapeHtml(
                          String(totalFee)
                        )}
                      </td>

                      <td>
                        ${escapeHtml(
                          String(
                            totalReceived
                          )
                        )}
                      </td>

                      <td>
                        <b>
                          ${escapeHtml(
                            String(
                              p.due ?? "-"
                            )
                          )}
                        </b>
                      </td>

                      <td>
                        <a
                          class="btn btn-outline-secondary btn-sm me-2"
                          target="_blank"
                          rel="noopener"
                          href="${escapeHtml(
                            feeChallanUrl
                          )}">
                          Fee Challan
                        </a>

                        ${
                          canPaid
                            ? `
                              <a
                                class="btn btn-outline-secondary btn-sm"
                                target="_blank"
                                rel="noopener"
                                href="${escapeHtml(
                                  paidChallanUrl
                                )}">
                                Paid Challan
                              </a>
                            `
                            : `
                              <button
                                class="btn btn-outline-secondary btn-sm"
                                disabled>
                                Paid Challan
                              </button>
                            `
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
    return `
      <div class="text-muted small">
        No pending months found.
      </div>
    `;
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