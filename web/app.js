/* Chase frontend: aging grid, approval-gated chase tray, forecast, history. */
"use strict";

const state = { mode: "sample", rows: [], current: null };

function toast(msg, isError) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.classList.toggle("error", Boolean(isError));
  el.classList.add("show");
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove("show"), 3400);
}

function money(amount, currency) {
  const n = Number(amount);
  return `${currency} ${n.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

async function api(path, opts) {
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.detail || data.error || `HTTP ${res.status}`);
    err.payload = data;
    err.status = res.status;
    throw err;
  }
  return data;
}

/* ---------- grid ---------- */

const bucketOrder = { "current": 0, "1-7": 1, "8-14": 2, "15-30": 3, "31-60": 4, "60+": 5 };

const gridOptions = {
  theme: "legacy",
  rowSelection: { mode: "singleRow" },
  defaultColDef: { sortable: true, resizable: true, suppressHeaderMenuButton: true },
  columnDefs: [
    { field: "id", headerName: "Invoice", flex: 1.15, minWidth: 120 },
    { field: "client_name", headerName: "Client", flex: 1.3, minWidth: 130 },
    {
      headerName: "Amount",
      valueGetter: (p) => money(p.data.amount_due, p.data.currency_code),
      type: "rightAligned",
      minWidth: 110,
    },
    { field: "due_date", headerName: "Due", minWidth: 100 },
    {
      field: "days_overdue",
      headerName: "Days late",
      type: "rightAligned",
      maxWidth: 100,
      cellClassRules: {
        "cell-late": (p) => p.value > 0,
      },
    },
    {
      field: "bucket",
      headerName: "Bucket",
      maxWidth: 100,
      comparator: (a, b) => (bucketOrder[a] ?? 9) - (bucketOrder[b] ?? 9),
    },
    { field: "status", headerName: "Status", maxWidth: 120 },
    {
      headerName: "Next step",
      valueGetter: (p) => {
        const d = p.data.decision;
        if (!d) return "closed";
        if (!d.chase_due) return d.reason;
        return `${stageLabel(d.stage)} - draft ready`;
      },
      flex: 1.4,
      minWidth: 170,
    },
    {
      headerName: "",
      colId: "actions",
      sortable: false,
      maxWidth: 130,
      pinned: "right",
      cellRenderer: actionsCell,
    },
  ],
  rowData: [],
};

function stageLabel(stage) {
  return { polite_reminder: "Polite reminder", firm_followup: "Firm follow-up", final_notice: "Final notice" }[stage] || stage;
}

function actionsCell(params) {
  const d = params.data.decision;
  const wrap = document.createElement("div");
  const btn = document.createElement("button");
  btn.className = "ghost";
  btn.textContent = "Draft chase";
  btn.style.fontSize = "12px";
  btn.style.padding = "4px 10px";
  if (!d || !d.chase_due) {
    btn.disabled = true;
    btn.title = d && d.reason ? d.reason : "no chase needed";
  } else {
    btn.addEventListener("click", () => openDraft(params.data));
  }
  wrap.appendChild(btn);
  return wrap;
}

/* ---------- data loading ---------- */

async function loadAll() {
  const health = await api("/api/health");
  state.mode = health.mode;
  const banner = document.getElementById("mode-banner");
  banner.textContent = health.mode === "live"
    ? "PayPal sandbox connected"
    : "Sample data - not connected to PayPal";
  banner.className = health.mode === "live" ? "live" : "sample";

  const snap = await api("/api/state");

  const rows = snap.invoices.map((a) => ({
    ...a.invoice,
    days_overdue: a.days_overdue,
    bucket: a.bucket,
    decision: snap.decisions[a.invoice.id] || null,
  }));
  state.rows = rows;
  gridOptions.api.setGridOption("rowData", rows);

  const outstanding = snap.invoices.filter(
    (a) => a.invoice.status === "SENT" || a.invoice.status === "PARTIALLY_PAID",
  );
  const totalOut = outstanding.reduce((s, a) => s + Number(a.invoice.amount_due), 0);
  const overdue = outstanding.filter((a) => a.days_overdue > 0);
  const overdueTotal = overdue.reduce((s, a) => s + Number(a.invoice.amount_due), 0);
  const dueCount = rows.filter((r) => r.decision && r.decision.chase_due).length;

  const currency = outstanding[0] ? outstanding[0].invoice.currency_code : "GBP";
  document.getElementById("kpi-outstanding").textContent = money(totalOut, currency);
  document.getElementById("kpi-outstanding-note").textContent = `${outstanding.length} open invoices`;
  document.getElementById("kpi-overdue").textContent = String(overdue.length);
  document.getElementById("kpi-overdue-note").textContent = `${money(overdueTotal, currency)} late`;
  document.getElementById("kpi-due").textContent = String(dueCount);

  const fc = snap.forecast.filter((f) => f.expected_amount > 0);
  const firstCurrency = fc[0] ? fc[0].currency_code : currency;
  const twoWeek = fc.slice(0, 2).reduce((s, f) => s + f.expected_amount, 0);
  document.getElementById("kpi-forecast").textContent = money(twoWeek, firstCurrency);

  const fcBody = document.querySelector("#forecast-table tbody");
  fcBody.innerHTML = fc.length
    ? fc
        .map(
          (f) =>
            `<tr><td>${f.week_start}</td><td class="num">${money(f.expected_amount, f.currency_code)}</td><td>${f.invoice_ids.join(", ")}</td></tr>`,
        )
        .join("")
    : `<tr><td colspan="3" class="empty">Nothing expected yet - forecast fills in as invoices are issued.</td></tr>`;

  const chBody = document.querySelector("#chase-table tbody");
  chBody.innerHTML = snap.chases.length
    ? snap.chases
        .slice()
        .sort((a, b) => String(b.sent_at).localeCompare(String(a.sent_at)))
        .map(
          (c) =>
            `<tr><td>${c.invoice_id}</td><td>${stageLabel(c.stage)}</td><td>${String(c.sent_at).replace("T", " ").slice(0, 16)}</td><td>${c.approved_by}</td><td>${c.message_id || "-"}</td></tr>`,
        )
        .join("")
    : `<tr><td colspan="5" class="empty">No chases sent yet.</td></tr>`;
}

/* ---------- draft + approval ---------- */

async function openDraft(row) {
  try {
    const data = await api("/api/draft", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ invoice_id: row.id }),
    });
    state.current = { invoiceId: row.id, stage: data.draft.stage };
    document.getElementById("tray-empty").style.display = "none";
    document.getElementById("tray-form").style.display = "block";
    document.getElementById("tray-stage").textContent = stageLabel(data.draft.stage);
    document.getElementById("tray-invoice").textContent = `${row.id} - ${row.client_name}`;
    document.getElementById("tray-subject").value = data.draft.subject;
    document.getElementById("tray-body").value = data.draft.body;
    const approver = localStorage.getItem("chase_approver") || "";
    document.getElementById("tray-approver").value = approver;
    document.getElementById("tray-target").textContent = `Goes to ${row.client_email} via PayPal invoicing reminders on approve.`;
    document.getElementById("tray-approver").focus();
  } catch (err) {
    toast(`Could not draft: ${err.message}`, true);
  }
}

function closeTray() {
  state.current = null;
  document.getElementById("tray-form").style.display = "none";
  document.getElementById("tray-empty").style.display = "block";
}

async function approveAndSend() {
  if (!state.current) return;
  const approver = document.getElementById("tray-approver").value.trim();
  if (approver.length < 2) {
    toast("Add the approver name first - nothing sends without a named human approval.", true);
    document.getElementById("tray-approver").focus();
    return;
  }
  localStorage.setItem("chase_approver", approver);
  const btn = document.getElementById("btn-send");
  btn.disabled = true;
  try {
    const data = await api("/api/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        invoice_id: state.current.invoiceId,
        approved_by: approver,
        subject: document.getElementById("tray-subject").value,
        body: document.getElementById("tray-body").value,
      }),
    });
    toast(`Chase sent for ${data.sent.invoice_id} (message ${data.sent.message_id}), approved by ${data.sent.approved_by}.`);
    closeTray();
    await loadAll();
  } catch (err) {
    if (err.status === 400 && err.payload && err.payload.error === "approval_required") {
      toast("Approval name required before sending.", true);
    } else {
      toast(`Send failed: ${err.message}`, true);
    }
  } finally {
    btn.disabled = false;
  }
}

/* ---------- boot ---------- */

document.addEventListener("DOMContentLoaded", () => {
  const gridEl = document.getElementById("invoice-grid");
  const api_ = agGrid.createGrid(gridEl, gridOptions);
  gridOptions.api = api_;

  document.getElementById("btn-cancel").addEventListener("click", closeTray);
  document.getElementById("btn-send").addEventListener("click", approveAndSend);

  loadAll().catch((err) => toast(`Could not load data: ${err.message}`, true));

  setInterval(() => {
    loadAll().catch(() => {});
  }, 60000);
});
