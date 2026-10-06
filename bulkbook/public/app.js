/* Bulkbook browser app.
 *
 * Login: Clerk. Data: Supabase, called with the Clerk login token, so the database's row-level security
 * decides what each person may see. All changes go through database functions (see database/schema.sql),
 * which recompute prices and totals on the server. This file never holds a secret key: it only receives the
 * PUBLIC settings from /api/config. Creating and deleting employee logins goes through the server (/api/staff).
 *
 * Test seam: tests may set window.__BB_DEPS__ = { fetch, clerk, createClient } before this file loads.
 */
(function () {
"use strict";

/* ====================== helpers ====================== */
const DEPS = window.__BB_DEPS__ || {};
const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const num = (v) => (v == null ? 0 : Number(v));
const CUR = "GH\u20B5\u00A0";
const money = (n) => (n < 0 ? "-" : "") + CUR + Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const sum = (a, f) => a.reduce((t, x) => t + f(x), 0);
const isInt = (n) => Number.isInteger(n);
const digits = (s) => String(s).replace(/\D/g, "");
const phoneOk = (s) => /^\+?[0-9 ()-]+$/.test(s.trim()) && digits(s).length >= 9 && digits(s).length <= 15;
const fdate = (d) => d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
const ftime = (d) => fdate(d) + ", " + d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
const dayAge = (d) => Math.floor((Date.now() - d.getTime()) / 86400000);
const initials = (n) => n.replace(/[^A-Za-z0-9 ]/g, "").split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase();
const tintOf = (c) => ({ Grains: "t1", Canned: "t2", Oils: "t3", Drinks: "t4", Household: "t5" }[c] || "t0");
const METHODS = ["Cash", "Mobile money", "Bank transfer"];

/* ====================== selling units ======================
 * Box goods: sold as "box" or "piece". Bag goods: "bag" or "half" (half = exactly half of the bag price).
 * Stock is a whole number in the smallest unit: pieces for box goods, half-bags for bag goods.
 * The server recomputes every price; these helpers only show prices and check input early.
 */
const UNIT = { box: { one: "box", many: "boxes", btn: "Full box" }, piece: { one: "piece", many: "pieces", btn: "Pieces" }, bag: { one: "bag", many: "bags", btn: "Full bag" }, half: { one: "half bag", many: "half bags", btn: "Half bag" } };
const unitsOf = (p) => (p.type === "box" ? ["box", "piece"] : ["bag", "half"]);
const baseOf = (p, u, q) => (u === "box" ? q * p.ppb : u === "bag" ? q * 2 : q);
const uPrice = (p, u) => (u === "box" ? p.pBox : u === "piece" ? p.pPiece : u === "bag" ? p.pBag : r2(p.pBag / 2));
const uLabel = (u, q) => `${q} ${q === 1 ? UNIT[u].one : UNIT[u].many}`;
function stockText(p, n) {
  n = n == null ? p.stock : n;
  if (p.type === "box") { const b = Math.floor(n / p.ppb), r = n % p.ppb; return `${b} ${b === 1 ? "box" : "boxes"}` + (r ? ` + ${r} ${r === 1 ? "piece" : "pieces"}` : ""); }
  const bags = n / 2; return `${bags} ${bags === 1 ? "bag" : "bags"}`;
}
const inCartBase = (p) => sum(S.cart.filter((l) => l.pid === p.id), (l) => baseOf(p, l.unit, l.qty));

/* ====================== state ====================== */
const S = {
  status: "loading", err: "", me: null, settings: { shop_name: "My Wholesale Shop", timezone: "UTC", retention_months: 4 },
  view: "home", big: false, busy: false,
  products: [], customers: [], receipts: [], histReceipts: [], daily: [], monthly: [], oldCount: 0, staff: [], log: [],
  cart: [], cat: "All", q: "", gq: "", low: false,
  draft: { mode: "full", cid: "", cq: "", newName: "", newPhone: "", paid: "", method: "Cash" },
  owTab: "owe", owQ: "", rcFilter: "all", rcQ: "", repTab: "daily", repDay: null, repMonth: null, custSort: "owes",
};
let sb = null, clerk = null, PS = null;
const isOwner = () => !!S.me && S.me.role === "owner";
const prod = (id) => S.products.find((p) => p.id === id);
const cust = (id) => S.customers.find((c) => c.id === id);
const findReceipt = (id) => S.receipts.find((r) => r.id === id) || S.histReceipts.find((r) => r.id === id);
const paidOf = (r) => r2(sum(r.pays, (p) => p.amt));
const balance = (r) => r2(r.total - paidOf(r));
const cartTotal = () => r2(sum(S.cart, (l) => l.qty * uPrice(prod(l.pid), l.unit)));
const tzKey = (d) => new Intl.DateTimeFormat("en-CA", { timeZone: S.settings.timezone || "UTC", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
const dayDate = (k) => { const [y, m, d] = k.split("-").map(Number); return new Date(y, m - 1, d, 12); };
const mlabel = (k) => { const [y, m] = k.split("-"); return new Date(+y, +m - 1, 1).toLocaleDateString("en-GB", { month: "long", year: "numeric" }); };

/* ====================== talking to Supabase ====================== */
async function q(p) { const { data, error } = await p; if (error) throw new Error(error.message || "Something went wrong."); return data; }
const PCOLS = "id,sku,name,category,sell_type,pieces_per_box,price_piece,price_box,price_bag,stock_base,low_base,updated_at";
const RSEL = "id,no,created_at,created_by,employee_name,customer_id,total,paid_at,receipt_lines(product_id,product_name,unit,quantity,unit_price,line_total),payments(id,amount,method,kind,received_by_name,created_at)";
const mapProduct = (r) => ({ id: r.id, sku: r.sku, name: r.name, cat: r.category, type: r.sell_type, ppb: r.pieces_per_box || 0, pPiece: num(r.price_piece), pBox: num(r.price_box), pBag: num(r.price_bag), cost: null, stock: r.stock_base, low: r.low_base, upd: new Date(r.updated_at) });
const mapCustomer = (r) => ({ id: r.id, name: r.name, phone: r.phone, owes: num(r.owes), oldest: r.oldest_unpaid ? new Date(r.oldest_unpaid) : null, last: r.last_purchase ? new Date(r.last_purchase) : null, spent: r.spent == null ? null : num(r.spent), count: r.receipts_count == null ? null : r.receipts_count });
const mapReceipt = (r) => ({
  id: r.id, no: Number(r.no), at: new Date(r.created_at), uid: r.created_by, empName: r.employee_name, cid: r.customer_id, total: num(r.total), paidAt: r.paid_at ? new Date(r.paid_at) : null,
  lines: (r.receipt_lines || []).map((l) => ({ pid: l.product_id, name: l.product_name, unit: l.unit, qty: l.quantity, up: num(l.unit_price), total: num(l.line_total) })),
  pays: (r.payments || []).map((p) => ({ id: p.id, amt: num(p.amount), method: p.method, kind: p.kind, empName: p.received_by_name, at: new Date(p.created_at) })).sort((a, b) => a.at - b.at),
});

async function loadAll() {
  const sub = clerk.user ? clerk.user.id : (clerk.session && clerk.session.user && clerk.session.user.id);
  const prof = await q(sb.from("profiles").select("clerk_user_id,full_name,login_name,role,status").eq("clerk_user_id", sub));
  const me = prof && prof[0];
  if (!me || me.status !== "active") { S.me = null; return false; }
  S.me = me;
  const owner = me.role === "owner";
  const jobs = [
    q(sb.from("app_settings").select("shop_name,timezone,retention_months")),
    q(sb.from("products").select(PCOLS).order("name")),
    q(sb.rpc("customer_summary")),
    q(sb.from("receipts").select(RSEL).order("created_at", { ascending: false }).limit(300)),
    q(sb.rpc("report_daily", { p_days: 30 })),
    q(sb.rpc("report_monthly", { p_months: 12 })),
  ];
  if (owner) jobs.push(
    q(sb.rpc("product_costs")), q(sb.rpc("old_receipts_count")),
    q(sb.from("profiles").select("clerk_user_id,full_name,login_name,role,status")),
    q(sb.from("activity_log").select("at,actor_name,action,detail").order("at", { ascending: false }).limit(15)));
  const r = await Promise.all(jobs);
  if (r[0] && r[0][0]) S.settings = r[0][0];
  S.products = r[1].map(mapProduct);
  S.customers = r[2].map(mapCustomer);
  S.receipts = r[3].map(mapReceipt);
  S.daily = r[4].map((x) => ({ day: x.day, name: x.employee_name, count: x.receipts, sales: num(x.sales), recv: num(x.received) }));
  S.monthly = r[5].map((x) => ({ month: String(x.month).slice(0, 7), name: x.employee_name, count: x.receipts, sales: num(x.sales), cogs: x.cogs == null ? null : num(x.cogs) }));
  if (owner) {
    const costs = new Map(r[6].map((c) => [c.id, c.cost == null ? null : num(c.cost)]));
    S.products.forEach((p) => { p.cost = costs.has(p.id) ? costs.get(p.id) : null; });
    S.oldCount = Number(r[7]) || 0;
    S.staff = (r[8] || []).filter((u) => u.status === "active");
    S.log = (r[9] || []).map((l) => ({ at: new Date(l.at), who: l.actor_name, action: l.action, detail: l.detail }));
  }
  return true;
}
async function refresh(focusSel) { await loadAll(); render(focusSel); }
async function guard(fn) {
  if (S.busy) return;
  S.busy = true;
  try { await fn(); } catch (e) { toast(e && e.message ? e.message : "Something went wrong. Try again.", "error"); } finally { S.busy = false; }
}
async function callServer(method, path, body) {
  const token = await clerk.session.getToken();
  const res = await (DEPS.fetch || fetch)(path, { method, headers: { "content-type": "application/json", authorization: "Bearer " + token }, body: body ? JSON.stringify(body) : undefined });
  let j = {}; try { j = await res.json(); } catch (_) { /* no body */ }
  if (!res.ok) throw new Error(j.error || "The server could not do that. Try again.");
  return j;
}

/* ====================== boot ====================== */
function loadScript(src, attrs) {
  return new Promise((ok, bad) => {
    const s = document.createElement("script"); s.src = src; s.async = true; s.crossOrigin = "anonymous";
    for (const k in attrs || {}) s.setAttribute(k, attrs[k]);
    s.onload = ok; s.onerror = () => bad(new Error("Could not load " + src)); document.head.appendChild(s);
  });
}
async function loadClerk(pk) {
  const domain = atob(pk.split("_")[2]).slice(0, -1); // Frontend API domain is inside the publishable key (Clerk's documented method)
  await loadScript(`https://${domain}/npm/@clerk/ui@1/dist/ui.browser.js`);
  await loadScript(`https://${domain}/npm/@clerk/clerk-js@6/dist/clerk.browser.js`, { "data-clerk-publishable-key": pk });
  await window.Clerk.load({ ui: { ClerkUI: window.__internal_ClerkUICtor } });
  return window.Clerk;
}
async function boot() {
  try { S.big = localStorage.getItem("bb_big") === "1"; } catch (_) { /* storage may be blocked */ }
  document.documentElement.classList.toggle("big", S.big);
  render();
  try {
    const res = await (DEPS.fetch || fetch)("/api/config");
    const cfg = await res.json();
    if (!res.ok) throw new Error(cfg.error || "The app is not set up yet.");
    clerk = DEPS.clerk || (await loadClerk(cfg.clerkPublishableKey));
    const createClient = DEPS.createClient || (await import("https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm")).createClient;
    sb = createClient(cfg.supabaseUrl, cfg.supabasePublishableKey, { accessToken: async () => (clerk.session ? await clerk.session.getToken() : null) });
    clerk.addListener(() => { onAuthChange(); });
    await onAuthChange();
  } catch (e) { S.status = "error"; S.err = e.message || "Could not start."; render(); }
}
let authBusy = false;
async function onAuthChange() {
  if (authBusy) return; authBusy = true;
  try {
    if (!clerk.session) { S.status = "signin"; S.me = null; S.cart = []; render(); return; }
    if (S.status === "ready") return;
    S.status = "loading"; render();
    const ok = await loadAll();
    S.status = ok ? "ready" : "noaccess";
    if (ok) S.view = "home";
    render();
  } catch (e) { S.status = "error"; S.err = e.message || "Could not load your data."; render(); }
  finally { authBusy = false; }
}

/* ====================== plumbing ====================== */
let toastT;
function toast(msg, kind) { const t = $("#toast"); t.innerHTML = `<div class="${kind || ""}">${esc(msg)}</div>`; clearTimeout(toastT); toastT = setTimeout(() => (t.innerHTML = ""), 6000); }
function openDlg(html, cls) { const d = $("#dlg"); d.className = cls || ""; d.innerHTML = html; if (!d.open) d.showModal(); }
function closeDlg() { const d = $("#dlg"); if (d.open) d.close(); }
function render(focusSel) {
  const app = $("#app");
  if (S.status === "ready") app.innerHTML = shell();
  else if (S.status === "signin") { app.innerHTML = signinView(); mountSignIn(); }
  else app.innerHTML = messageView();
  if (focusSel) { const el = $(focusSel); if (el) el.focus(); }
}
function mountSignIn() {
  const el = $("#clerk-signin");
  if (el && clerk && clerk.mountSignIn) { try { clerk.mountSignIn(el, { appearance: { variables: { colorPrimary: "#4A123F", borderRadius: "1rem" } } }); } catch (_) { /* keep page usable */ } }
}
const IC = {
  home: '<path d="M3 11l9-8 9 8M5 10v10h14V10"/>', cart: '<circle cx="9" cy="20" r="1.5"/><circle cx="18" cy="20" r="1.5"/><path d="M3 4h2.5l2.2 11h10.3l2-8H6.5"/>',
  person: '<circle cx="12" cy="8" r="3.5"/><path d="M5 20c0-4 3-6.5 7-6.5s7 2.5 7 6.5"/>', box: '<path d="M3 7l9-4 9 4v10l-9 4-9-4zM3 7l9 4 9-4M12 11v10"/>',
  receipt: '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2zM9 8h6M9 12h6"/>', chart: '<path d="M4 20V10M10 20V4M16 20v-8M22 20H2"/>',
  team: '<circle cx="9" cy="8" r="3.2"/><path d="M3 20c0-3.5 2.7-6 6-6s6 2.5 6 6M16 5a3 3 0 010 6M18 14c2 .6 3.5 2.6 3.5 6"/>',
  bell: '<path d="M6 17V11a6 6 0 0112 0v6l1.5 2h-15zM10 21h4"/>', logout: '<path d="M9 4H5v16h4M16 8l4 4-4 4M20 12H9"/>',
  search: '<circle cx="11" cy="11" r="6"/><path d="M20 20l-4.5-4.5"/>', filter: '<path d="M4 7h10M18 7h2M4 17h2M10 17h10"/><circle cx="16" cy="7" r="2"/><circle cx="8" cy="17" r="2"/>',
  plus: '<path d="M12 5v14M5 12h14"/>', minus: '<path d="M5 12h14"/>', back: '<path d="M15 5l-7 7 7 7"/>',
  more: '<circle cx="5" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="19" cy="12" r="1.4"/>',
  text: '<path d="M4 19l5-14 5 14M6 14h6M16 9h5M18.5 9v10"/>', coin: '<circle cx="12" cy="12" r="8"/><path d="M12 8v8M9.5 10.5h4a1.5 1.5 0 010 3h-3a1.5 1.5 0 000 3h4"/>',
};
const VI = { home: "home", sell: "cart", owing: "person", goods: "box", receipts: "receipt", reports: "chart", staff: "team", more: "more" };
const icon = (k) => `<svg class="i" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${IC[k]}</svg>`;
const vIcon = (k) => icon(VI[k] || "home");
const FULL = { home: "Home", sell: "Sell goods", owing: "Who owes me", goods: "Goods in stock", receipts: "Receipts", reports: "Sales reports", staff: "Employees and shop" };
const SHORT = { home: "Home", sell: "Sell", owing: "Owing", goods: "Goods", receipts: "Receipts", reports: "Reports", staff: "Staff", more: "More" };
const TITLES = { home: "Home", sell: "Choose goods to sell", order: "Finish the sale", owing: "Who owes me", goods: "Goods in stock", receipts: "Receipts", reports: "Sales reports", staff: "Employees and shop" };

/* ====================== screens before login ====================== */
function signinView() {
  return `<div class="login"><section class="hero" aria-labelledby="hero-h"><div class="b" style="font-size:1.5rem">Bulkbook</div>
    <h1 id="hero-h">Know your stock, your sales and who owes you.</h1>
    <p>Sell by the box, the piece or the bag. Every sale makes a receipt. Every borrower is kept with name and phone.</p></section>
    <section class="login-side" aria-labelledby="si-h"><h2 id="si-h">Sign in</h2>
    <p class="muted">Use the login name and password the owner gave you.</p><div id="clerk-signin"></div>
    <button class="btn ghost" data-action="bigtext" aria-pressed="${S.big}">${icon("text")} Bigger text: ${S.big ? "on" : "off"}</button></section></div>`;
}
function messageView() {
  if (S.status === "loading") return `<div class="center-screen"><p class="spinner-text" role="status">Opening Bulkbook...</p></div>`;
  if (S.status === "noaccess") return `<div class="center-screen"><div class="card"><h1>No access yet</h1><p class="muted" style="margin-bottom:16px">You are signed in, but this login is not set up for the shop. Please ask the owner.</p><button class="btn" data-action="signout">Sign out</button></div></div>`;
  return `<div class="center-screen"><div class="card"><h1>Something went wrong</h1><p class="muted" style="margin-bottom:16px">${esc(S.err)}</p><button class="btn" data-action="retry">Try again</button></div></div>`;
}

/* ====================== shell ====================== */
function shell() {
  const u = S.me, owner = isOwner(), owers = S.customers.filter((c) => c.owes > 0).length, cartN = S.cart.length;
  const all = owner ? ["home", "sell", "owing", "goods", "receipts", "reports", "staff"] : ["home", "sell", "owing", "goods", "receipts", "reports"];
  const more = owner ? ["receipts", "reports", "staff"] : ["receipts", "reports"];
  const main = S.view === "order" ? "sell" : S.view, inMore = more.includes(S.view);
  const mob = ["home", "sell", "owing", "goods"].map((k) => { const on = main === k;
    return `<button class="pbtn ${on ? "on" : ""}" data-action="nav" data-view="${k}" aria-label="${FULL[k]}" ${on ? 'aria-current="page"' : ""}>${vIcon(k)}<span>${SHORT[k]}</span>${k === "owing" && owers ? `<span class="badge" aria-hidden="true">${owers}</span>` : ""}</button>`; }).join("")
    + `<button class="pbtn ${inMore ? "on" : ""}" data-action="more" aria-label="More: ${more.map((k) => FULL[k]).join(", ")}" ${inMore ? 'aria-current="page"' : ""}>${icon("more")}<span>${inMore ? SHORT[S.view] : "More"}</span></button>`;
  const desk = all.map((k) => `<li><button class="dbtn" data-action="nav" data-view="${k}" ${main === k ? 'aria-current="page"' : ""}>${vIcon(k)}<span>${FULL[k]}</span>${k === "owing" && owers ? `<span class="badge" aria-hidden="true">${owers}</span>` : ""}</button></li>`).join("");
  const views = { home: viewHome, sell: viewSell, order: viewOrder, owing: viewOwing, goods: viewGoods, receipts: viewReceipts, reports: viewReports, staff: viewStaff };
  const fab = S.view === "sell" && cartN ? `<button class="fab" data-action="nav" data-view="order">Finish sale: ${cartN} item${cartN > 1 ? "s" : ""}, ${money(cartTotal())}</button>` : "";
  return `<nav class="nav-d" aria-label="Main"><div class="brand">Bulkbook</div><ul>${desk}</ul></nav>
  <div class="wrap"><div class="wrap-inner">
    <header class="top"><div class="who"><span class="avatar" aria-hidden="true">${esc(initials(u.full_name))}</span><div><strong>${esc(u.full_name)}</strong><br><span class="small muted">${owner ? "Owner" : "Employee"}, ${esc(S.settings.shop_name)}</span></div></div>
      <div class="acts"><button class="round" data-action="bigtext" aria-pressed="${S.big}" aria-label="Bigger text">${icon("text")}</button>
      <button class="round" data-action="nav" data-view="owing" aria-label="Who owes me: ${owers} customers">${icon("bell")}${owers ? '<span class="dot"></span>' : ""}</button>
      <button class="round" data-action="signout" aria-label="Sign out">${icon("logout")}</button></div></header>
    <main id="main" tabindex="-1"><h1>${TITLES[S.view]}</h1>${views[S.view]()}</main></div></div>
  <nav class="nav-m" aria-label="Main">${mob}</nav>${fab}`;
}

/* ====================== home ====================== */
function viewHome() {
  const owner = isOwner(), today = tzKey(new Date()), rows = S.daily.filter((x) => x.day === today);
  const sales = r2(sum(rows, (x) => x.sales)), count = sum(rows, (x) => x.count);
  const owed = r2(sum(S.customers, (c) => c.owes)), owers = S.customers.filter((c) => c.owes > 0).length;
  const low = S.products.filter((p) => p.stock <= p.low).length;
  const t = (v, ic, l, s) => `<button class="tilebtn" data-action="${v === "addgoods" ? "gotoadd" : "nav"}" data-view="${v}"><span class="ic">${icon(ic)}</span>${l}<small>${s}</small></button>`;
  return `<section class="banner" aria-label="Sales today"><svg class="deco" viewBox="0 0 200 200" aria-hidden="true"><circle cx="100" cy="100" r="95" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="100" cy="100" r="65" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="100" cy="100" r="35" fill="none" stroke="currentColor" stroke-width="2"/></svg>
    <div class="in"><p class="lbl">${owner ? "Sales today, everyone" : "Your sales today"}</p><p class="big">${money(sales)}</p><p class="lbl" style="margin-bottom:16px">${count} receipt${count === 1 ? "" : "s"}</p><button class="btn light" data-action="nav" data-view="sell">Sell goods</button></div></section>
    <h2 class="sec">What do you want to do?</h2>
    <div class="tiles">${t("sell", "cart", "Sell goods", "Make a sale and a receipt")}${t("owing", "coin", "Record a payment", "Someone paid what they owe")}${t("goods", "box", "Goods in stock", "See stock and prices")}${t("addgoods", "plus", "Add goods", "New goods or more stock")}${t("receipts", "receipt", "Receipts", "Find or print a receipt")}${t("reports", "chart", "Sales reports", "Daily and monthly")}${owner ? t("staff", "team", "Employees and shop", "Logins and shop name") : ""}</div>
    <h2 class="sec">Needs your attention</h2>
    <div class="attn"><div class="card"><p class="muted">Owed to you</p><p class="attn v">${money(owed)}</p><p class="small muted" style="margin-bottom:10px">${owers} customer${owers === 1 ? "" : "s"}</p><button class="btn sm soft" data-action="nav" data-view="owing">See who owes me</button></div>
    <div class="card"><p class="muted">Goods running low</p><p class="attn v">${low}</p><p class="small muted" style="margin-bottom:10px">Time to buy more</p><button class="btn sm soft" data-action="nav" data-view="goods">See goods</button></div>
    ${owner ? `<div class="card"><p class="muted">Old receipts to delete</p><p class="attn v">${S.oldCount}</p><p class="small muted" style="margin-bottom:10px">Paid in full, over ${S.settings.retention_months} months ago</p><button class="btn sm soft" data-action="nav" data-view="receipts">Review</button></div>` : ""}</div>`;
}

/* ====================== sell ====================== */
function productCard(p) {
  const low = p.stock <= p.low, sub = p.type === "box" ? `${p.ppb} pieces per box` : "Sold as full or half bag";
  const pr = p.type === "box" ? `<span class="price">${money(p.pBox)}<small> / box</small></span><span class="small muted">${money(p.pPiece)} / piece</span>` : `<span class="price">${money(p.pBag)}<small> / bag</small></span><span class="small muted">${money(r2(p.pBag / 2))} / half bag</span>`;
  return `<article class="card pcard" data-action="openprod" data-pid="${p.id}"><div class="tile ${tintOf(p.cat)}"><span class="mono" aria-hidden="true">${esc(initials(p.name))}</span><span class="chip ${low ? "warn" : ""}">${low ? "Low: " : ""}${stockText(p)}</span></div>
    <h3>${esc(p.name)}</h3><p class="small muted">${sub}</p><div class="prow"><div class="prices">${pr}</div><button class="round green" data-action="openprod" data-pid="${p.id}" aria-label="Choose quantity for ${esc(p.name)}">${icon("plus")}</button></div></article>`;
}
function gridHtml() {
  const list = S.products.filter((p) => (S.cat === "All" || p.cat === S.cat) && (!S.q || (p.name + " " + p.sku).toLowerCase().includes(S.q)) && (!S.low || p.stock <= p.low));
  return list.length ? list.map(productCard).join("") : '<p class="muted">No goods match. Clear the search or the filters.</p>';
}
function viewSell() {
  const cats = ["All", ...new Set(S.products.map((p) => p.cat))];
  return `<div class="sell"><div><div class="searchrow"><div class="search">${icon("search")}<label class="sr" for="psearch">Find goods</label><input id="psearch" type="search" data-search placeholder="Search goods" value="${esc(S.q)}" autocomplete="off"></div>
    <button class="round" id="lowbtn" data-action="lowtoggle" aria-pressed="${S.low}" aria-label="Show low stock only">${icon("filter")}</button></div>
    <div class="chips" role="group" aria-label="Categories">${cats.map((c) => `<button class="cat" data-action="cat" data-c="${esc(c)}" aria-pressed="${S.cat === c}">${esc(c)}</button>`).join("")}</div>
    <div class="pgrid" id="pgrid">${gridHtml()}</div></div></div>`;
}
function prodHtml() {
  const p = prod(PS.pid), us = unitsOf(p), up = uPrice(p, PS.unit), total = r2(up * PS.qty), avail = p.stock - inCartBase(p);
  const save = p.type === "box" && p.pPiece * p.ppb > 0 ? (1 - p.pBox / (p.pPiece * p.ppb)) * 100 : 0;
  const tiles = p.type === "box" ? `<div><b>${p.ppb}</b>pieces per box</div><div><b>${money(p.pBox)}</b>full box</div><div><b>${stockText(p)}</b>in stock</div>` : `<div><b>Full or half</b>sold as</div><div><b>${money(p.pBag)}</b>full bag</div><div><b>${stockText(p)}</b>in stock</div>`;
  const about = p.type === "box" ? `Sold by the full box (${p.ppb} pieces) or by the piece. ${save > 0 ? `The box price saves ${save.toFixed(1)}% compared with ${p.ppb} single pieces.` : ""}` : `Sold as a full bag or a half bag. A half bag costs exactly half of the bag price, ${money(r2(p.pBag / 2))}.`;
  return `<div class="sheet-head"><button class="round" data-action="closedlg" aria-label="Close and go back">${icon("back")}</button><h2 id="dlg-title">Goods details</h2><span></span></div>
    <div class="tile big ${tintOf(p.cat)}"><span class="mono" aria-hidden="true">${esc(initials(p.name))}</span></div>
    <div style="display:flex;justify-content:space-between;gap:8px;align-items:flex-start;flex-wrap:wrap"><div><h3 style="font-size:1.3rem">${esc(p.name)}</h3><p class="small muted">${esc(p.cat)}, ${esc(p.sku)}</p></div>${save > 0 ? `<span class="pill">Box saves ${save.toFixed(1)}%</span>` : ""}</div>
    <div class="info3">${tiles}</div><p class="muted">${about}</p>
    <div class="pbar"><div class="seg" role="group" aria-label="Sell as">${us.map((u) => `<button data-action="punit" data-u="${u}" aria-pressed="${PS.unit === u}">${UNIT[u].btn}</button>`).join("")}</div>
      <div class="row"><div class="stepper"><button class="round" data-action="pstep" data-d="-1" aria-label="Less">${icon("minus")}</button>
        <label class="sr" for="pq">Quantity in ${UNIT[PS.unit].many}</label><input id="pq" data-pq type="number" min="1" step="1" inputmode="numeric" value="${PS.qty}">
        <button class="round" data-action="pstep" data-d="1" aria-label="More">${icon("plus")}</button></div>
        <button class="btn" data-action="padd">Add to order, ${money(total)}</button></div>
      <p class="small" style="padding:0 8px 4px">${money(up)} per ${UNIT[PS.unit].one}. Available now: ${stockText(p, Math.max(0, avail))}.</p></div>`;
}
function refreshProd(focus) { const d = $("#dlg"); d.innerHTML = prodHtml(); if (focus) { const el = $(focus, d); if (el) el.focus(); } }

/* ====================== customer search picker ====================== */
function custMatches(qs) {
  qs = qs.trim().toLowerCase(); const toks = qs.split(/\s+/).filter(Boolean), dq = digits(qs);
  return S.customers.filter((c) => { const n = c.name.toLowerCase(); return (toks.length && toks.every((t) => n.includes(t))) || (dq.length >= 3 && digits(c.phone).includes(dq)); });
}
function custResults() {
  const qs = S.draft.cq.trim();
  if (!qs) return { label: "Recent customers", list: S.customers.slice().sort((a, b) => (b.last || 0) - (a.last || 0)).slice(0, 5) };
  return { label: "", list: custMatches(qs).slice(0, 8) };
}
function custResultsHtml() {
  const { label, list } = custResults(), qs = S.draft.cq.trim();
  const items = list.map((c) => `<button class="cr" data-action="pickcust" data-cid="${c.id}"><span><strong>${esc(c.name)}</strong><br><span class="small muted">${esc(c.phone)}</span></span>${c.owes > 0 ? `<span class="chip warn">Owes ${money(c.owes)}</span>` : ""}</button>`).join("");
  const none = qs && !list.length ? `<p class="muted" style="margin-bottom:8px">No customer found for "${esc(qs)}".</p>` : "";
  return `<p class="small muted" style="margin-bottom:6px">${label || list.length + " found"}</p>${none}<div class="res">${items}<button class="btn soft" data-action="newcust">${icon("plus")} ${qs ? "Add new customer: " + esc(qs) : "Add a new customer"}</button></div>`;
}
function custPicker(d) {
  if (d.cid && d.cid !== "new") {
    const c = cust(d.cid); if (!c) return "";
    return `<div class="picked"><p class="b" style="font-size:1.2rem">${esc(c.name)}</p><p class="small muted">${esc(c.phone)}</p><button class="link" data-action="chgcust">Choose a different customer</button></div>${c.owes > 0 ? `<p class="note">${esc(c.name)} already owes ${money(c.owes)}. This sale will add to it.</p>` : ""}`;
  }
  if (d.cid === "new") return `<div class="two-col"><div class="field"><label for="nn">Customer name</label><input id="nn" data-bind="newName" value="${esc(d.newName)}" autocomplete="off"></div><div class="field"><label for="np">Phone number</label><input id="np" data-bind="newPhone" type="tel" inputmode="tel" value="${esc(d.newPhone)}" autocomplete="off"></div></div><button class="link" data-action="chgcust" style="margin-bottom:10px">Search existing customers instead</button>`;
  return `<div class="field"><label for="cq">Find a customer: type a name or phone number</label><input id="cq" data-bind="cq" type="search" value="${esc(d.cq)}" autocomplete="off" aria-controls="custres" placeholder="Start typing a name"></div><div id="custres" aria-live="polite">${custResultsHtml()}</div>`;
}

/* ====================== order / finish sale ====================== */
function viewOrder() {
  const total = cartTotal(), d = S.draft;
  if (!S.cart.length) return `<div class="card"><p class="muted" style="margin-bottom:12px">Nothing in the order yet.</p><button class="btn" data-action="nav" data-view="sell">Choose goods</button></div>`;
  const lines = S.cart.map((l, i) => { const p = prod(l.pid), up = uPrice(p, l.unit);
    return `<div class="line"><div><strong>${esc(p.name)}</strong><br><span class="small muted">${uLabel(l.unit, l.qty)} at ${money(up)} each</span></div><div style="text-align:right"><strong>${money(r2(l.qty * up))}</strong></div>
      <div class="stepper"><button class="round" data-action="lstep" data-i="${i}" data-d="-1" aria-label="Less ${esc(p.name)}">${icon("minus")}</button><label class="sr" for="lq-${i}">Quantity of ${esc(p.name)} in ${UNIT[l.unit].many}</label>
        <input id="lq-${i}" data-lineqty="${i}" type="number" min="1" step="1" inputmode="numeric" value="${l.qty}"><button class="round" data-action="lstep" data-i="${i}" data-d="1" aria-label="More ${esc(p.name)}">${icon("plus")}</button></div>
      <div style="text-align:right"><button class="link" data-action="rmline" data-i="${i}" aria-label="Remove ${esc(p.name)}">Remove</button></div></div>`; }).join("");
  let who = "";
  if (d.mode === "customer") {
    const paid = d.paid === "" ? total : parseFloat(d.paid), bal = isNaN(paid) ? total : r2(total - paid);
    who = `${custPicker(d)}
      <div class="field"><label for="paid">Paid now (GH\u20B5). Empty means paid in full.</label><input id="paid" data-bind="paid" type="number" inputmode="decimal" step="0.01" min="0" max="${total}" value="${esc(d.paid)}" placeholder="${total.toFixed(2)}"></div>
      <div class="btns" style="margin:-6px 0 12px"><button class="btn sm soft" data-action="setpaid" data-v="">Pays all</button><button class="btn sm soft" data-action="setpaid" data-v="${r2(total / 2)}">Pays half</button><button class="btn sm soft" data-action="setpaid" data-v="0">Pays nothing</button></div>
      <p class="b" style="margin-bottom:12px">Balance owed after this sale: ${money(Math.max(0, bal))}</p>`;
  }
  return `<div class="sell"><section class="card" aria-label="Order lines">${lines}
    <h2 style="margin:18px 0 10px">Who is buying?</h2><div class="seg" role="group" aria-label="Who is buying"><button data-action="mode" data-m="full" aria-pressed="${d.mode === "full"}">Pays everything now</button><button data-action="mode" data-m="customer" aria-pressed="${d.mode === "customer"}">Customer, may owe</button></div>
    <div style="margin-top:14px">${who}<div class="field"><label for="method">How was it paid?</label><select id="method" data-bind="method">${METHODS.map((m) => `<option ${d.method === m ? "selected" : ""}>${m}</option>`).join("")}</select></div></div>
    <div class="total"><span>Total</span><strong>${money(total)}</strong></div><button class="btn cta" data-action="checkout">Complete sale and make receipt</button></section></div>`;
}

/* ====================== owing ====================== */
function viewOwing() {
  const qs = S.owQ.toLowerCase(), rows = S.customers.filter((c) => (S.owTab === "all" || c.owes > 0) && (!qs || (c.name + " " + c.phone).toLowerCase().includes(qs)));
  rows.sort(S.owTab === "all" ? (a, b) => a.name.localeCompare(b.name) : (a, b) => (a.oldest || 0) - (b.oldest || 0));
  const totalOwed = r2(sum(S.customers, (c) => c.owes)), n = S.customers.filter((c) => c.owes > 0).length;
  const cards = rows.map((c) => `<article class="card cust"><div class="ctop"><h3>${esc(c.name)}</h3><span class="owe">${c.owes > 0 ? "Owes " + money(c.owes) : "Owes nothing"}</span></div>
    <p><a href="tel:${digits(c.phone)}" class="b">Call ${esc(c.phone)}</a></p>
    <p class="small muted" style="margin-top:4px">${c.oldest ? `Oldest unpaid receipt: ${dayAge(c.oldest)} days ago ${dayAge(c.oldest) > 30 ? '<span class="chip bad">Over 30 days</span>' : ""}<br>` : ""}${c.last ? "Last bought: " + fdate(c.last) : "No purchases yet"}</p>
    <div class="btns"><button class="btn" data-action="payform" data-cid="${c.id}" ${c.owes > 0 ? "" : "disabled"}>Record payment</button><button class="btn soft" data-action="chist" data-cid="${c.id}">History</button></div></article>`).join("");
  return `<div class="grid"><p class="card"><span class="muted">Total owed to you</span><br><strong style="font-size:1.8rem">${money(totalOwed)}</strong> <span class="muted">by ${n} customer${n === 1 ? "" : "s"}</span></p>
    <div class="seg tabs" role="group" aria-label="Show"><button data-action="owtab" data-t="owe" aria-pressed="${S.owTab === "owe"}">Owe me</button><button data-action="owtab" data-t="all" aria-pressed="${S.owTab === "all"}">All customers</button></div>
    <div class="search">${icon("search")}<label class="sr" for="owq">Find a customer</label><input id="owq" data-owq type="search" placeholder="Name or phone" value="${esc(S.owQ)}" autocomplete="off"></div>
    <div class="pgrid wide" id="owgrid">${cards || '<p class="muted">Nobody to show.</p>'}</div></div>`;
}
function payformHtml(c, unpaid) {
  return `<h2 id="dlg-title">Record a payment</h2><p class="muted" style="margin:4px 0 10px">${esc(c.name)}, ${esc(c.phone)}</p><p class="b" style="font-size:1.3rem;margin-bottom:8px">Owes ${money(c.owes)}</p>
    <ul style="margin:0 0 14px;padding-left:20px">${unpaid.map((r) => `<li>Receipt ${r.no}, ${fdate(new Date(r.created_at))}: ${money(num(r.balance))}</li>`).join("")}</ul>
    <form data-form="pay" data-cid="${c.id}"><div class="field"><label for="pa">Amount received (GH\u20B5)</label><input id="pa" name="amt" type="number" inputmode="decimal" step="0.01" min="0.01" max="${c.owes}" value="${c.owes}" required></div>
    <div class="field"><label for="pm">How was it paid?</label><select id="pm" name="method">${METHODS.map((m) => `<option>${m}</option>`).join("")}</select></div>
    <p class="small muted" style="margin-bottom:8px">The payment is applied to the oldest receipt first. It is recorded under your name.</p>
    <div class="actions"><button type="button" class="btn ghost" data-action="closedlg">Cancel</button><button class="btn" type="submit">Confirm payment</button></div></form>`;
}
function histHtml(c, rs) {
  const ps = rs.flatMap((r) => r.pays.map((p) => ({ ...p, rno: r.no }))).sort((a, b) => b.at - a.at);
  return `<h2 id="dlg-title">${esc(c.name)}</h2><p class="muted">${esc(c.phone)}</p>
    <p style="margin:10px 0">${c.spent != null ? `<span class="b">Total bought: ${money(c.spent)}</span> in ${c.count} receipts<br>` : ""}<span class="b">Owes now: ${money(c.owes)}</span></p>
    <h3 style="margin:10px 0 6px">Receipts</h3>${rs.map((r) => `<button class="link" data-action="openrc" data-rid="${r.id}" style="display:block;text-align:left">No. ${r.no}, ${fdate(r.at)}, ${money(r.total)}, ${balance(r) > 0 ? "owing " + money(balance(r)) : "paid"}</button>`).join("") || '<p class="muted">None kept.</p>'}
    <h3 style="margin:10px 0 6px">Payments</h3>${ps.slice(0, 12).map((p) => `<p class="small">${fdate(p.at)}: ${money(p.amt)}, ${esc(p.method)}, received by ${esc(p.empName)}</p>`).join("") || '<p class="muted">None.</p>'}
    <div class="actions"><button class="btn" data-action="closedlg">Close</button></div>`;
}

/* ====================== receipts ====================== */
function receiptHtml(r) {
  const c = r.cid ? cust(r.cid) : null, bal = balance(r);
  return `<div id="rcpt"><h2 id="dlg-title" style="text-align:center">${esc(S.settings.shop_name)}</h2><p style="text-align:center" class="muted">Receipt number ${r.no}</p>
    <p style="margin-top:10px">Date: ${ftime(r.at)}<br>Served by: ${esc(r.empName)}<br>Customer: ${c ? esc(c.name) + ", " + esc(c.phone) : r.cid ? "Customer" : "Walk-in, paid in full"}</p>
    <div class="tbl-wrap"><table><thead><tr><th>Goods</th><th class="num">Quantity</th><th class="num">Price</th><th class="num">Total</th></tr></thead><tbody>
    ${r.lines.map((l) => `<tr><td>${esc(l.name)}</td><td class="num">${uLabel(l.unit, l.qty)}</td><td class="num">${money(l.up)}</td><td class="num">${money(l.total)}</td></tr>`).join("")}</tbody></table></div>
    <p class="total" style="margin:10px 0 4px"><span>Total</span><strong style="font-size:1.4rem">${money(r.total)}</strong></p>
    <p class="b">Paid so far: ${money(paidOf(r))}</p><p class="b">Balance owed: ${money(bal)}</p>
    ${r.pays.length ? `<p class="small muted" style="margin-top:8px">${r.pays.map((p) => `${fdate(p.at)}: ${money(p.amt)} (${esc(p.method)}, ${esc(p.empName)})`).join("<br>")}</p>` : ""}
    <div class="actions noprint"><button class="btn ghost" data-action="print">Print</button><button class="btn" data-action="closedlg">Close</button></div></div>`;
}
function viewReceipts() {
  const owner = isOwner(), qs = S.rcQ.toLowerCase();
  let rs = S.receipts.filter((r) => (S.rcFilter === "all" || (S.rcFilter === "owing" ? balance(r) > 0 : balance(r) <= 0)) && (!qs || String(r.no).includes(qs) || (r.cid && cust(r.cid) && (cust(r.cid).name + " " + cust(r.cid).phone).toLowerCase().includes(qs))));
  const shown = rs.slice(0, 40);
  const cards = shown.map((r) => { const c = r.cid ? cust(r.cid) : null, b = balance(r);
    return `<button class="card rc" data-action="openrc" data-rid="${r.id}"><span class="ctop"><span class="b">No. ${r.no}</span><span class="chip ${b > 0 ? "warn" : "ok"}">${b > 0 ? "Owing " + money(b) : "Paid"}</span></span><br><span class="b" style="font-size:1.2rem">${money(r.total)}</span><br><span class="small muted">${ftime(r.at)}<br>${c ? esc(c.name) : "Walk-in"}, served by ${esc(r.empName)}</span></button>`; }).join("");
  return `<div class="grid">${owner ? `<section class="card"><h2>Old receipts</h2><p class="muted" style="margin:6px 0 12px">Receipts paid in full more than ${S.settings.retention_months} months ago can be deleted. Totals stay in the monthly report. Receipts that are still owing are never deleted. This also runs by itself once a day.</p>
    <p class="b" style="margin-bottom:10px">${S.oldCount} ready to delete</p><button class="btn" data-action="purgeask" ${S.oldCount ? "" : "disabled"}>Delete old receipts</button></section>` : ""}
    <div class="search">${icon("search")}<label class="sr" for="rq">Find a receipt</label><input id="rq" data-rq type="search" placeholder="Receipt number, name or phone" value="${esc(S.rcQ)}" autocomplete="off"></div>
    <div class="seg tabs" role="group" aria-label="Show">${[["all", "All"], ["owing", "Owing"], ["paid", "Paid"]].map(([k, l]) => `<button data-action="rcf" data-f="${k}" aria-pressed="${S.rcFilter === k}">${l}</button>`).join("")}</div>
    <div class="pgrid wide" id="rcgrid">${cards || '<p class="muted">No receipts match.</p>'}</div><p class="small muted">Showing ${shown.length} of ${rs.length} of the latest ${S.receipts.length} receipts.</p></div>`;
}

/* ====================== reports ====================== */
function viewReports() {
  const owner = isOwner();
  const tabs = [["daily", "Daily"], ["monthly", "Monthly"]].concat(owner ? [["customers", "Customers"]] : []);
  const head = `<div class="seg tabs" role="group" aria-label="Report">${tabs.map(([k, l]) => `<button data-action="reptab" data-t="${k}" aria-pressed="${S.repTab === k}">${l}</button>`).join("")}</div>`;
  let body = "";
  if (S.repTab === "daily") {
    const keys = [], seen = new Set();
    for (let i = 0; i < 30; i++) { const k = tzKey(new Date(Date.now() - i * 86400000)); if (!seen.has(k)) { seen.add(k); keys.push(k); } }
    const days = keys.map((k) => { const rs = S.daily.filter((x) => x.day === k); return { k, d: dayDate(k), count: sum(rs, (x) => x.count), sales: r2(sum(rs, (x) => x.sales)), recv: r2(sum(rs, (x) => x.recv)) }; });
    if (!S.repDay || !seen.has(S.repDay)) S.repDay = days[0].k;
    const by = {}; S.daily.filter((x) => x.day === S.repDay).forEach((x) => { const b = by[x.name] || (by[x.name] = { count: 0, sales: 0 }); b.count += x.count; b.sales = r2(b.sales + x.sales); });
    const last14 = days.slice(0, 14).reverse(), max = Math.max(...last14.map((d) => d.sales), 1), W = 700, H = 170, bw = W / last14.length;
    const svg = `<svg class="chart" viewBox="0 0 ${W} ${H + 26}" role="img" aria-label="Sales for each of the last ${last14.length} days. Highest day: ${money(max)}.">` + last14.map((d, i) => { const h = Math.max(3, d.sales / max * H); return `<rect x="${i * bw + 7}" y="${H - h}" width="${bw - 14}" height="${h}" rx="7" fill="var(--chart)" opacity="${i === last14.length - 1 ? 1 : .55}"><title>${fdate(d.d)}: ${money(d.sales)}</title></rect><text x="${i * bw + bw / 2}" y="${H + 18}" text-anchor="middle" font-size="13" fill="var(--ink2)">${d.d.getDate()}</text>`; }).join("") + "</svg>";
    body = `<div class="grid"><section class="card"><h2 style="margin-bottom:8px">Sales, last 14 days</h2>${svg}</section>
      <section class="card"><h2 style="margin-bottom:10px">Sales by person</h2><div class="field" style="max-width:320px"><label for="rd">Day</label><select id="rd" data-bind="repDay">${days.map((d) => `<option value="${d.k}" ${d.k === S.repDay ? "selected" : ""}>${fdate(d.d)}</option>`).join("")}</select></div>
      <div class="tbl-wrap"><table><thead><tr><th>Person</th><th class="num">Receipts</th><th class="num">Sales</th></tr></thead><tbody>${Object.entries(by).map(([n, b]) => `<tr><td>${esc(n)}</td><td class="num">${b.count}</td><td class="num">${money(b.sales)}</td></tr>`).join("") || '<tr><td colspan="3" class="muted">No sales on this day.</td></tr>'}</tbody></table></div></section>
      <section class="card"><h2 style="margin-bottom:8px">Every day</h2><div class="tbl-wrap"><table><thead><tr><th>Day</th><th class="num">Receipts</th><th class="num">Sales made</th><th class="num">Money received</th></tr></thead><tbody>${days.map((d) => `<tr><td>${fdate(d.d)}</td><td class="num">${d.count}</td><td class="num">${money(d.sales)}</td><td class="num">${money(d.recv)}</td></tr>`).join("")}</tbody></table></div>
      <p class="small muted" style="margin-top:8px">Sales made is what was sold. Money received is cash, mobile money or bank payments, including borrowers paying back.</p></section></div>`;
  }
  if (S.repTab === "monthly") {
    const mm = {}; S.monthly.forEach((x) => { const m = mm[x.month] || (mm[x.month] = { rev: 0, cogs: 0, count: 0, by: {} }); m.rev = r2(m.rev + x.sales); m.count += x.count; if (x.cogs != null) m.cogs = r2(m.cogs + x.cogs); const b = m.by[x.name] || (m.by[x.name] = { rev: 0, count: 0 }); b.rev = r2(b.rev + x.sales); b.count += x.count; });
    const keys = Object.keys(mm).sort().reverse();
    if (!S.repMonth || !mm[S.repMonth]) S.repMonth = keys[0];
    const sel = mm[S.repMonth];
    body = `<div class="grid"><section class="card"><h2 style="margin-bottom:8px">Every month</h2><div class="tbl-wrap"><table><thead><tr><th>Month</th><th class="num">Receipts</th><th class="num">Sales</th>${owner ? '<th class="num">Profit</th>' : ""}</tr></thead><tbody>${keys.map((k) => `<tr><td>${mlabel(k)}</td><td class="num">${mm[k].count}</td><td class="num">${money(mm[k].rev)}</td>${owner ? `<td class="num">${money(r2(mm[k].rev - mm[k].cogs))}</td>` : ""}</tr>`).join("") || '<tr><td colspan="4" class="muted">No sales yet.</td></tr>'}</tbody></table></div>
      ${owner ? '<p class="small muted" style="margin-top:8px">Profit is sales minus what the goods cost. It is too high when some goods have no cost price yet.</p>' : ""}</section>
      <section class="card"><h2 style="margin-bottom:10px">Sales by person</h2><div class="field" style="max-width:320px"><label for="rm">Month</label><select id="rm" data-bind="repMonth">${keys.map((k) => `<option value="${k}" ${k === S.repMonth ? "selected" : ""}>${mlabel(k)}</option>`).join("")}</select></div>
      <div class="tbl-wrap"><table><thead><tr><th>Person</th><th class="num">Receipts</th><th class="num">Sales</th></tr></thead><tbody>${sel ? Object.entries(sel.by).sort((a, b) => b[1].rev - a[1].rev).map(([n, b]) => `<tr><td>${esc(n)}</td><td class="num">${b.count}</td><td class="num">${money(b.rev)}</td></tr>`).join("") : ""}</tbody></table></div></section></div>`;
  }
  if (S.repTab === "customers" && owner) {
    const sorters = { owes: (a, b) => b.owes - a.owes, spent: (a, b) => (b.spent || 0) - (a.spent || 0), oldest: (a, b) => (a.oldest || Infinity) - (b.oldest || Infinity), last: (a, b) => (b.last || 0) - (a.last || 0) };
    const rows = S.customers.slice().sort(sorters[S.custSort]);
    body = `<section class="card"><h2 style="margin-bottom:10px">Your customers</h2><div class="field" style="max-width:320px"><label for="cs">Sort by</label><select id="cs" data-bind="custSort">${[["owes", "Who owes most"], ["spent", "Who buys most"], ["oldest", "Longest unpaid"], ["last", "Bought most recently"]].map(([k, l]) => `<option value="${k}" ${S.custSort === k ? "selected" : ""}>${l}</option>`).join("")}</select></div>
      <div class="tbl-wrap"><table><thead><tr><th>Customer</th><th class="num">Total bought</th><th class="num">Receipts</th><th class="num">Owes now</th><th class="num">Unpaid for</th><th>Last bought</th></tr></thead><tbody>${rows.map((c) => `<tr><td><strong>${esc(c.name)}</strong><br><span class="sku">${esc(c.phone)}</span></td><td class="num">${money(c.spent || 0)}</td><td class="num">${c.count == null ? 0 : c.count}</td><td class="num">${money(c.owes)}</td><td class="num">${c.oldest ? dayAge(c.oldest) + " days" : "none"}</td><td>${c.last ? fdate(c.last) : "none"}</td></tr>`).join("")}</tbody></table></div></section>`;
  }
  return head + body;
}

/* ====================== goods ====================== */
function viewGoods() {
  const owner = isOwner(), qs = S.gq.toLowerCase(), list = S.products.filter((p) => (!qs || (p.name + " " + p.sku).toLowerCase().includes(qs)) && (!S.low || p.stock <= p.low));
  const cards = list.map((p) => { const low = p.stock <= p.low;
    const pr = p.type === "box" ? `${money(p.pBox)} per box, ${money(p.pPiece)} per piece<br>${p.ppb} pieces in a box` : `${money(p.pBag)} per bag, ${money(r2(p.pBag / 2))} per half bag`;
    return `<article class="card"><div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap"><h3>${esc(p.name)}</h3>${low ? '<span class="chip warn">Low stock</span>' : ""}</div><p class="sku">${esc(p.sku)}, ${esc(p.cat)}${owner && p.cost == null ? ' <span class="chip warn">Cost needed</span>' : ""}</p>
      <p class="b" style="margin:8px 0 2px">In stock: ${stockText(p)}</p><p class="muted">${pr}</p>
      <div class="btns"><button class="btn sm" data-action="addstock" data-pid="${p.id}">Add stock</button>${owner ? `<button class="btn sm soft" data-action="editprod" data-pid="${p.id}">Change prices</button>` : ""}</div></article>`; }).join("");
  return `<div class="grid"><div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center"><button class="btn" data-action="addprod">${icon("plus")} Add new goods</button>
    <button class="btn ghost" id="lowbtn" data-action="lowtoggle" aria-pressed="${S.low}">${icon("filter")} Low stock only</button></div>
    <div class="search">${icon("search")}<label class="sr" for="gq">Find goods</label><input id="gq" data-gq type="search" placeholder="Search goods" value="${esc(S.gq)}" autocomplete="off"></div>
    ${owner ? "" : '<p class="muted">Only the owner can change prices. You can add new goods and add stock.</p>'}<div class="pgrid wide" id="ggrid">${cards || '<p class="muted">No goods match.</p>'}</div></div>`;
}
function stockFields(p, idp) {
  return p.type === "box" ? `<div class="two-col"><div class="field"><label for="${idp}-b">Boxes</label><input id="${idp}-b" name="boxes" type="number" min="0" step="1" value="${idp === "as" ? 0 : Math.floor(p.stock / p.ppb)}" required></div><div class="field"><label for="${idp}-p">Loose pieces</label><input id="${idp}-p" name="loose" type="number" min="0" step="1" value="${idp === "as" ? 0 : p.stock % p.ppb}" required></div></div>`
    : `<div class="field"><label for="${idp}-g">Bags (halves allowed, like 7.5)</label><input id="${idp}-g" name="bags" type="number" min="0" step="0.5" value="${idp === "as" ? 0 : p.stock / 2}" required></div>`;
}
function readStock(p, d) {
  if (p.type === "box") { const b = parseFloat(d.get("boxes")), l = parseFloat(d.get("loose")); if (!isInt(b) || !isInt(l) || b < 0 || l < 0) return null; return b * p.ppb + l; }
  const g = parseFloat(d.get("bags")); if (!(g >= 0) || !isInt(g * 2)) return null; return g * 2;
}
function addProdHtml() {
  const owner = isOwner();
  return `<h2 id="dlg-title">Add new goods</h2><form data-form="addprod" style="margin-top:12px">
    <div class="field"><label for="ap-name">Name of the goods</label><input id="ap-name" name="name" required autocomplete="off"></div>
    <div class="two-col"><div class="field"><label for="ap-cat">Category</label><input id="ap-cat" name="cat" list="cats" required autocomplete="off"><datalist id="cats">${[...new Set(S.products.map((p) => p.cat))].map((c) => `<option value="${esc(c)}">`).join("")}</datalist></div>
    <div class="field"><label for="ap-type">Sold in</label><select id="ap-type" name="type" data-typesel><option value="box">Boxes (box or pieces)</option><option value="bag">Bags (full or half)</option></select></div></div>
    <div class="f-box"><div class="two-col"><div class="field"><label for="ap-ppb">Pieces in one box</label><input id="ap-ppb" name="ppb" type="number" min="2" step="1" required></div><div class="field"><label for="ap-sb">Boxes now in stock</label><input id="ap-sb" name="boxes" type="number" min="0" step="1" value="0" required></div></div>
      <div class="two-col"><div class="field"><label for="ap-pp">Price of one piece</label><input id="ap-pp" name="pPiece" type="number" min="0.01" step="0.01" required></div><div class="field"><label for="ap-pb2">Price of a full box</label><input id="ap-pb2" name="pBox" type="number" min="0.01" step="0.01" required></div></div>
      <div class="field"><label for="ap-sl">Loose pieces now in stock</label><input id="ap-sl" name="loose" type="number" min="0" step="1" value="0" required></div></div>
    <div class="f-bag" hidden><div class="two-col"><div class="field"><label for="ap-pg">Price of a full bag</label><input id="ap-pg" name="pBag" type="number" min="0.01" step="0.01" required disabled></div><div class="field"><label for="ap-sg">Bags now in stock</label><input id="ap-sg" name="bags" type="number" min="0" step="0.5" value="0" required disabled></div></div><p class="small muted" style="margin:-6px 0 12px">A half bag is sold at exactly half the bag price.</p></div>
    ${owner ? `<div class="field"><label for="ap-cost">What the goods cost you (per piece, or per bag)</label><input id="ap-cost" name="cost" type="number" min="0" step="0.01"></div>` : '<p class="small muted" style="margin-bottom:12px">The owner adds the cost price later.</p>'}
    <div class="actions"><button type="button" class="btn ghost" data-action="closedlg">Cancel</button><button class="btn" type="submit">Save goods</button></div></form>`;
}
function editProdHtml(p) {
  const pr = p.type === "box" ? `<div class="two-col"><div class="field"><label for="ep-pp">Price of one piece</label><input id="ep-pp" name="pPiece" type="number" min="0.01" step="0.01" value="${p.pPiece}" required></div><div class="field"><label for="ep-pb">Price of a full box</label><input id="ep-pb" name="pBox" type="number" min="0.01" step="0.01" value="${p.pBox}" required></div></div>`
    : `<div class="field"><label for="ep-pg">Price of a full bag</label><input id="ep-pg" name="pBag" type="number" min="0.01" step="0.01" value="${p.pBag}" required></div>`;
  return `<h2 id="dlg-title">Change ${esc(p.name)}</h2><form data-form="editprod" data-pid="${p.id}" style="margin-top:12px">${pr}
    <div class="field"><label for="ep-cost">What it costs you (per ${p.type === "box" ? "piece" : "bag"})</label><input id="ep-cost" name="cost" type="number" min="0" step="0.01" value="${p.cost == null ? "" : p.cost}"></div>
    <p class="b" style="margin-bottom:6px">Stock on hand</p>${stockFields(p, "ep")}${p.type === "box" ? `<p class="small muted" style="margin:-4px 0 12px">Pieces in a box (${p.ppb}) cannot change after stock is recorded.</p>` : ""}
    <div class="actions"><button type="button" class="btn ghost" data-action="closedlg">Cancel</button><button class="btn" type="submit">Save changes</button></div></form>`;
}

/* ====================== staff + shop (owner only) ====================== */
function viewStaff() {
  const people = S.staff, today = tzKey(new Date());
  const log = S.log.map((l) => `<tr><td>${ftime(l.at)}</td><td>${esc(l.who || "")}</td><td>${esc(l.action)}</td><td>${esc(l.detail || "")}</td></tr>`).join("");
  let zones = []; try { zones = Intl.supportedValuesOf("timeZone"); } catch (_) { /* older browsers */ }
  return `<div class="grid"><section class="card"><h2 style="margin-bottom:6px">Shop settings</h2><p class="muted" style="margin-bottom:12px">The shop name is printed on receipts. The time zone decides when a day and a month start in the reports.</p>
    <form data-form="settings" style="display:grid;gap:10px;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));align-items:end"><div class="field" style="margin:0"><label for="shn">Shop name</label><input id="shn" name="shop" value="${esc(S.settings.shop_name)}" required></div>
    <div class="field" style="margin:0"><label for="shz">Time zone</label><input id="shz" name="tz" list="zones" value="${esc(S.settings.timezone)}" required><datalist id="zones">${zones.map((z) => `<option value="${esc(z)}">`).join("")}</datalist></div>
    <button class="btn" type="submit">Save settings</button></form></section>
    <section class="card"><h2 style="margin-bottom:6px">Create a login for an employee</h2><p class="muted" style="margin-bottom:12px">Give the employee the login name and password. Only you can create or delete logins.</p>
    <form data-form="addstaff" style="display:grid;gap:10px;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));align-items:end"><div class="field" style="margin:0"><label for="sn">Full name</label><input id="sn" name="name" required autocomplete="off"></div>
    <div class="field" style="margin:0"><label for="sl">Login name or email</label><input id="sl" name="login" required autocomplete="off"></div><div class="field" style="margin:0"><label for="sp">Password (8 or more characters)</label><input id="sp" name="pw" type="text" minlength="8" required autocomplete="off"></div>
    <button class="btn" type="submit">Create login</button></form></section>
    <section class="card"><h2 style="margin-bottom:10px">People who can sign in</h2>${people.map((u) => { const n = sum(S.daily.filter((x) => x.day === today && x.name === u.full_name), (x) => x.count);
      return `<div class="line"><div><strong>${esc(u.full_name)}</strong> <span class="chip">${u.role === "owner" ? "Owner" : "Employee"}</span><br><span class="small muted">Login name: ${esc(u.login_name || "")}. Receipts today: ${n}</span></div>${u.clerk_user_id === S.me.clerk_user_id || u.role === "owner" ? '<span class="muted small">' + (u.clerk_user_id === S.me.clerk_user_id ? "You" : "") + "</span>" : `<button class="btn sm danger" data-action="delask" data-uid="${esc(u.clerk_user_id)}" aria-label="Delete ${esc(u.full_name)}">Delete</button>`}</div>`; }).join("")}</section>
    <section class="card"><h2 style="margin-bottom:8px">Recent activity</h2><div class="tbl-wrap"><table><thead><tr><th>When</th><th>Who</th><th>What</th><th>Detail</th></tr></thead><tbody>${log}</tbody></table></div></section></div>`;
}

/* ====================== actions ====================== */
const ACT = {
  async signout() { try { await clerk.signOut(); } catch (_) { /* ignore */ } S.status = "signin"; S.me = null; S.cart = []; render(); },
  retry() { S.status = "loading"; S.err = ""; render(); onAuthChange(); },
  bigtext() { S.big = !S.big; document.documentElement.classList.toggle("big", S.big); try { localStorage.setItem("bb_big", S.big ? "1" : "0"); } catch (_) { /* ignore */ } render(); },
  nav(b) { closeDlg(); S.view = b.dataset.view; if (S.view !== "goods" && S.view !== "sell") S.low = false; render(); window.scrollTo(0, 0); const m = $("#main"); if (m) m.focus({ preventScroll: true }); },
  gotoadd() { S.view = "goods"; render(); window.scrollTo(0, 0); ACT.addprod(); },
  more() { const items = isOwner() ? ["receipts", "reports", "staff"] : ["receipts", "reports"];
    openDlg(`<h2 id="dlg-title">More</h2><div class="grid" style="margin-top:12px">${items.map((k) => `<button class="btn soft" data-action="nav" data-view="${k}" style="justify-content:flex-start">${vIcon(k)} ${FULL[k]}</button>`).join("")}</div><div class="actions"><button class="btn ghost" data-action="closedlg">Close</button></div>`); },
  cat(b) { S.cat = b.dataset.c; render(); },
  lowtoggle() { S.low = !S.low; render("#lowbtn"); },
  openprod(b) { const p = prod(b.dataset.pid); if (!p) return; PS = { pid: p.id, unit: unitsOf(p)[0], qty: 1 }; openDlg(prodHtml(), "sheet"); },
  punit(b) { PS.unit = b.dataset.u; refreshProd('[data-action="punit"][aria-pressed="true"]'); },
  pstep(b) { PS.qty = Math.max(1, PS.qty + parseInt(b.dataset.d, 10)); refreshProd(`[data-action="pstep"][data-d="${b.dataset.d}"]`); },
  padd() {
    const p = prod(PS.pid), qn = PS.qty; if (!isInt(qn) || qn < 1) return toast("Enter a whole number of 1 or more.", "error");
    if (inCartBase(p) + baseOf(p, PS.unit, qn) > p.stock) return toast(`Not enough stock. Available now: ${stockText(p, Math.max(0, p.stock - inCartBase(p)))}.`, "error");
    const line = S.cart.find((l) => l.pid === p.id && l.unit === PS.unit); if (line) line.qty += qn; else S.cart.push({ pid: p.id, unit: PS.unit, qty: qn });
    closeDlg(); render(); toast(`Added ${uLabel(PS.unit, qn)} of ${p.name}.`);
  },
  lstep(b) { const i = +b.dataset.i, l = S.cart[i], p = prod(l.pid), nq = l.qty + parseInt(b.dataset.d, 10); if (nq < 1) return;
    if (inCartBase(p) - baseOf(p, l.unit, l.qty) + baseOf(p, l.unit, nq) > p.stock) return toast("Not enough stock for that quantity.", "error"); l.qty = nq; render(`[data-action="lstep"][data-i="${i}"][data-d="${b.dataset.d}"]`); },
  rmline(b) { S.cart.splice(+b.dataset.i, 1); render(); },
  mode(b) { S.draft.mode = b.dataset.m; render(); },
  setpaid(b) { S.draft.paid = b.dataset.v; render("#paid"); },
  pickcust(b) { S.draft.cid = b.dataset.cid; S.draft.cq = ""; render("#paid"); },
  chgcust() { S.draft.cid = ""; render("#cq"); },
  newcust() { const qs = S.draft.cq.trim(); S.draft.cid = "new"; if (qs) { if (/\d{3,}/.test(qs) && !/[A-Za-z]/.test(qs)) S.draft.newPhone = qs; else S.draft.newName = qs; } S.draft.cq = ""; render(S.draft.newName ? "#np" : "#nn"); },
  owtab(b) { S.owTab = b.dataset.t; render(); },
  rcf(b) { S.rcFilter = b.dataset.f; render(); },
  reptab(b) { S.repTab = b.dataset.t; render(); },
  print() { window.print(); },
  closedlg() { closeDlg(); },
  addprod() { openDlg(addProdHtml(), "wide"); setTimeout(() => { const el = $("#ap-name"); if (el) el.focus(); }, 0); },
  editprod(b) { if (!isOwner()) return; const p = prod(b.dataset.pid); if (p) openDlg(editProdHtml(p), "wide"); },
  addstock(b) { const p = prod(b.dataset.pid); if (!p) return; openDlg(`<h2 id="dlg-title">Add stock: ${esc(p.name)}</h2><p class="muted" style="margin:4px 0 12px">Now in stock: ${stockText(p)}</p>
    <form data-form="addstock" data-pid="${p.id}">${stockFields(p, "as")}<div class="actions"><button type="button" class="btn ghost" data-action="closedlg">Cancel</button><button class="btn" type="submit">Add this stock</button></div></form>`); },
  openrc(b) { const r = findReceipt(b.dataset.rid); if (r) openDlg(receiptHtml(r), "wide"); },
  purgeask() { if (!isOwner() || !S.oldCount) return; const n = S.oldCount;
    openDlg(`<h2 id="dlg-title">Delete ${n} old receipt${n > 1 ? "s" : ""}?</h2><p style="margin:8px 0 14px">These receipts were paid in full more than ${S.settings.retention_months} months ago. They will be deleted for good. Monthly sales totals are kept.</p><div class="actions"><button class="btn ghost" data-action="closedlg">No, keep them</button><button class="btn danger" data-action="purgego">Yes, delete</button></div>`); },
  delask(b) { if (!isOwner()) return; const u = S.staff.find((x) => x.clerk_user_id === b.dataset.uid); if (!u) return;
    openDlg(`<h2 id="dlg-title">Delete ${esc(u.full_name)}?</h2><p style="margin:8px 0 14px">${esc(u.full_name)} will no longer be able to sign in. Receipts made by ${esc(u.full_name)} keep their name.</p><div class="actions"><button class="btn ghost" data-action="closedlg">No, keep</button><button class="btn danger" data-action="delgo" data-uid="${esc(u.clerk_user_id)}">Yes, delete</button></div>`); },

  /* ---- actions that talk to the server ---- */
  purgego() { return guard(async () => { const n = await q(sb.rpc("purge_old_receipts")); closeDlg(); await refresh(); toast(`Deleted ${n} old receipt${n === 1 ? "" : "s"}. Monthly totals are kept.`); }); },
  delgo(b) { return guard(async () => { await callServer("DELETE", "/api/staff/" + encodeURIComponent(b.dataset.uid)); closeDlg(); await refresh(); toast("The login was deleted."); }); },
  payform(b) { return guard(async () => { const c = cust(b.dataset.cid); if (!c) return; const unpaid = await q(sb.rpc("customer_unpaid", { p_customer_id: c.id })); openDlg(payformHtml(c, unpaid || [])); setTimeout(() => { const el = $("#pa"); if (el) el.focus(); }, 0); }); },
  chist(b) { return guard(async () => { const c = cust(b.dataset.cid); if (!c) return; const rows = await q(sb.from("receipts").select(RSEL).eq("customer_id", c.id).order("created_at", { ascending: false }).limit(40)); S.histReceipts = rows.map(mapReceipt); openDlg(histHtml(c, S.histReceipts), "wide"); }); },
  checkout() {
    return guard(async () => {
      if (!S.cart.length) return toast("Add at least one item first.", "error");
      const total = cartTotal(), d = S.draft; let paid = null, cid = null, nn = null, np = null;
      if (d.mode === "customer") {
        paid = d.paid === "" ? total : parseFloat(d.paid);
        if (!(paid >= 0) || paid > total || Math.abs(paid * 100 - Math.round(paid * 100)) > 1e-6) return toast("Paid now must be between 0 and the total, with at most 2 decimal places.", "error");
        if (d.cid === "new") {
          if (!d.newName.trim()) return toast("Enter the customer's name.", "error");
          if (!phoneOk(d.newPhone)) return toast("Enter a phone number with 9 to 15 digits.", "error");
          nn = d.newName.trim(); np = d.newPhone.trim();
        } else if (d.cid) cid = d.cid; else return toast("Search and choose a customer, or add a new customer with name and phone.", "error");
      }
      const lines = S.cart.map((l) => ({ product_id: l.pid, unit: l.unit, quantity: l.qty }));
      const rows = await q(sb.rpc("create_sale", { p_customer_id: cid, p_new_name: nn, p_new_phone: np, p_paid: paid, p_method: d.method, p_lines: lines }));
      const made = Array.isArray(rows) ? rows[0] : rows;
      S.cart = []; S.draft = { mode: "full", cid: "", cq: "", newName: "", newPhone: "", paid: "", method: "Cash" }; S.view = "sell";
      await refresh();
      const r = findReceipt(made.out_receipt_id); if (r) openDlg(receiptHtml(r), "wide");
    });
  },
};
document.addEventListener("click", (e) => { const b = e.target.closest("[data-action]"); if (b && ACT[b.dataset.action]) ACT[b.dataset.action](b, e); });
document.addEventListener("change", (e) => {
  const t = e.target;
  if (t.hasAttribute("data-pq")) { const qn = parseFloat(t.value), ok = isInt(qn) && qn >= 1; PS.qty = ok ? qn : 1; if (!ok) toast("Use a whole number of 1 or more.", "error"); refreshProd("#pq"); return; }
  if (t.dataset.lineqty !== undefined) { const i = +t.dataset.lineqty, l = S.cart[i], p = prod(l.pid), qn = parseFloat(t.value);
    if (!isInt(qn) || qn < 1) { toast("Use a whole number of 1 or more.", "error"); render(); return; }
    if (inCartBase(p) - baseOf(p, l.unit, l.qty) + baseOf(p, l.unit, qn) > p.stock) { toast("Not enough stock for that quantity.", "error"); render(); return; }
    l.qty = qn; render(); return; }
  if (t.hasAttribute("data-typesel")) { const bag = t.value === "bag", f = $("#dlg");
    f.querySelectorAll(".f-box").forEach((n) => { n.hidden = bag; n.querySelectorAll("input").forEach((i) => (i.disabled = bag)); });
    f.querySelectorAll(".f-bag").forEach((n) => { n.hidden = !bag; n.querySelectorAll("input").forEach((i) => (i.disabled = !bag)); }); return; }
  const k = t.dataset.bind;
  if (k === "method") S.draft.method = t.value;
  else if (k === "repDay") { S.repDay = t.value; render("#rd"); }
  else if (k === "repMonth") { S.repMonth = t.value; render("#rm"); }
  else if (k === "custSort") { S.custSort = t.value; render("#cs"); }
  else if (k === "paid") render("#paid");
});
function keepCaret(sel) { const el = $(sel); if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); } }
document.addEventListener("input", (e) => {
  const t = e.target, k = t.dataset.bind;
  if (k === "newName" || k === "newPhone" || k === "paid") S.draft[k] = t.value;
  if (k === "cq") { S.draft.cq = t.value; const r = $("#custres"); if (r) r.innerHTML = custResultsHtml(); }
  if (t.hasAttribute("data-search")) { S.q = t.value.trim().toLowerCase(); const g = $("#pgrid"); if (g) g.innerHTML = gridHtml(); }
  if (t.hasAttribute("data-gq")) { S.gq = t.value.trim(); render("#gq"); keepCaret("#gq"); }
  if (t.hasAttribute("data-owq")) { S.owQ = t.value.trim(); render("#owq"); keepCaret("#owq"); }
  if (t.hasAttribute("data-rq")) { S.rcQ = t.value.trim(); render("#rq"); keepCaret("#rq"); }
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && e.target.dataset && e.target.dataset.bind === "cq") { e.preventDefault(); const { list } = custResults(); if (list.length) { S.draft.cid = list[0].id; S.draft.cq = ""; render("#paid"); } }
});
document.addEventListener("submit", (e) => {
  const f = e.target, k = f.dataset.form; if (!k) return; e.preventDefault(); const d = new FormData(f);
  const pos = (v) => { const n = parseFloat(v); return n > 0 && Math.abs(n * 100 - Math.round(n * 100)) < 1e-6 ? n : null; };
  guard(async () => {
    if (k === "pay") {
      const c = cust(f.dataset.cid), amt = pos(d.get("amt"));
      if (amt == null || amt > c.owes) return toast(`Enter an amount up to ${money(c.owes)}, with at most 2 decimal places.`, "error");
      const res = await q(sb.rpc("record_payment", { p_customer_id: c.id, p_amount: amt, p_method: String(d.get("method")) }));
      closeDlg(); await refresh(); toast(`Payment of ${money(amt)} recorded for ${c.name}. Receipts: ${(res.receipts || []).map((x) => x.no + (x.paid_in_full ? " (paid in full)" : "")).join(", ")}.`);
    }
    if (k === "addstock") {
      const p = prod(f.dataset.pid), add = readStock(p, d); if (add == null || add <= 0) return toast("Enter a stock amount above zero. Use whole numbers (bags can end in .5).", "error");
      await q(sb.rpc("add_stock", { p_id: p.id, p_add_base: add })); closeDlg(); await refresh(); toast(`Added ${stockText(p, add)} to ${p.name}.`);
    }
    if (k === "editprod") {
      if (!isOwner()) return toast("Only the owner can change prices.", "error");
      const p = prod(f.dataset.pid), st = readStock(p, d), cost = d.get("cost") === "" ? null : parseFloat(d.get("cost"));
      const np = p.type === "box" ? { pPiece: pos(d.get("pPiece")), pBox: pos(d.get("pBox")) } : { pBag: pos(d.get("pBag")) };
      if (Object.values(np).some((v) => v == null) || st == null || (cost != null && !(cost >= 0))) return toast("Check the prices, cost and stock. Use whole numbers for stock (bags can end in .5).", "error");
      await q(sb.rpc("update_product", { p_id: p.id, p_price_piece: np.pPiece == null ? null : np.pPiece, p_price_box: np.pBox == null ? null : np.pBox, p_price_bag: np.pBag == null ? null : np.pBag, p_cost: cost, p_stock_base: st }));
      closeDlg(); await refresh(); toast("Saved " + p.name + ".");
    }
    if (k === "addprod") {
      const type = String(d.get("type")), name = String(d.get("name")).trim(), cat = String(d.get("cat")).trim();
      if (!name || !cat) return toast("Enter a name and a category.", "error");
      const cost = isOwner() && d.get("cost") !== "" && d.get("cost") !== null ? parseFloat(d.get("cost")) : null; let a;
      if (type === "box") { const ppb = parseFloat(d.get("ppb")), pP = pos(d.get("pPiece")), pB = pos(d.get("pBox")), b = parseFloat(d.get("boxes")), l = parseFloat(d.get("loose"));
        if (!isInt(ppb) || ppb < 2 || pP == null || pB == null || !isInt(b) || !isInt(l) || b < 0 || l < 0) return toast("Check pieces per box, both prices and the stock. Use whole numbers.", "error");
        a = { p_pieces_per_box: ppb, p_price_piece: pP, p_price_box: pB, p_price_bag: null, p_stock_base: b * ppb + l }; }
      else { const pg = pos(d.get("pBag")), g = parseFloat(d.get("bags")); if (pg == null || !(g >= 0) || !isInt(g * 2)) return toast("Check the bag price and stock. Bags can end in .5 only.", "error");
        a = { p_pieces_per_box: null, p_price_piece: null, p_price_box: null, p_price_bag: pg, p_stock_base: g * 2 }; }
      await q(sb.rpc("add_product", { p_name: name, p_category: cat, p_sell_type: type, p_cost: cost, ...a })); closeDlg(); await refresh(); toast(`Added ${name}.`);
    }
    if (k === "settings") {
      if (!isOwner()) return;
      await q(sb.rpc("update_settings", { p_shop_name: String(d.get("shop")).trim(), p_timezone: String(d.get("tz")).trim() })); await refresh(); toast("Settings saved.");
    }
    if (k === "addstaff") {
      if (!isOwner()) return; const name = String(d.get("name")).trim(), login = String(d.get("login")).trim().toLowerCase(), pw = String(d.get("pw"));
      const loginOk = login.includes("@") ? login.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(login) : /^[a-z0-9._-]{3,30}$/.test(login);
      if (!loginOk) return toast("Login: a login name (3 to 30 letters, numbers, dots or dashes, no spaces) or an email address.", "error");
      if (pw.length < 8) return toast("The password needs at least 8 characters.", "error");
      await callServer("POST", "/api/staff", { name, login, password: pw }); await refresh("#sn"); toast(`Login created for ${name}. Write down the password and give it to them.`);
    }
  });
});
// Clear a dialog's content when it closes (also when closed with Esc), so old forms never linger in the page.
$("#dlg").addEventListener("close", () => { $("#dlg").innerHTML = ""; });

boot();
})();
