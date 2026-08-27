import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { createPortal } from "react-dom";
import {
  ACTIVE_EMPLOYEE_KEY,
  COMPANY,
  CUSTOMERS_KEY,
  defaultManualReportType,
  defaultOrderHandlers,
  DISMISSED_NOTICES_KEY,
  FUNCTIONS_BASE_URL,
  isCardPayment,
  lookupRepairPrice,
  manualReportTypeKeys,
  ORDER_HANDLERS_KEY,
  paymentMethods,
  PAYMENT_REMINDER_CONTACT_EMAIL,
  PAYMENT_REMINDER_ENABLED,
  PAYMENT_REMINDER_TEXT,
  PENDING_REPORTS_KEY,
  PHONE_ORDERS_KEY,
  productCategories,
  PRODUCTS_KEY,
  RENTAL_PHONE_IN_STORE,
  RENTAL_PHONE_WITH_CUSTOMER,
  RENTAL_PHONES_KEY,
  repairStatuses,
  reportTypes,
  RESET_REQUESTS_KEY,
  STAFF_KEY,
  STORAGE_KEY,
  STORES_KEY,
} from "./constants";
import { useCloudCollectionState, useCloudDocumentState } from "./hooks/useCloudState";
import {
  attachAuthMetadata,
  callFunction,
  deleteCustomerDoc,
  ensureFirebaseAuth,
  findCustomerByPhone,
  listCustomersPage,
  saveCustomerDoc,
  searchCustomersByPhonePrefix,
  sendReset,
  signInWithEmail,
  signOutUser,
  subscribeAuth,
  subscribeCloudStatus,
} from "./firebaseClient";
import { refundToCard } from "./solaTerminal";
import { chargeOnLocalTerminal } from "./bbposTerminal";
import {
  buildAppNotifications,
  calculateInclusiveDays,
  calculateRentalLateFee,
  calculateRentalPrice,
  calculateReturnDueDate,
  code128Svg,
  createEmptyFilters,
  digitsOnly,
  effectiveLinePrice,
  escapeHtml,
  generateReceiptCode,
  exportCsv,
  localPhoneDigits,
  formatDateTime,
  formatMoney,
  formatPayment,
  formatReceiptPhone,
  formatShortDate,
  generateRepairTicketNumber,
  getMinimumRentalDays,
  isSolaPaidStatus,
  normalizeRcukSimNumber,
  numberValue,
  parsePriceAdjust,
  playScanBeep,
  playScanError,
  readJson,
  customerMatchesDigits,
  staffInitials,
  startOfDay,
  titleCaseName,
  toJsDate,
  unionByName,
  uniqueValues,
} from "./utils";
import "./styles.css";

function viewTitleFor(activeView, activeType) {
  if (activeView === "admin") return "Admin workspace";
  if (activeView === "pendingReports") return "Pending reports";
  if (activeView === "openRepairs") return "Open repairs";
  if (activeView === "pos") return "Point of sale";
  if (activeView === "inventory") return "Inventory";
  if (activeView === "reports" && reportTypes[activeType]) return reportTypes[activeType].title;
  return "Store reporting";
}

function App() {
  const [auth, setAuth] = useState({ status: "loading", user: null, isAdmin: false });

  useEffect(() => subscribeAuth(setAuth), []);

  if (auth.status === "loading") {
    return (
      <main className="auth-splash">
        <img className="brand-logo" src="/logo.webp" alt="Diamant Telecom" />
        <p className="muted">Loading…</p>
      </main>
    );
  }

  if (auth.status === "signed-in" && auth.user) {
    return <Workspace key={auth.user.uid} currentUser={auth.user} isAdmin={auth.isAdmin} />;
  }

  return <LoginPage authError={auth.status === "error" ? auth.error : null} />;
}

function PaymentReminderBanner() {
  if (!PAYMENT_REMINDER_ENABLED) return null;
  return (
    <div className="payment-reminder-banner" role="status">
      <strong>{PAYMENT_REMINDER_TEXT}</strong>
      <span>
        {" "}
        Contact{" "}
        <a href={`mailto:${PAYMENT_REMINDER_CONTACT_EMAIL}`}>{PAYMENT_REMINDER_CONTACT_EMAIL}</a>
      </span>
    </div>
  );
}

function Workspace({ currentUser, isAdmin }) {
  const employeeName = currentUser?.displayName || currentUser?.email || "";
  const sessionRole = isAdmin ? "admin" : "employee";
  const [activeType, setActiveType] = useState(defaultManualReportType);
  const [staff, setStaff] = useCloudDocumentState("staff", STAFF_KEY, [], { merge: unionByName });
  const [reports, setReports, reportsPendingSync] = useCloudCollectionState("reports", STORAGE_KEY, []);
  const [pendingReports, setPendingReports] = useCloudCollectionState("pendingReports", PENDING_REPORTS_KEY, []);
  const [phoneOrders, setPhoneOrders] = useCloudCollectionState("phoneOrders", PHONE_ORDERS_KEY, []);
  const [orderHandlers, setOrderHandlers] = useCloudCollectionState("orderHandlers", ORDER_HANDLERS_KEY, defaultOrderHandlers);
  // notificationLogs grows without bound and is only used for small previews and
  // counts — cap the live listener to the 50 most recent so it never re-reads the
  // whole history on load.
  const [notifications, setNotifications] = useCloudCollectionState(
    "notificationLogs",
    "diamant-telecom-notifications-v1",
    [],
    { limitTo: 50, orderByField: "createdAt" },
  );
  const [resetRequests, setResetRequests] = useCloudCollectionState(
    "passwordResetRequests",
    RESET_REQUESTS_KEY,
    [],
    { enabled: isAdmin },
  );
  const [products, setProducts] = useCloudCollectionState("products", PRODUCTS_KEY, []);
  const [rentalPhones, setRentalPhones] = useCloudCollectionState("rentalPhones", RENTAL_PHONES_KEY, []);
  const [stores, setStores] = useCloudDocumentState("stores", STORES_KEY, []);
  // Customers are queried on demand (see findCustomerByPhone / CustomersPage) —
  // never bulk-loaded — so a 10k+ CRM doesn't cost a read on every app load.

  // `stores` and `staff` are the single sources of truth. Every store name,
  // address, hours, tax rate and terminal device lives in one `stores` entry;
  // every employee name + assigned store lives in one `staff` entry. The lists
  // and the old per-concern shapes below are derived views so all screens read
  // from one place and the documents can never drift apart again.
  const storeLocations = useMemo(
    () => (stores || []).map((store) => store?.name).filter(Boolean),
    [stores],
  );
  const employees = useMemo(
    () => (staff || []).filter((member) => member?.name && !member.deleted).map((member) => member.name),
    [staff],
  );
  // A `store` object already carries rate/hours/address/deviceId and a `staff`
  // object carries location, so these aliases keep every existing lookup working.
  const storeTax = stores;
  const storeDevices = stores;
  const employeeLocations = staff;
  // Employees are locked to their own identity; admins can file/view as any
  // employee in the list.
  const [activeEmployee, setActiveEmployee] = useState(
    isAdmin ? localStorage.getItem(ACTIVE_EMPLOYEE_KEY) || employeeName || employees[0] || "" : employeeName,
  );
  const [activeView, setActiveView] = useState(isAdmin ? "admin" : "pos");
  // null = still checking, true = reaching the cloud, false = blocked/offline.
  const [cloudOnline, setCloudOnline] = useState(null);
  const [filters, setFilters] = useState(createEmptyFilters);
  // Ids of "Needs attention" notices this device has dismissed.
  const [dismissedNotices, setDismissedNotices] = useState(() => readJson(DISMISSED_NOTICES_KEY, []));
  const [formNonce, setFormNonce] = useState(0);
  const [returnTarget, setReturnTarget] = useState(null);

  // Keep the signed-in employee in the staff list so admins can see and
  // attribute to them. Adds a bare entry (no store yet) the first time they sign
  // in; the union merge keeps it from ever being dropped by another device.
  // Heal a given signed-in name at most once per session. Without this, a stale
  // tombstone on another device (or clock skew) that keeps re-winning the merge
  // would drop the name back out of `employees`, re-arming this effect and letting
  // it rewrite appState/staff on every snapshot echo — a self-sustaining loop.
  const healedNamesRef = useRef(new Set());
  useEffect(() => {
    if (employeeName && !employees.includes(employeeName) && !healedNamesRef.current.has(employeeName)) {
      healedNamesRef.current.add(employeeName);
      setStaff((current) => {
        const list = current || [];
        const existing = list.find((member) => member?.name === employeeName);
        // A signed-in user is active by definition, so clear any stale tombstone.
        if (existing) {
          return list.map((member) =>
            member?.name === employeeName
              ? { ...member, deleted: false, updatedAt: Date.now() }
              : member,
          );
        }
        return [...list, { name: employeeName, location: "", updatedAt: Date.now() }];
      });
    }
  }, [employeeName, employees, setStaff]);

  useEffect(() => {
    // The active employee is always the signed-in user — nobody (not even an
    // admin) can file or view as someone else.
    if (employeeName && activeEmployee !== employeeName) {
      setActiveEmployee(employeeName);
    }
  }, [activeEmployee, employeeName]);

  useEffect(() => {
    if (isAdmin) localStorage.setItem(ACTIVE_EMPLOYEE_KEY, activeEmployee);
  }, [activeEmployee, isAdmin]);

  useEffect(() => subscribeCloudStatus(setCloudOnline), []);

  // Warn before a manual refresh: a cold reload re-reads data from the database,
  // and refreshing often adds up to extra read charges. The app already syncs
  // live, so a refresh is rarely needed. Custom wording is only possible for the
  // keyboard refresh (F5 / Ctrl+R / Cmd+R); the browser's own reload button can't
  // show custom text.
  useEffect(() => {
    function onKeyDown(event) {
      const isRefreshKey = event.key === "F5"
        || ((event.ctrlKey || event.metaKey) && (event.key === "r" || event.key === "R"));
      if (!isRefreshKey) return;
      event.preventDefault();
      const reload = window.confirm(
        "Reloading re-reads data from the database and refreshing often can incur extra charges.\n\n"
        + "The app updates automatically, so you usually don't need to refresh.\n\nReload anyway?",
      );
      if (reload) window.location.reload();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const activeLocation = useMemo(() => {
    const match = (employeeLocations || []).find((entry) => entry?.name === activeEmployee);
    return match?.location || storeLocations[0] || "";
  }, [employeeLocations, activeEmployee, storeLocations]);

  const activeDeviceId = useMemo(() => {
    const match = (storeDevices || []).find((entry) => entry?.name === activeLocation);
    return match?.deviceId || "";
  }, [storeDevices, activeLocation]);

  // Store sales-tax rate as a percent (e.g. 8.875).
  const activeTaxRate = useMemo(() => {
    const match = (storeTax || []).find((entry) => entry?.name === activeLocation);
    return Number(match?.rate) || 0;
  }, [storeTax, activeLocation]);

  // Store address + hours for receipts (snapshotted onto each sale/repair).
  const activeStoreInfo = useMemo(() => {
    const match = (storeTax || []).find((entry) => entry?.name === activeLocation);
    return { address: formatStoreAddress(match), hours: match?.hours || "" };
  }, [storeTax, activeLocation]);

  const filteredReports = useMemo(() => {
    const query = filters.query.trim().toLowerCase();
    const phoneQuery = digitsOnly(query);
    const itemQuery = filters.item.trim().toLowerCase();
    const nameQuery = filters.customerName.trim().toLowerCase();
    const amountMin = Number.parseFloat(filters.amountMin);
    const amountMax = Number.parseFloat(filters.amountMax);
    const dateFrom = filters.dateFrom ? new Date(`${filters.dateFrom}T00:00:00`) : null;
    const dateTo = filters.dateTo ? new Date(`${filters.dateTo}T23:59:59`) : null;
    return reports.filter((report) => {
      const reportDate = toJsDate(report.createdAt);
      const reportAmount = Number.parseFloat(report.paymentAmount || "0") || 0;
      const searchable = [
        report.type,
        reportTypes[report.type]?.label,
        report.receiptCode,
        report.customerPhone,
        report.paymentAmount,
        report.paymentMethod,
        report.servedBy,
        report.notes,
        ...Object.values(report.details || {}),
      ]
        .join(" ")
        .toLowerCase();
      const searchableDigits = digitsOnly(searchable);
      const reportLocation = report.location || report.details?.location || "";
      const itemSearchable = [
        report.details?.model,
        report.details?.itemsText,
        report.details?.imei,
        report.details?.simNumber,
        report.details?.simPhone,
        ...(report.details?.lineItems || []).flatMap((line) => [line.name, line.sku, line.imei]),
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      const nameSearchable = [report.details?.customerName, report.details?.callerName]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();

      return (
        (filters.type === "all" || report.type === filters.type) &&
        (filters.employee === "all" || report.servedBy === filters.employee) &&
        (filters.paymentMethod === "all"
          || report.paymentMethod === filters.paymentMethod
          || (report.details?.payments || []).some((entry) => entry?.method === filters.paymentMethod)) &&
        (filters.status === "all" || report.details?.status === filters.status) &&
        (filters.location === "all" || reportLocation === filters.location) &&
        (!itemQuery || itemSearchable.includes(itemQuery)) &&
        (!nameQuery || nameSearchable.includes(nameQuery)) &&
        (!dateFrom || (reportDate && reportDate >= dateFrom)) &&
        (!dateTo || (reportDate && reportDate <= dateTo)) &&
        (!Number.isFinite(amountMin) || reportAmount >= amountMin) &&
        (!Number.isFinite(amountMax) || reportAmount <= amountMax) &&
        (!query || searchable.includes(query) || (phoneQuery && searchableDigits.includes(phoneQuery)))
      );
    });
  }, [filters, reports]);

  const visibleReports = useMemo(
    () => reports,
    [reports],
  );

  const visibleEmployees = employees;
  const visibleNotifications = useMemo(() => {
    const visibleReportIds = new Set(reports.map((report) => report.id));
    return notifications.filter((notice) => visibleReportIds.has(notice.reportId));
  }, [notifications, reports]);
  const rentalNotices = useMemo(() => buildAppNotifications(reports), [reports]);
  const appNotifications = useMemo(
    () => rentalNotices.filter((notice) => !dismissedNotices.includes(notice.id)),
    [rentalNotices, dismissedNotices],
  );

  // Hide one notice on this device. Dismissals of notices that no longer fire (the
  // rental came back) are dropped on the way out, so the stored list can't grow
  // without bound.
  function dismissNotification(id) {
    setDismissedNotices((current) => {
      const live = new Set(rentalNotices.map((notice) => notice.id));
      const next = [...new Set([...current.filter((entry) => live.has(entry)), id])];
      localStorage.setItem(DISMISSED_NOTICES_KEY, JSON.stringify(next));
      return next;
    });
  }

  function addStoreLocation(store) {
    const name = String((typeof store === "string" ? store : store?.name) || "").trim();
    if (!name || storeLocations.includes(name)) return;
    const address = typeof store === "string" ? {} : store || {};
    setStores((current) => [
      ...(current || []).filter((entry) => entry?.name !== name),
      {
        name,
        street: String(address.street || "").trim(),
        city: String(address.city || "").trim(),
        state: String(address.state || "").trim(),
        zip: String(address.zip || "").trim(),
        hours: String(address.hours || "").trim(),
        rate: 0,
        deviceId: "",
      },
    ]);
  }

  function removeStoreLocation(name) {
    if (storeLocations.length <= 1) {
      window.alert("Keep at least one store location.");
      return;
    }
    if (!window.confirm(`Remove ${name}? This also removes its tax and address settings.`)) return;
    setStores((current) => (current || []).filter((entry) => entry?.name !== name));
  }

  function setStoreTaxRate(name, rate) {
    const value = Number.parseFloat(rate);
    setStores((current) =>
      (current || []).map((entry) => (entry?.name === name ? { ...entry, rate: Number.isFinite(value) ? value : 0 } : entry)),
    );
  }

  // Edit any store config field (hours, address parts) for an existing store.
  function updateStoreInfo(name, patch) {
    setStores((current) => (current || []).map((entry) => (entry?.name === name ? { ...entry, ...patch } : entry)));
  }

  // Auto-add/merge a customer into the CRM from any sale/call/order. Only fills
  // blank fields on an existing customer — never overwrites entered details.
  // Query-on-demand: look the number up, then write just that one doc.
  async function upsertCustomer(info) {
    const phone = String(info?.phone || "").trim();
    const digits = localPhoneDigits(phone);
    if (!digits) return;
    const now = new Date().toISOString();
    const existing = await findCustomerByPhone(digits);
    if (!existing) {
      await saveCustomerDoc({
        name: String(info.name || "").trim(),
        phone,
        phoneDigits: digits,
        mobile: "",
        mobileDigits: "",
        address: String(info.address || "").trim(),
        email: String(info.email || "").trim(),
        contactDetails: String(info.contactDetails || "").trim(),
        notes: "",
        createdAt: now,
        updatedAt: now,
      });
      return;
    }
    const merged = {
      ...existing,
      phone: existing.phone || phone,
      name: existing.name || String(info.name || "").trim(),
      address: existing.address || String(info.address || "").trim(),
      email: existing.email || String(info.email || "").trim(),
      contactDetails: existing.contactDetails || String(info.contactDetails || "").trim(),
    };
    if (
      merged.phone === existing.phone &&
      merged.name === existing.name &&
      merged.address === existing.address &&
      merged.email === existing.email &&
      merged.contactDetails === existing.contactDetails
    ) {
      return;
    }
    merged.updatedAt = now;
    await saveCustomerDoc(merged);
  }

  // Manual create/edit from the CRM page (or the point-of-sale add dialog).
  async function saveCustomer(customer) {
    const phone = String(customer.phone || "").trim();
    const digits = localPhoneDigits(phone);
    const now = new Date().toISOString();
    const mobile = String(customer.mobile || "").trim();
    let id = customer.id || "";
    let createdAt = customer.createdAt || now;
    // No id but a known phone: fold into the existing record instead of duplicating.
    if (!id && digits) {
      const existing = await findCustomerByPhone(digits);
      if (existing) { id = existing.id; createdAt = existing.createdAt || now; }
    }
    await saveCustomerDoc({
      id: id || undefined,
      phone,
      phoneDigits: digits,
      mobile,
      mobileDigits: localPhoneDigits(mobile),
      name: titleCaseName(customer.name),
      address: String(customer.address || "").trim(),
      email: String(customer.email || "").trim(),
      contactDetails: String(customer.contactDetails || "").trim(),
      notes: String(customer.notes || "").trim(),
      createdAt,
      updatedAt: now,
    });
  }

  async function removeCustomer(customerId) {
    if (sessionRole !== "admin") {
      showAccessRestricted();
      return;
    }
    if (!window.confirm("Delete this customer? This cannot be undone.")) return;
    await deleteCustomerDoc(customerId);
  }

  // Fill in a name for a customer that has none yet (prompted at point of sale).
  async function saveCustomerName(customer, name) {
    const cleanName = titleCaseName(name);
    if (!cleanName || !customer) return;
    const target = customer.id
      ? customer
      : (customer.phoneDigits ? await findCustomerByPhone(customer.phoneDigits) : null);
    if (!target || target.name) return;
    await saveCustomerDoc({ ...target, name: cleanName, updatedAt: new Date().toISOString() });
  }

  // Backfill the CRM with any customer phone seen in the loaded reports. Uses the
  // deduping upsert (one lookup per unique number), so it never creates dupes.
  async function syncCustomersFromReports() {
    const seen = new Set();
    const unique = [];
    reports.forEach((report) => {
      const digits = report.customerPhoneDigits || digitsOnly(report.customerPhone);
      if (!digits || seen.has(digits)) return;
      seen.add(digits);
      const details = report.details || {};
      unique.push({
        phone: String(report.customerPhone || "").trim(),
        name: details.customerName || details.callerName || "",
        address: details.address || "",
        contactDetails: details.contactDetails || "",
      });
    });
    if (!unique.length) {
      window.alert("No phone numbers in the current reports to sync.");
      return;
    }
    if (!window.confirm(`Sync ${unique.length} phone number(s) from the loaded reports into the CRM?`)) return;
    for (const info of unique) {
      // eslint-disable-next-line no-await-in-loop
      await upsertCustomer(info);
    }
    window.alert(`Synced ${unique.length} number(s) into the CRM.`);
  }

  function setEmployeeLocation(name, location) {
    const cleanName = String(name || "").trim();
    if (!cleanName) return;
    setStaff((current) => {
      const list = current || [];
      // Update the assigned store in place, keeping the staff entry itself so
      // clearing a location never removes the employee from the list.
      if (list.some((entry) => entry?.name === cleanName)) {
        return list.map((entry) => (entry?.name === cleanName ? { ...entry, location, updatedAt: Date.now() } : entry));
      }
      return [...list, { name: cleanName, location, updatedAt: Date.now() }];
    });
  }

  function setStoreDevice(name, deviceId) {
    const cleanDeviceId = String(deviceId || "").trim();
    setStores((current) =>
      (current || []).map((entry) => (entry?.name === name ? { ...entry, deviceId: cleanDeviceId } : entry)),
    );
  }

  function saveProduct(product) {
    const id = product.id || crypto.randomUUID();
    const existing = products.find((item) => item.id === id);
    const requiresImei = Boolean(product.requiresImei);
    const imeis = requiresImei
      ? [
          ...new Set(
            (product.imeis || [])
              .map((value) => String(value || "").replace(/\D/g, ""))
              .filter(Boolean),
          ),
        ]
      : [];
    const quantity = requiresImei
      ? imeis.length
      : Number.isFinite(Number(product.quantity))
        ? Number(product.quantity)
        : 0;
    const normalized = {
      ...product,
      id,
      sku: String(product.sku || "").trim(),
      barcode: String(product.barcode || "").trim(),
      name: String(product.name || "").trim(),
      price: String(product.price ?? "").trim(),
      cost: sessionRole === "admin"
        ? String(product.cost ?? "").trim()
        : String(existing?.cost ?? "").trim(),
      category: product.category || productCategories[0],
      requiresImei,
      location: product.location || "",
      imeis,
      quantity,
      updatedAt: new Date().toISOString(),
    };
    setProducts((current) => {
      const exists = current.some((item) => item.id === id);
      if (exists) {
        return current.map((item) => (item.id === id ? { ...item, ...normalized } : item));
      }
      return [{ ...normalized, createdAt: new Date().toISOString() }, ...current];
    });
  }

  function removeProduct(productId) {
    if (sessionRole !== "admin") {
      window.alert("Only admin can delete inventory.");
      return;
    }
    const product = products.find((item) => item.id === productId);
    const label = product?.name || product?.sku || "this inventory item";
    if (!window.confirm(`Delete ${label}? This cannot be undone.`)) return;
    setProducts((current) => current.filter((item) => item.id !== productId));
  }

  async function savePosSale(sale) {
    const enriched = await attachAuthMetadata(sale);
    // Pass the details captured at checkout so this never files a nameless record.
    upsertCustomer({
      phone: sale.customerPhone,
      name: sale.details?.customerName || "",
      address: sale.details?.customerAddress || "",
    });
    setReports((current) => [enriched, ...current]);
    setProducts((current) =>
      current.map((product) => {
        const lines = (sale.details?.lineItems || []).filter((line) => line.productId === product.id);
        if (!lines.length) return product;
        if (product.requiresImei) {
          const soldImeis = new Set(lines.map((line) => line.imei).filter(Boolean));
          if (!soldImeis.size) return product;
          const remaining = (product.imeis || []).filter((imei) => !soldImeis.has(imei));
          return {
            ...product,
            imeis: remaining,
            quantity: remaining.length,
            updatedAt: new Date().toISOString(),
          };
        }
        const soldQty = lines.reduce((total, line) => total + (Number(line.qty) || 0), 0);
        const nextQuantity = Math.max(0, (Number(product.quantity) || 0) - soldQty);
        return { ...product, quantity: nextQuantity, updatedAt: new Date().toISOString() };
      }),
    );
  }

  async function saveReport(report) {
    const enriched = await attachAuthMetadata({
      ...report,
      location: report.location || activeLocation,
    });
    upsertCustomer({
      phone: report.customerPhone,
      name: report.details?.customerName || report.details?.callerName,
      address: report.details?.address,
    });
    setReports((current) => [enriched, ...current]);
    setFormNonce((value) => value + 1);
  }

  async function claimPendingReport(pendingReportId) {
    const pending = pendingReports.find((report) => report.id === pendingReportId);
    if (!pending) return;

    if (pending.claimedBy && pending.claimedBy !== activeEmployee) {
      window.alert(`This report is already claimed by ${pending.claimedBy}.`);
      return;
    }

    if (pending.claimedBy === activeEmployee) return;

    let claimedByEmployeeId = "";
    try {
      const user = await ensureFirebaseAuth();
      claimedByEmployeeId = user?.uid || "";
    } catch {
      // Local-only mode still records the employee name on the pending report.
    }

    setPendingReports((current) => {
      const target = current.find((report) => report.id === pendingReportId);
      if (!target) return current;
      if (target.claimedBy && target.claimedBy !== activeEmployee) return current;

      return current.map((report) =>
        report.id === pendingReportId
          ? {
              ...report,
              claimedBy: activeEmployee,
              claimedByEmployeeId,
              claimedAt: new Date().toISOString(),
              status: "claimed",
            }
          : report,
      );
    });
  }

  async function savePendingReport(pendingReportId, completedReport) {
    const enriched = await attachAuthMetadata({
      ...completedReport,
      location: completedReport.location || completedReport.details?.location || activeLocation,
    });
    upsertCustomer({
      phone: completedReport.customerPhone,
      name: completedReport.details?.callerName || completedReport.details?.customerName,
    });
    setReports((current) => [enriched, ...current]);
    setPendingReports((current) => current.filter((report) => report.id !== pendingReportId));
  }

  // Missed calls and voicemails don't get completed into a report — once an
  // employee has called the customer back they just dismiss the card, which
  // deletes the pending doc from Firestore (syncCollectionItems removes it).
  function dismissPendingReport(pendingReportId) {
    setPendingReports((current) => current.filter((report) => report.id !== pendingReportId));
  }

  async function createPhoneOrder(order) {
    let assignedEmployeeId = "";
    try {
      const user = await ensureFirebaseAuth();
      assignedEmployeeId = user?.uid || "";
    } catch {
      // Local-only mode still records the handler name on the order.
    }

    const enrichedOrder = {
      ...order,
      assignedEmployeeId,
      createdByEmployeeId: assignedEmployeeId,
    };
    upsertCustomer({
      phone: order.customerPhone,
      name: order.customerName,
      // Keep the customer's on-file address — never the one-off delivery address.
      address: order.address,
      contactDetails: order.contactDetails,
    });
    // The call-taker only routes the order to a store. Inventory is drawn down
    // and the customer/handler are notified later, once the store fulfills the
    // order (markOrderReady) and assigns a driver (assignOrderDriver).
    setPhoneOrders((current) => [enrichedOrder, ...current]);
    setFormNonce((value) => value + 1);
  }

  // Store fulfillment: the store has scanned the IMEIs (if any) and charged the
  // card (if CC), so commit the inventory and mark the order ready for a driver.
  function markOrderReady(orderId, patch = {}) {
    const order = phoneOrders.find((item) => item.id === orderId);
    if (!order) return;
    const lineItems = patch.lineItems || order.lineItems || [];

    // Draw the sold units down from inventory exactly like a POS sale (remove
    // the scanned IMEIs, decrement plain stock).
    setProducts((current) =>
      current.map((product) => {
        const lines = lineItems.filter((line) => line.productId === product.id);
        if (!lines.length) return product;
        if (product.requiresImei) {
          const soldImeis = new Set(lines.map((line) => line.imei).filter(Boolean));
          if (!soldImeis.size) return product;
          const remaining = (product.imeis || []).filter((imei) => !soldImeis.has(imei));
          return { ...product, imeis: remaining, quantity: remaining.length, updatedAt: new Date().toISOString() };
        }
        const soldQty = lines.reduce((total, line) => total + (Number(line.qty) || 0), 0);
        const nextQuantity = Math.max(0, (Number(product.quantity) || 0) - soldQty);
        return { ...product, quantity: nextQuantity, updatedAt: new Date().toISOString() };
      }),
    );

    const phoneLine = lineItems.find((line) => line.requiresImei && line.imei);
    setPhoneOrders((current) =>
      current.map((item) =>
        item.id === orderId
          ? {
            ...item,
            ...patch,
            lineItems,
            imei: phoneLine?.imei || item.imei || "",
            itemsText: lineItems
              .map((line) => `${line.qty}x ${line.name}${line.imei ? ` (IMEI ${line.imei})` : ""}`)
              .join(", "),
            status: "Ready",
            readyBy: activeEmployee,
            readyAt: new Date().toISOString(),
          }
          : item,
      ),
    );
  }

  // Store hands the ready order to a driver: record the driver, flip to "Out for
  // delivery", and fire the customer + handler texts (notifyPhoneOrderAssigned).
  function assignOrderDriver(orderId, handler) {
    const order = phoneOrders.find((item) => item.id === orderId);
    if (!order || !handler) return;
    const updated = {
      ...order,
      assignedTo: handler.name,
      assignedPhone: handler.phone || "",
      status: "Out for delivery",
      assignedAt: new Date().toISOString(),
      assignedBy: activeEmployee,
    };
    setPhoneOrders((current) => current.map((item) => (item.id === orderId ? updated : item)));
    queuePhoneOrderAssignedNotifications(updated);
  }

  // Cancel a phone order and drop it from the pipeline. If the store had already
  // committed stock (Ready / Out for delivery), put the units back on the shelf.
  function cancelPhoneOrder(orderId) {
    const order = phoneOrders.find((item) => item.id === orderId);
    if (!order) return;
    const committed = order.status === "Ready" || order.status === "Out for delivery";
    if (committed) {
      setProducts((current) =>
        current.map((product) => {
          const lines = (order.lineItems || []).filter((line) => line.productId === product.id);
          if (!lines.length) return product;
          if (product.requiresImei) {
            const returned = lines
              .map((line) => line.imei)
              .filter(Boolean)
              .filter((imei) => !(product.imeis || []).includes(imei));
            if (!returned.length) return product;
            const imeis = [...(product.imeis || []), ...returned];
            return { ...product, imeis, quantity: imeis.length, updatedAt: new Date().toISOString() };
          }
          const qty = lines.reduce((total, line) => total + (Number(line.qty) || 0), 0);
          return { ...product, quantity: (Number(product.quantity) || 0) + qty, updatedAt: new Date().toISOString() };
        }),
      );
    }
    setPhoneOrders((current) => current.filter((item) => item.id !== orderId));
  }

  // `payment` is what the driver collected at the door on a collect-on-delivery
  // order; prepaid orders arrive here with it already recorded by the store.
  async function completePhoneOrder(orderId, payment = null) {
    const order = phoneOrders.find((item) => item.id === orderId);
    if (!order) return;

    const deliveredAt = new Date().toISOString();
    const completedReport = await attachAuthMetadata({
      id: order.id,
      type: "phoneOrder",
      createdAt: deliveredAt,
      servedBy: activeEmployee,
      location: order.location || activeLocation,
      customerPhone: order.customerPhone,
      customerPhoneDigits: digitsOnly(order.customerPhone),
      paymentAmount: order.orderTotal,
      paymentMethod: payment?.paymentMethod || order.paymentMethod,
      notes: order.notes,
      details: {
        status: "Delivered",
        location: order.location,
        assignedTo: order.assignedTo,
        assignedPhone: order.assignedPhone,
        customerName: order.customerName,
        contactDetails: order.contactDetails,
        address: order.address,
        model: order.model,
        itemsText: order.itemsText || order.model,
        lineItems: order.lineItems || [],
        subtotal: order.subtotal,
        taxRate: order.taxRate,
        taxAmount: order.taxAmount,
        outOfState: order.outOfState,
        orderTotal: order.orderTotal,
        paymentStatus: payment ? "Paid" : order.paymentStatus,
        paymentMethod: payment?.paymentMethod || order.paymentMethod,
        solaRefNum: payment?.refNum || order.solaRefNum || "",
        collectedBy: payment ? activeEmployee : order.readyBy || "",
        paidAt: payment ? deliveredAt : order.paidAt || "",
        createdBy: order.createdBy,
        orderedAt: order.createdAt,
        deliveredAt,
      },
    });

    setReports((current) => [completedReport, ...current]);
    setPhoneOrders((current) => current.filter((item) => item.id !== orderId));
    queuePhoneOrderDeliveredNotification(order);
  }

  function addOrderHandler(handler) {
    const name = handler.name.trim();
    const location = handler.location.trim();
    if (!name || !location) return;

    // Store the SMS number with the US country code so texts always send
    // (Telebroad needs the leading "1"; bare 10-digit numbers fail).
    const phoneDigits = String(handler.phone || "").replace(/\D/g, "");
    const phone = phoneDigits.length === 10 ? `1${phoneDigits}` : phoneDigits;

    setOrderHandlers((current) => [
      ...current,
      {
        id: crypto.randomUUID(),
        name,
        phone,
        location,
      },
    ]);
  }

  function removeOrderHandler(handlerId) {
    const handler = orderHandlers.find((item) => item.id === handlerId);
    const label = handler?.name || "this order handler";
    if (!window.confirm(`Remove ${label}? This cannot be undone.`)) return;
    setOrderHandlers((current) => current.filter((handler) => handler.id !== handlerId));
  }

  function updateRepairStatus(reportId, status) {
    const report = reports.find((item) => item.id === reportId);
    const oldStatus = report?.details?.status;

    setReports((current) =>
      current.map((report) =>
        report.id === reportId
          ? { ...report, details: { ...report.details, status } }
          : report,
      ),
    );

    if (status === "Ready" && oldStatus !== "Ready" && report?.customerPhone && !FUNCTIONS_BASE_URL) {
      queueDeliveryNotification(report);
    }
  }

  // Mark a repair Ready with the final price the customer actually owes. The
  // final price becomes the charge/paid amount; the estimate stays on record.
  function markRepairReady(reportId, finalPrice) {
    const report = reports.find((item) => item.id === reportId);
    const oldStatus = report?.details?.status;
    const amount = String(finalPrice ?? "").trim();

    setReports((current) =>
      current.map((item) =>
        item.id === reportId
          ? {
              ...item,
              paymentAmount: amount || item.paymentAmount,
              details: { ...item.details, status: "Ready", finalPrice: amount },
            }
          : item,
      ),
    );

    if (oldStatus !== "Ready" && report?.customerPhone && !FUNCTIONS_BASE_URL) {
      queueDeliveryNotification(report);
    }
  }

  // Mark a repair paid (optionally storing card-charge details). Persisting the
  // status change triggers the notifyRepairPaid Cloud Function, which texts the
  // customer that their repair is marked paid.
  function markRepairPaid(reportId, extra = {}) {
    setReports((current) =>
      current.map((report) =>
        report.id === reportId
          ? { ...report, details: { ...report.details, paymentStatus: "Paid", ...extra } }
          : report,
      ),
    );
  }

  // Edit a repair's fields from the queue. `patch` may carry top-level keys
  // (customerPhone, paymentMethod, notes) and a nested `details` object; both are
  // shallow-merged so untouched fields are preserved.
  function updateRepair(reportId, patch) {
    const { details: detailsPatch = {}, ...top } = patch || {};
    if (typeof top.customerPhone === "string") {
      top.customerPhoneDigits = digitsOnly(top.customerPhone);
    }
    // Marking a rental returned (or cancelled) puts its handset back on the shelf,
    // so the fleet list never shows a phone as out once it's physically back.
    if (detailsPatch.returnedAt || detailsPatch.rentalStatus === "Cancelled") {
      const report = reports.find((entry) => entry.id === reportId);
      const phoneId = report?.details?.rentalPhoneId;
      if (phoneId) releaseRentalPhone(phoneId);
    }
    setReports((current) =>
      current.map((report) =>
        report.id === reportId
          ? { ...report, ...top, details: { ...report.details, ...detailsPatch } }
          : report,
      ),
    );
  }

  // --- Rental phone fleet ----------------------------------------------------
  function saveRentalPhone(phone) {
    const imei = digitsOnly(phone?.imei);
    const name = String(phone?.name || "").trim();
    if (!imei) return null;
    const existing = rentalPhones.find((entry) => digitsOnly(entry.imei) === imei);
    const record = {
      id: phone.id || existing?.id || crypto.randomUUID(),
      name: name || existing?.name || "Phone",
      imei,
      status: phone.status || existing?.status || RENTAL_PHONE_IN_STORE,
      rentalReportId: phone.rentalReportId ?? existing?.rentalReportId ?? "",
      customerPhone: phone.customerPhone ?? existing?.customerPhone ?? "",
      updatedAt: Date.now(),
    };
    setRentalPhones((current) => [
      ...current.filter((entry) => entry.id !== record.id),
      record,
    ]);
    return record;
  }

  // Hand a phone to a customer: flag it out and link it to the rental it went with.
  function issueRentalPhone(phoneId, { reportId, customerPhone }) {
    setRentalPhones((current) =>
      current.map((entry) => (entry.id === phoneId
        ? {
          ...entry,
          status: RENTAL_PHONE_WITH_CUSTOMER,
          rentalReportId: reportId || "",
          customerPhone: customerPhone || "",
          updatedAt: Date.now(),
        }
        : entry)),
    );
  }

  function releaseRentalPhone(phoneId) {
    setRentalPhones((current) =>
      current.map((entry) => (entry.id === phoneId
        ? { ...entry, status: RENTAL_PHONE_IN_STORE, rentalReportId: "", customerPhone: "", updatedAt: Date.now() }
        : entry)),
    );
  }

  function removeRentalPhone(phoneId) {
    setRentalPhones((current) => current.filter((entry) => entry.id !== phoneId));
  }

  function queueDeliveryNotification(report) {
    const method = report.details?.notificationPreference || "Text message";
    const notification = {
      id: crypto.randomUUID(),
      reportId: report.id,
      createdAt: new Date().toISOString(),
      customerPhone: report.customerPhone,
      method,
      status: "Queued for backend",
      message: `Your ${report.details?.model || "phone"} repair is ready for pickup. Thank you from Diamant Telecom.`,
    };

    setNotifications((current) => [notification, ...current]);
    window.alert(
      `${method} queued for ${report.customerPhone}. This will send automatically after Firebase Cloud Functions / SMS provider is connected.`,
    );
  }

  async function sendPhoneOrderNotification(endpoint, payload) {
    if (!FUNCTIONS_BASE_URL) return false;

    try {
      const response = await fetch(`${FUNCTIONS_BASE_URL}/${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  async function queuePhoneOrderAssignedNotifications(order) {
    if (FUNCTIONS_BASE_URL) {
      const sent = await sendPhoneOrderNotification("notifyPhoneOrderAssigned", order);
      if (!sent) {
        window.alert("Phone order was saved, but SMS notifications could not be sent.");
      }
      return;
    }

    const handlerMessage = `Phone order assigned: ${order.model}. Customer: ${order.customerName || "-"} ${order.customerPhone || ""}. Address: ${order.address || "-"}. Total: ${formatMoney(Number(order.orderTotal || 0))}. Payment: ${order.paymentStatus}. ${order.notes || ""}`;
    const customerMessage = `Diamant Telecom: your phone order for ${order.model || "your phone"} was assigned to ${order.assignedTo}. We will contact you with updates.`;
    const queued = [
      {
        id: crypto.randomUUID(),
        reportId: order.id,
        createdAt: new Date().toISOString(),
        customerPhone: order.customerPhone,
        method: "Text message",
        status: "Queued for backend",
        message: customerMessage,
      },
      {
        id: crypto.randomUUID(),
        reportId: order.id,
        createdAt: new Date().toISOString(),
        customerPhone: order.assignedPhone,
        method: "Text message",
        status: order.assignedPhone ? "Queued for backend" : "Missing handler phone",
        message: handlerMessage,
      },
    ];

    setNotifications((current) => [...queued, ...current]);
  }

  async function queuePhoneOrderDeliveredNotification(order) {
    if (FUNCTIONS_BASE_URL) {
      const sent = await sendPhoneOrderNotification("notifyPhoneOrderDelivered", order);
      if (!sent) {
        window.alert("Order was marked delivered, but the customer SMS could not be sent.");
      }
      return;
    }

    const notification = {
      id: crypto.randomUUID(),
      reportId: order.id,
      createdAt: new Date().toISOString(),
      customerPhone: order.customerPhone,
      method: "Text message",
      status: "Queued for backend",
      message: `Diamant Telecom: your phone order for ${order.model || "your phone"} has been delivered. Thank you.`,
    };

    setNotifications((current) => [notification, ...current]);
  }

  // Keep the staff list in step with the real user accounts so attribution and
  // admin filters keep working.
  function syncEmployeeName(name) {
    const cleanName = String(name || "").trim();
    if (!cleanName) return;
    setStaff((current) => {
      const list = current || [];
      const existing = list.find((member) => member?.name === cleanName);
      if (existing && !existing.deleted) return current; // already active, nothing to do
      // Re-adding a previously deleted name clears the tombstone with a fresh stamp.
      if (existing) {
        return list.map((member) =>
          member?.name === cleanName
            ? { ...member, deleted: false, updatedAt: Date.now() }
            : member,
        );
      }
      return [...list, { name: cleanName, location: "", updatedAt: Date.now() }];
    });
  }

  function unsyncEmployeeName(name) {
    const cleanName = String(name || "").trim();
    if (!cleanName) return;
    // Tombstone the entry (with a fresh timestamp) rather than dropping it, so the
    // delete wins the union merge and propagates instead of being resurrected by
    // another device that still has the name cached. Re-creating the user clears it.
    setStaff((current) => {
      const list = current || [];
      if (list.some((member) => member?.name === cleanName)) {
        return list.map((member) =>
          member?.name === cleanName
            ? { ...member, deleted: true, updatedAt: Date.now() }
            : member,
        );
      }
      return [...list, { name: cleanName, location: "", deleted: true, updatedAt: Date.now() }];
    });
  }

  function clearReports() {
    if (sessionRole !== "admin") {
      window.alert("Only admin can clear all reports.");
      return;
    }
    const confirmed = window.confirm(
      "Delete ALL reports from the shared store? This removes them for every employee and cannot be undone.",
    );
    if (!confirmed) return;
    setReports([]);
  }

  function deleteReport(reportId) {
    if (sessionRole !== "admin") {
      showAccessRestricted();
      return;
    }
    const report = reports.find((item) => item.id === reportId);
    const label = report ? reportTypes[report.type]?.label || report.type : "report";
    const confirmed = window.confirm(
      `Delete this ${label} report? This removes it for everyone and cannot be undone.`,
    );
    if (!confirmed) return;
    setReports((current) => current.filter((item) => item.id !== reportId));
  }

  // Find a sale by scanned receipt barcode (or id) and open its return dialog.
  function returnByCode(code) {
    const clean = String(code || "").trim().toLowerCase();
    if (!clean) return;
    const match = reports.find(
      (item) =>
        (item.receiptCode && item.receiptCode.toLowerCase() === clean) ||
        String(item.id).toLowerCase() === clean,
    );
    if (!match) {
      window.alert(`No sale found for receipt "${code}".`);
      return;
    }
    const lineItems = match.details?.lineItems || [];
    if (!(match.type === "sale" || match.type === "phoneOrder") || !lineItems.length) {
      window.alert("That receipt has no returnable items.");
      return;
    }
    if (match.details?.returnStatus === "Fully returned") {
      window.alert("That sale has already been fully returned.");
      return;
    }
    setReturnTarget(match);
  }

  async function processReturn(original, selection) {
    const returnLines = (selection.returnLines || []).filter((line) => Number(line.returnQty) > 0);
    if (!returnLines.length) return;

    const refundSubtotal = returnLines.reduce(
      (sum, line) => sum + (Number(line.price) || 0) * (Number(line.returnQty) || 0),
      0,
    );
    // The dialog computes the tax to refund from the original sale's rate; fall
    // back to the bare subtotal if an older caller didn't send the breakdown.
    const refundTax = Number(selection.refundTax) || 0;
    const refundTotal = Number.isFinite(Number(selection.refundTotal))
      ? Number(selection.refundTotal)
      : refundSubtotal + refundTax;
    const itemsText = returnLines
      .map((line) => `${line.returnQty}x ${line.name}${line.imei ? ` (IMEI ${line.imei})` : ""}`)
      .join(", ");
    const imeiLine = returnLines.find((line) => line.requiresImei && line.imei);

    const returnReport = await attachAuthMetadata({
      id: crypto.randomUUID(),
      type: "return",
      source: "return",
      createdAt: new Date().toISOString(),
      servedBy: activeEmployee,
      location: original.location || original.details?.location || activeLocation,
      customerPhone: original.customerPhone || "",
      customerPhoneDigits: digitsOnly(original.customerPhone),
      paymentAmount: (-refundTotal).toFixed(2),
      paymentMethod: selection.refundMethod || original.paymentMethod || "",
      notes: selection.notes || "",
      details: {
        request: "Return / refund",
        originalReportId: original.id,
        refundMethod: selection.refundMethod || original.paymentMethod || "",
        refundSubtotal: refundSubtotal.toFixed(2),
        refundTax: refundTax.toFixed(2),
        taxRate: Number(selection.taxRate) || 0,
        refundTotal: refundTotal.toFixed(2),
        solaRefundRef: selection.solaRefundRef || "",
        itemsText,
        model: itemsText,
        imei: imeiLine?.imei || "",
        lineItems: returnLines.map((line) => ({
          productId: line.productId,
          sku: line.sku,
          name: line.name,
          price: line.price,
          qty: line.returnQty,
          imei: line.imei || "",
          requiresImei: Boolean(line.requiresImei),
        })),
      },
    });

    // Record the refund and remember how much of each original line was returned.
    setReports((current) => [
      returnReport,
      ...current.map((report) => {
        if (report.id !== original.id) return report;
        const returnedByIndex = { ...(report.details?.returnedByIndex || {}) };
        returnLines.forEach((line) => {
          returnedByIndex[line.lineIndex] = (returnedByIndex[line.lineIndex] || 0) + Number(line.returnQty);
        });
        const originalLines = report.details?.lineItems || [];
        const fullyReturned = originalLines.length > 0 && originalLines.every((item, index) => {
          const soldQty = item.requiresImei ? 1 : Number(item.qty) || 1;
          return (returnedByIndex[index] || 0) >= soldQty;
        });
        const returnStatus = fullyReturned ? "Fully returned" : "Partially returned";
        return { ...report, details: { ...report.details, returnedByIndex, returnStatus } };
      }),
    ]);

    // Put the returned units back into stock (scanned IMEIs rejoin the lot).
    setProducts((current) =>
      current.map((product) => {
        const lines = returnLines.filter((line) => line.productId === product.id);
        if (!lines.length) return product;
        if (product.requiresImei) {
          const returnedImeis = lines.map((line) => line.imei).filter(Boolean);
          const merged = [...new Set([...(product.imeis || []), ...returnedImeis])];
          return { ...product, imeis: merged, quantity: merged.length, updatedAt: new Date().toISOString() };
        }
        const addQty = lines.reduce((sum, line) => sum + (Number(line.returnQty) || 0), 0);
        return {
          ...product,
          quantity: (Number(product.quantity) || 0) + addQty,
          updatedAt: new Date().toISOString(),
        };
      }),
    );
  }

  function requestPasswordReset(employeeName) {
    const name = String(employeeName || "").trim();
    if (!name) return;
    setResetRequests((current) => [
      {
        id: crypto.randomUUID(),
        employee: name,
        createdAt: new Date().toISOString(),
        status: "Requested",
      },
      ...current,
    ]);
    window.alert(`Logged a password-reset request for ${name}. They can also reset themselves from the login screen.`);
  }

  function markResetHandled(requestId) {
    setResetRequests((current) =>
      current.map((request) =>
        request.id === requestId ? { ...request, status: "Handled" } : request,
      ),
    );
  }

  async function logout() {
    try {
      await signOutUser();
    } catch (error) {
      console.error("Sign-out failed", error);
    }
  }

  return (
    <div className="app-shell">
      <Sidebar
        activeType={activeType}
        activeView={activeView}
        sessionRole={sessionRole}
        employees={employees}
        activeEmployee={activeEmployee}
        onEmployeeChange={setActiveEmployee}
        onTypeChange={setActiveType}
        onViewChange={setActiveView}
        onLogout={logout}
      />

      <main className={`main${activeView === "pos" ? " main-pos" : ""}`}>
        <PaymentReminderBanner />
        {cloudOnline === false ? (
          <div className="cloud-offline-banner" role="alert">
            ⚠️ Can't reach the cloud. Sales are being <strong>held on this computer</strong> and will upload
            automatically once the connection is back — don't wipe this browser's data. Check the internet/filter.
          </div>
        ) : null}
        {reportsPendingSync > 0 ? (
          <div className="cloud-pending-banner" role="status">
            ⏳ {reportsPendingSync} {reportsPendingSync === 1 ? "sale is" : "sales are"} still waiting to upload to the cloud.
            They are saved here and retry automatically — leave this computer on and online until this clears.
          </div>
        ) : null}
        <div className="topbar">
          <div>
            <p className="eyebrow">Signed in</p>
            <strong>{activeEmployee} - {sessionRole === "admin" ? "Admin" : "Employee"}</strong>
          </div>
          <div className="topbar-meta">
            <span>{viewTitleFor(activeView, activeType)}</span>
          </div>
          <button className="secondary-button" type="button" onClick={logout}>
            Logout
          </button>
        </div>

        <NotificationCenter notifications={appNotifications} onDismiss={dismissNotification} />

        {activeView === "pendingReports" ? (
          <PendingReportsPage
            pendingReports={pendingReports}
            activeEmployee={activeEmployee}
            onSaveCustomerName={saveCustomerName}
            onSaveCustomer={saveCustomer}
            onClaim={claimPendingReport}
            onSave={savePendingReport}
            onDismiss={dismissPendingReport}
          />
        ) : activeView === "openRepairs" ? (
          // Open repairs are not a day's log: a phone booked in last week is still
          // open today. The log's date range (which defaults to today) would hide
          // it, so this page gets every report and does its own search.
          <OpenRepairsPage
            reports={reports}
            employees={employees}
            storeTax={storeTax}
            activeTaxRate={activeTaxRate}
            onStatusChange={updateRepairStatus}
            onSetReady={markRepairReady}
            onMarkPaid={markRepairPaid}
            onEditRepair={updateRepair}
          />
        ) : activeView === "customers" ? (
          <CustomersPage
            sessionRole={sessionRole}
            onSave={saveCustomer}
            onRemove={removeCustomer}
            onSync={syncCustomersFromReports}
          />
        ) : activeView === "reports" ? (
          activeType === "rental" ? (
            <RentalReportForm
              key={`${activeType}-${formNonce}`}
              activeEmployee={activeEmployee}
              activeLocation={activeLocation}
              activeStoreInfo={activeStoreInfo}
              onSaveCustomerName={saveCustomerName}
              onSaveCustomer={saveCustomer}
              rentalPhones={rentalPhones}
              onSaveRentalPhone={saveRentalPhone}
              onIssueRentalPhone={issueRentalPhone}
              onSave={saveReport}
            />
          ) : activeType === "phoneOrder" ? (
            <PhoneOrderPage
              key={`${activeType}-${formNonce}`}
              activeEmployee={activeEmployee}
              sessionRole={sessionRole}
              activeLocation={activeLocation}
              storeLocations={storeLocations}
              phoneOrders={phoneOrders}
              orderHandlers={orderHandlers}
              storeTax={storeTax}
              storeDevices={storeDevices}
              products={products}
              onSaveCustomerName={saveCustomerName}
              onSaveCustomer={saveCustomer}
              onCreate={createPhoneOrder}
              onMarkReady={markOrderReady}
              onAssignDriver={assignOrderDriver}
              onCancel={cancelPhoneOrder}
              onDelivered={completePhoneOrder}
            />
          ) : (
            <ReportForm
              key={`${activeType}-${formNonce}`}
              activeType={activeType}
              activeEmployee={activeEmployee}
              activeLocation={activeLocation}
              reports={reports}
              activeStoreInfo={activeStoreInfo}
              employees={employees}
              onSaveCustomerName={saveCustomerName}
              onSaveCustomer={saveCustomer}
              onSave={saveReport}
            />
          )
        ) : activeView === "reportsLog" ? (
          <ReportHistory
            employees={visibleEmployees}
            activeEmployee={activeEmployee}
            storeLocations={storeLocations}
            reports={filteredReports}
            filters={filters}
            onFiltersChange={setFilters}
            onClearFilters={() => setFilters(createEmptyFilters())}
            onStatusChange={updateRepairStatus}
            onUpdateReport={updateRepair}
            onExport={() => exportCsv(filteredReports)}
            onExportAll={() => exportCsv(visibleReports)}
            onClearReports={sessionRole === "admin" ? clearReports : null}
            onDeleteReport={deleteReport}
            onReturn={setReturnTarget}
            onScanReturn={returnByCode}
            notifications={visibleNotifications}
          />
        ) : activeView === "pos" ? (
          <PosPage
            key={`pos-${formNonce}`}
            products={products}
            reports={reports}
            storeLocations={storeLocations}
            activeEmployee={activeEmployee}
            activeLocation={activeLocation}
            activeDeviceId={activeDeviceId}
            activeTaxRate={activeTaxRate}
            activeStoreInfo={activeStoreInfo}
            onSaveCustomerName={saveCustomerName}
            onSaveCustomer={saveCustomer}
            onSaveProduct={saveProduct}
            onCompleteSale={savePosSale}
          />
        ) : activeView === "inventory" ? (
          <InventoryPage
            products={products}
            storeLocations={storeLocations}
            sessionRole={sessionRole}
            onSaveProduct={saveProduct}
            onRemoveProduct={removeProduct}
            rentalPhones={rentalPhones}
            onSaveRentalPhone={saveRentalPhone}
            onReleaseRentalPhone={releaseRentalPhone}
            onRemoveRentalPhone={removeRentalPhone}
          />
        ) : (
          <AdminPage
            employees={employees}
            reports={reports}
            notifications={notifications}
            resetRequests={resetRequests}
            orderHandlers={orderHandlers}
            storeLocations={storeLocations}
            employeeLocations={employeeLocations}
            storeDevices={storeDevices}
            storeTax={storeTax}
            onMarkResetHandled={markResetHandled}
            onResetPassword={requestPasswordReset}
            onAddOrderHandler={addOrderHandler}
            onRemoveOrderHandler={removeOrderHandler}
            onAddStoreLocation={addStoreLocation}
            onRemoveStoreLocation={removeStoreLocation}
            onUpdateStoreInfo={updateStoreInfo}
            onSetStoreDevice={setStoreDevice}
            onSetStoreTaxRate={setStoreTaxRate}
            onSetEmployeeLocation={setEmployeeLocation}
            onRemoveEmployee={unsyncEmployeeName}
            onSyncName={syncEmployeeName}
            onUnsyncName={unsyncEmployeeName}
          />
        )}

        {activeView !== "pos" ? <PoweredByFooter /> : null}
      </main>

      {returnTarget && (
        <ReturnDialog
          report={returnTarget}
          onClose={() => setReturnTarget(null)}
          onSubmit={processReturn}
        />
      )}
    </div>
  );
}

function LoginPage({ authError }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [status, setStatus] = useState("idle");
  const [message, setMessage] = useState("");

  async function handleSubmit(event) {
    event.preventDefault();
    if (!email.trim() || !password) return;
    setStatus("signing-in");
    setMessage("");
    try {
      await signInWithEmail(email, password);
      // The auth listener in App will swap to the workspace on success.
    } catch (error) {
      setStatus("idle");
      setMessage(friendlyAuthError(error));
    }
  }

  async function handleForgotPassword() {
    if (!email.trim()) {
      setMessage("Enter your email above first, then tap Forgot password.");
      return;
    }
    try {
      await sendReset(email);
      setMessage("Password reset email sent. Check your inbox.");
    } catch (error) {
      setMessage(friendlyAuthError(error));
    }
  }

  const features = [
    { icon: "📞", title: "Calls", copy: "Log every customer call and follow-up." },
    { icon: "🛒", title: "Sales", copy: "Track sales and payments as they happen." },
    { icon: "🔧", title: "Repairs", copy: "Keep repair tickets moving to done." },
    { icon: "📶", title: "SIM & activations", copy: "Manage new lines and port-ins." },
  ];

  return (
    <main className="login-page">
      <section className="login-shell">
        <div className="login-aside">
          <div className="login-aside-top">
            <div className="brand">
              <img className="brand-mark brand-logo" src="/logo.webp" alt="Diamant Telecom" />
              <div>
                <h1>Diamant Telecom</h1>
                <p>Store reports</p>
              </div>
            </div>
            <div className="login-aside-copy">
              <p className="eyebrow">✦ Daily workspace</p>
              <h2>Every call, sale, repair, and activation — <em>in one clean place.</em></h2>
            </div>
          </div>

          <ul className="login-feature-list">
            {features.map((feature) => (
              <li key={feature.title}>
                <span className="login-feature-icon" aria-hidden="true">{feature.icon}</span>
                <span className="login-feature-text">
                  <strong>{feature.title}</strong>
                  <span>{feature.copy}</span>
                </span>
              </li>
            ))}
          </ul>

          <p className="login-aside-note">Secure store reporting for the Diamant Telecom team.</p>
        </div>

        <div className="login-panel">
          <div className="brand login-brand">
            <img className="brand-mark brand-logo" src="/logo.webp" alt="Diamant Telecom" />
            <div>
              <h1>Diamant Telecom</h1>
              <p>Store reports</p>
            </div>
          </div>

          <form className="login-form" onSubmit={handleSubmit}>
            <div className="login-form-head">
              <p className="eyebrow">Sign in</p>
              <h2>Welcome back</h2>
              <p className="login-form-sub">Sign in to your account to continue.</p>
            </div>

            <label className="field">
              <span>Email</span>
              <input
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="you@diamanttelecom.com"
                autoComplete="username"
                required
              />
            </label>

            <label className="field">
              <div className="field-label-row">
                <span>Password</span>
                <button className="link-button" type="button" onClick={handleForgotPassword}>
                  Forgot password?
                </button>
              </div>
              <input
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="Your password"
                autoComplete="current-password"
                required
              />
            </label>

            <button className="primary-button login-submit" type="submit" disabled={status === "signing-in"}>
              {status === "signing-in" ? "Signing in…" : "Sign in"}
            </button>
            {message ? <p className="summary-error">{message}</p> : null}
            {authError ? <p className="summary-error">Could not reach the sign-in service. Check your connection.</p> : null}
          </form>
          <PoweredByFooter />
        </div>
      </section>
    </main>
  );
}

function friendlyAuthError(error) {
  const code = error?.code || "";
  if (code.includes("invalid-credential") || code.includes("wrong-password") || code.includes("user-not-found")) {
    return "Incorrect email or password.";
  }
  if (code.includes("too-many-requests")) {
    return "Too many attempts. Wait a moment and try again.";
  }
  if (code.includes("network")) {
    return "Network error. Check your connection.";
  }
  return error?.message || "Sign-in failed. Please try again.";
}

function formatStoreAddress(entry) {
  if (!entry) return "";
  const cityState = [entry.city, entry.state].filter(Boolean).join(", ");
  return [entry.street, [cityState, entry.zip].filter(Boolean).join(" ").trim()].filter(Boolean).join(", ");
}

// Drop the company prefix from a store name so lists show just the branch:
// "Diamant Telecom - Monroe" -> "Monroe". Falls back to the full name if the
// prefix isn't there.
function shortStoreName(name) {
  const full = String(name || "").trim();
  if (!full) return "";
  const stripped = full.replace(/^\s*diamant\s*telecom\s*[-–—:·|]*\s*/i, "").trim();
  return stripped || full;
}

function PoweredByFooter() {
  return (
    <a
      className="powered-footer"
      href="https://www.advancedautomations.net"
      target="_blank"
      rel="noopener noreferrer"
    >
      <img src="/aa-logo.png" alt="Advanced Automations" />
      <span>Powered by Advanced Automations</span>
    </a>
  );
}

// Friendly gate shown when a non-admin taps an admin-only control.
function showAccessRestricted() {
  window.alert("Access restricted. Please contact the program administrator.");
}

function Sidebar({
  activeType,
  activeView,
  sessionRole,
  employees,
  activeEmployee,
  onEmployeeChange,
  onTypeChange,
  onViewChange,
  onLogout,
}) {
  return (
    <aside className="sidebar">
      <div className="brand">
        <img className="brand-mark brand-logo" src="/logo.webp" alt="Diamant Telecom" />
        <div>
          <h1>Diamant Telecom</h1>
          <p>Store reports</p>
        </div>
      </div>

      <nav className="report-tabs" aria-label="Navigation">
        <p className="nav-section-title">Daily</p>
        <button
          className={`tab pending-tab ${activeView === "pendingReports" ? "active" : ""}`}
          type="button"
          onClick={() => onViewChange("pendingReports")}
        >
          <span className="tab-mark">P</span>
          <span>
            <strong>Pending reports</strong>
            <small>Claim Shopify & call imports</small>
          </span>
        </button>
        <button
          className={`tab open-repairs-tab ${activeView === "openRepairs" ? "active" : ""}`}
          type="button"
          onClick={() => onViewChange("openRepairs")}
        >
          <span className="tab-mark">O</span>
          <span>
            <strong>Open repairs</strong>
            <small>Active tickets</small>
          </span>
        </button>
        <button
          className={`tab ${activeView === "reportsLog" ? "active" : ""}`}
          type="button"
          onClick={() => onViewChange("reportsLog")}
        >
          <span className="tab-mark">R</span>
          <span>
            <strong>Reports</strong>
            <small>Look up, returns & complaints</small>
          </span>
        </button>

        <p className="nav-section-title">Sell &amp; record</p>
        <button
          className={`tab pos-tab ${activeView === "pos" ? "active" : ""}`}
          type="button"
          onClick={() => onViewChange("pos")}
        >
          <span className="tab-mark">$</span>
          <span>
            <strong>Point of sale</strong>
            <small>Scan items & checkout</small>
          </span>
        </button>
        {manualReportTypeKeys.map((type) => {
          const config = reportTypes[type];
          return (
            <button
              className={`tab ${activeView === "reports" && activeType === type ? "active" : ""}`}
              type="button"
              key={type}
              onClick={() => {
                onTypeChange(type);
                onViewChange("reports");
              }}
            >
              <span className="tab-mark">{config.mark}</span>
              <span>
                <strong>{config.label}</strong>
                <small>{config.description}</small>
              </span>
            </button>
          );
        })}

        <p className="nav-section-title">Manage</p>
        <button
          className={`tab inventory-tab ${activeView === "inventory" ? "active" : ""}`}
          type="button"
          onClick={() => onViewChange("inventory")}
        >
          <span className="tab-mark">I</span>
          <span>
            <strong>Inventory</strong>
            <small>Catalog, stock & stores</small>
          </span>
        </button>
        <button
          className={`tab ${activeView === "customers" ? "active" : ""}`}
          type="button"
          onClick={() => onViewChange("customers")}
        >
          <span className="tab-mark">C</span>
          <span>
            <strong>Customers</strong>
            <small>CRM &amp; contacts</small>
          </span>
        </button>

        <button
          className={`tab ${activeView === "admin" ? "active" : ""}`}
          type="button"
          onClick={() => (sessionRole === "admin" ? onViewChange("admin") : showAccessRestricted())}
        >
          <span className="tab-mark">A</span>
          <span>
            <strong>Admin</strong>
            <small>Activity, audit & access</small>
          </span>
        </button>
      </nav>

      <div className="sidebar-account">
        <label className="field">
          <span>Signed in employee</span>
          {/* Locked to the signed-in identity — nobody (incl. admin) can switch. */}
          <input value={activeEmployee} disabled readOnly />
        </label>
        <button className="ghost-button" type="button" onClick={onLogout}>
          Sign out
        </button>
      </div>
    </aside>
  );
}

// Seeds field state so conditional (showIf) fields evaluate correctly on first
// render: selects default to their first option, everything else starts empty.
function buildInitialFieldValues(config) {
  const values = {};
  (config.fields || []).forEach((field) => {
    // A select with a placeholder starts empty (an unselected "prompt" option);
    // otherwise it defaults to its first real option.
    values[field.name] =
      field.type === "select" && field.options && !field.placeholder ? field.options[0] : "";
  });
  return values;
}

function ReportForm({ activeType, activeEmployee, activeLocation, reports, activeStoreInfo, employees = [], onSaveCustomerName, onSaveCustomer, onSave }) {
  const [now, setNow] = useState(new Date());
  const [customerPhone, setCustomerPhone] = useState("");
  // The customer the phone field resolved to (queried on demand), used to snapshot
  // name/address onto the report without loading the whole CRM.
  const [resolvedCustomer, setResolvedCustomer] = useState(null);
  const [paymentAmount, setPaymentAmount] = useState("");
  const [repairPriceHint, setRepairPriceHint] = useState("");
  const repairSelectionRef = useRef({ model: "", damage: "" });
  const config = reportTypes[activeType];
  const isRepair = activeType === "repair";
  const [fieldValues, setFieldValues] = useState(() => buildInitialFieldValues(config));

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 30000);
    return () => window.clearInterval(timer);
  }, []);

  // Tracks every field value so conditional fields (showIf) can react, and, for
  // repairs, auto-fills the payment amount from the price sheet when the
  // model + damage pair matches the sheet. The amount stays editable, and a
  // custom (non-sheet) model or damage simply leaves the amount untouched.
  function handleFieldChange(name, value) {
    setFieldValues((current) => ({ ...current, [name]: value }));

    if (!isRepair || (name !== "model" && name !== "damage")) return;

    const selection = repairSelectionRef.current;
    if (name === "model") selection.model = value;
    else selection.damage = value;

    const price = lookupRepairPrice(selection.model, selection.damage);
    if (!price) {
      setRepairPriceHint("");
      return;
    }
    if (price.kind === "fixed") {
      setPaymentAmount(String(price.amount));
      setRepairPriceHint(`Sheet price: ${price.display}`);
    } else if (price.kind === "range") {
      setPaymentAmount(price.amount != null ? String(price.amount) : "");
      setRepairPriceHint(`Sheet range ${price.display} — filled the low end, adjust as needed.`);
    } else if (price.kind === "na") {
      setPaymentAmount("");
      setRepairPriceHint("Not offered for this model on the price sheet.");
    } else {
      setRepairPriceHint("");
    }
  }

  const visibleFields = config.fields.filter(
    (field) => !field.showIf || fieldValues[field.showIf.field] === field.showIf.equals,
  );

  function handleSubmit(event) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const details = {};

    config.fields.forEach((field) => {
      details[field.name] = String(formData.get(field.name) || "").trim();
    });

    if (activeType === "repair") {
      // Require a status choice (it now defaults to the unselected "Select one").
      if (!details.status) {
        window.alert("Choose a repair status before saving.");
        return;
      }
      // Intake ("Received") means the phone is in hand: capture what we need to
      // identify it and label it before it goes on the shelf.
      if (details.status === "Received") {
        const missing = [];
        if (!details.model) missing.push("phone model");
        if (!details.damage) missing.push("what is damaged");
        if (!details.imei) missing.push("phone IMEI");
        if (missing.length) {
          window.alert(`Before receiving the phone, add: ${missing.join(", ")}.`);
          return;
        }
      }
      // What came in with the phone / whether we lent a loaner, so pickup can
      // reconcile the accessories and get the temporary phone back.
      details.hadSim = formData.get("hadSim") === "on";
      details.hadSdCard = formData.get("hadSdCard") === "on";
      details.borrowedTempPhone = formData.get("borrowedTempPhone") === "on";
      details.ticketNumber = generateRepairTicketNumber(reports);
      details.ticketDigits = digitsOnly(details.ticketNumber);
      // The intake amount is the quote; the real price is set when the repair is
      // marked Ready. Record it explicitly as the estimated price.
      details.estimatedPrice = String(formData.get("paymentAmount") || "").trim();
      // Who's fixing it, and (for a returned device) which ticket this follows up.
      details.technician = String(formData.get("technician") || "").trim();
      details.originalTicket = String(formData.get("originalTicket") || "").trim();
      // Intake no longer asks whether the repair is paid — it never is at that
      // point. Stamp it here so the Repairs queue, the take-payment dialog and
      // the reports all keep reading a value that is actually there.
      details.paymentStatus = "Not paid";
    }

    // Require a payment method whenever money is being recorded, so nothing is
    // ever saved as paid under an accidental default method.
    const paymentAmountValue = String(formData.get("paymentAmount") || "").trim();
    const paymentMethodValue = String(formData.get("paymentMethod") || "").trim();
    if (paymentAmountValue && !paymentMethodValue) {
      window.alert("Choose a payment method before saving.");
      return;
    }

    // Snapshot store + customer details so the printed ticket is self-contained.
    const phoneDigits = localPhoneDigits(formData.get("customerPhone"));
    const matchedCustomer = phoneDigits && customerMatchesDigits(resolvedCustomer, phoneDigits)
      ? resolvedCustomer
      : null;
    details.location = activeLocation || "";
    details.storeAddress = activeStoreInfo?.address || "";
    details.storeHours = activeStoreInfo?.hours || "";
    details.customerName = titleCaseName(details.customerName) || matchedCustomer?.name || "";
    details.customerMobile = matchedCustomer?.mobile || "";
    details.customerAddress = matchedCustomer?.address || "";

    const savedReport = {
      id: crypto.randomUUID(),
      type: activeType,
      createdAt: new Date().toISOString(),
      servedBy: activeEmployee,
      // Record which store took the report so it's visible on the repair queue.
      location: activeLocation || "",
      customerPhone: String(formData.get("customerPhone") || "").trim(),
      customerPhoneDigits: digitsOnly(formData.get("customerPhone")),
      paymentAmount: String(formData.get("paymentAmount") || "").trim(),
      paymentMethod: String(formData.get("paymentMethod") || "").trim(),
      notes: String(formData.get("notes") || "").trim(),
      details,
    };

    if (activeType === "repair") {
      savedReport.ticketDigits = details.ticketDigits;
    }

    onSave(savedReport);
    if (activeType === "repair") {
      // Small label to stick on the phone, then the full customer ticket.
      printRepairPhoneLabel(savedReport);
      printRepairTicket(savedReport);
    }
  }

  return (
    <section className="workspace">
      <div className="workspace-header">
        <div>
          <p className="eyebrow">New customer report</p>
          <h2>{config.title}</h2>
        </div>
        <div className="clock-pill">{formatDateTime(now)}</div>
      </div>

      <form className="report-form" onSubmit={handleSubmit} onKeyDown={preventEnterSubmit}>
        <div className="form-grid">
          <label className="field">
            <span>Customer / caller number</span>
            <CustomerPhoneInput
              name="customerPhone"
              value={customerPhone}
              onChange={setCustomerPhone}
              onSaveCustomerName={onSaveCustomerName}
              onSaveCustomer={onSaveCustomer}
              onResolveCustomer={setResolvedCustomer}
              onSelectCustomer={(customer) => { setCustomerPhone(customer.phone); setResolvedCustomer(customer); }}
              placeholder="(555) 123-4567"
              required
            />
          </label>

          <label className="field">
            <span>{isRepair ? "Estimated price" : "Payment amount"}</span>
            <input
              name="paymentAmount"
              inputMode="decimal"
              placeholder="0.00"
              value={paymentAmount}
              onChange={(event) => setPaymentAmount(event.target.value)}
            />
            {isRepair && repairPriceHint ? (
              <small className="field-hint">{repairPriceHint}</small>
            ) : null}
          </label>

          <label className="field">
            <span>Payment method</span>
            <select name="paymentMethod" defaultValue="">
              <option value="" disabled>Select one</option>
              {paymentMethods.map((method) => (
                <option key={method}>{method}</option>
              ))}
            </select>
          </label>

          {/* Repairs record servedBy on the report itself, so showing a
              read-only copy of it here is just noise on the intake screen. */}
          {isRepair ? null : (
            <label className="field">
              <span>Served by</span>
              <input value={activeEmployee} disabled readOnly />
            </label>
          )}
        </div>

        <div className="form-grid">
          {visibleFields.map((field) => (
            <DynamicField
              key={field.name}
              field={field}
              onValueChange={handleFieldChange}
            />
          ))}
        </div>

        {isRepair ? (
          <div className="form-grid">
            <label className="field">
              <span>Repair technician</span>
              <select name="technician" defaultValue="">
                <option value="">Unassigned</option>
                {employees.map((employee) => (
                  <option key={employee}>{employee}</option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Follow-up of ticket #</span>
              <input
                name="originalTicket"
                inputMode="numeric"
                placeholder="Original ticket, if returned"
                autoComplete="off"
              />
            </label>
          </div>
        ) : null}

        {isRepair ? (
          <div className="form-grid repair-accessories">
            <label className="field checkbox-field">
              <input type="checkbox" name="hadSim" />
              <span>Phone came with a SIM</span>
            </label>
            <label className="field checkbox-field">
              <input type="checkbox" name="hadSdCard" />
              <span>Phone came with an SD card</span>
            </label>
            <label className="field checkbox-field">
              <input type="checkbox" name="borrowedTempPhone" />
              <span>Borrowed a temporary phone</span>
            </label>
          </div>
        ) : null}

        <label className="field full">
          <span>Notes</span>
          <textarea name="notes" rows="4" placeholder="Add anything important about the customer request" />
        </label>

        <div className="form-actions">
          <button className="primary-button" type="submit">Save report</button>
          <button className="secondary-button" type="reset">Clear</button>
        </div>
      </form>
    </section>
  );
}

function DynamicField({ field, onValueChange }) {
  const handleChange = onValueChange
    ? (event) => onValueChange(field.name, event.target.value)
    : undefined;

  if (field.type === "select") {
    return (
      <label className="field">
        <span>{field.label}</span>
        <select name={field.name} defaultValue={field.placeholder ? "" : field.options[0]} onChange={handleChange}>
          {field.placeholder ? <option value="">{field.placeholder}</option> : null}
          {field.options.map((option) => (
            <option key={option}>{option}</option>
          ))}
        </select>
      </label>
    );
  }

  const listId = field.suggestions ? `${field.name}-suggestions` : undefined;

  return (
    <label className="field">
      <span>{field.label}</span>
      <input
        name={field.name}
        type={field.type || "text"}
        placeholder={field.placeholder || ""}
        list={listId}
        onChange={handleChange}
        {...(field.name === "imei" ? {
          inputMode: "numeric",
          autoComplete: "off",
          spellCheck: false,
        } : {})}
      />
      {field.suggestions ? (
        <datalist id={listId}>
          {field.suggestions.map((option) => (
            <option key={option} value={option} />
          ))}
        </datalist>
      ) : null}
    </label>
  );
}

function NotificationCenter({ notifications, onDismiss }) {
  if (!notifications.length) return null;

  return (
    <section className="notification-center">
      <div className="notification-center-head">
        <div>
          <p className="eyebrow">Notifications</p>
          <h2>Needs attention</h2>
        </div>
        {notifications.length > 1 ? (
          <button
            className="secondary-button compact-button"
            type="button"
            onClick={() => notifications.forEach((notification) => onDismiss(notification.id))}
          >
            Dismiss all
          </button>
        ) : null}
      </div>
      <div className="notification-list">
        {notifications.map((notification) => (
          <article className={`app-notification ${notification.severity}`} key={notification.id}>
            <div className="app-notification-body">
              <strong>{notification.title}</strong>
              <p>{notification.message}</p>
            </div>
            <button
              className="notification-dismiss"
              type="button"
              aria-label={`Dismiss ${notification.title}`}
              title="Dismiss"
              onClick={() => onDismiss(notification.id)}
            >
              ×
            </button>
          </article>
        ))}
      </div>
    </section>
  );
}

// ---- The rental screen: one row per SIM -----------------------------------
// Modelled on RCUK's own multi-rental table. Fill in a row per SIM, press the
// one button, and every row is checked, activated on RCUK, stamped with its
// rental ID and filed as its own report — a family taking four SIMs is four
// rentals with four return dates, but one customer and one card charge.

const RENTAL_PACKAGES = [
  { value: "V&D", serviceType: "Voice and data" },
  { value: "Voice", serviceType: "Voice" },
  { value: "Data", serviceType: "Data only" },
];

function packageServiceType(value) {
  return RENTAL_PACKAGES.find((entry) => entry.value === value)?.serviceType || "Voice";
}

function emptyRentalRow(defaults = {}) {
  return {
    id: crypto.randomUUID(),
    simNumber: "",
    rentalType: "Daily",
    months: "",
    package: "V&D",
    startDate: "",
    endDate: "",
    ukDays: "",
    euDays: "",
    wtsDays: "",
    tpDays: "",
    ilDdi: false,
    usDdi: false,
    sms: false,
    ref: "",
    // The handset, if one goes out with this SIM.
    rentalPhoneId: "",
    model: "",
    imei: "",
    // Filled in by the activation run.
    rentalId: "",
    cli: "",
    usDdiNumber: "",
    status: "idle", // idle | checking | activating | active | error
    message: "",
    ...defaults,
  };
}

// Days between today and the end of the rental — "Days left" in RCUK's table.
function rentalDaysLeft(endDate) {
  if (!endDate) return "";
  const end = new Date(`${endDate}T00:00:00`);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((end - today) / 86400000);
}

function RentalReportForm({
  activeEmployee,
  activeLocation,
  activeStoreInfo,
  onSaveCustomerName,
  onSaveCustomer,
  rentalPhones = [],
  onSaveRentalPhone,
  onIssueRentalPhone,
  onSave,
}) {
  const [now, setNow] = useState(new Date());
  // Everything every rental in this batch shares.
  const [shared, setShared] = useState({
    rentalRegion: "RCUK",
    customerPhone: "",
    returnDays: "",
    paymentMethod: "",
    returnReminderPreference: "Text message",
    lateFeeWeekly: "",
    notes: "",
  });
  const [rows, setRows] = useState(() => [emptyRentalRow()]);
  const [card, setCard] = useState({ status: "idle", message: "", refNum: "", cardType: "", maskedCardNumber: "" });
  const [run, setRun] = useState({ status: "idle", message: "" });
  const [addPhoneRow, setAddPhoneRow] = useState("");

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 30000);
    return () => window.clearInterval(timer);
  }, []);

  const isRcukRental = shared.rentalRegion === "RCUK";
  const busy = run.status === "running" || card.status === "charging";

  function updateShared(name, value) {
    setShared((current) => ({ ...current, [name]: value }));
    // Changing how they pay invalidates a charge already taken.
    if (name === "paymentMethod") {
      setCard({ status: "idle", message: "", refNum: "", cardType: "", maskedCardNumber: "" });
    }
  }

  function updateRow(id, patch) {
    setRows((current) => current.map((row) => (row.id === id ? { ...row, ...patch } : row)));
  }

  // Editing a row moves the total, so a card charge already taken no longer
  // covers it and has to be run again. Rows that are live on RCUK are read-only:
  // the screen must not say something different from what RCUK activated.
  function editRow(id, patch) {
    updateRow(id, { ...patch, status: "idle", message: "" });
    if (card.status === "paid") {
      setCard({
        status: "idle",
        message: "The rentals changed, so the card has to be charged again.",
        refNum: "",
        cardType: "",
        maskedCardNumber: "",
      });
    }
  }

  function addRow(count = 1) {
    const last = rows[rows.length - 1];
    // A new row inherits the trip from the one above it — people renting
    // together are travelling together.
    const defaults = last
      ? {
        rentalType: last.rentalType,
        months: last.months,
        package: last.package,
        startDate: last.startDate,
        endDate: last.endDate,
        ukDays: last.ukDays,
        euDays: last.euDays,
        wtsDays: last.wtsDays,
        tpDays: last.tpDays,
      }
      : {};
    setRows((current) => [...current, ...Array.from({ length: count }, () => emptyRentalRow(defaults))]);
  }

  function duplicateRow(id) {
    const source = rows.find((row) => row.id === id);
    if (!source) return;
    // Everything but the things that must be unique per rental.
    const copy = emptyRentalRow({
      ...source,
      simNumber: "",
      rentalPhoneId: "",
      model: "",
      imei: "",
      rentalId: "",
      cli: "",
      usDdiNumber: "",
      status: "idle",
      message: "",
    });
    copy.id = crypto.randomUUID();
    setRows((current) => {
      const index = current.findIndex((row) => row.id === id);
      const next = [...current];
      next.splice(index + 1, 0, copy);
      return next;
    });
  }

  function removeRow(id) {
    const row = rows.find((entry) => entry.id === id);
    if (row?.rentalId) {
      window.alert(
        `Rental ${row.rentalId} is already live on RCUK, so it has to be filed. Cancel it on RCUK if it shouldn't exist.`,
      );
      return;
    }
    setRows((current) => (current.length === 1 ? [emptyRentalRow()] : current.filter((entry) => entry.id !== id)));
  }

  // Phones on the shelf, plus any already picked on a row so they don't vanish
  // from their own dropdown.
  const pickedPhoneIds = rows.map((row) => row.rentalPhoneId).filter(Boolean);
  const availableFleetPhones = rentalPhones.filter(
    (phone) => phone.status !== RENTAL_PHONE_WITH_CUSTOMER || pickedPhoneIds.includes(phone.id),
  );

  function selectFleetPhone(rowId, phoneId) {
    const phone = rentalPhones.find((entry) => entry.id === phoneId);
    editRow(rowId, {
      rentalPhoneId: phoneId,
      model: phone?.name || "",
      imei: phone?.imei || "",
    });
  }

  // ---- per-row derived values ---------------------------------------------
  function rowDays(row) {
    return calculateInclusiveDays(row.startDate, row.endDate);
  }

  function rowPricing(row) {
    return calculateRentalPrice(
      { rentalRegion: shared.rentalRegion, serviceType: packageServiceType(row.package), addSms: row.sms },
      rowDays(row),
    );
  }

  function rowZoneDays(row) {
    return numberValue(row.ukDays) + numberValue(row.euDays) + numberValue(row.wtsDays) + numberValue(row.tpDays);
  }

  // What is wrong with a row, in the words of whoever has to fix it. Empty means
  // the row is ready to go to RCUK.
  function rowProblems(row) {
    const days = rowDays(row);
    const problems = [];
    if (!digitsOnly(row.simNumber)) problems.push("a SIM number");
    if (!row.startDate || !row.endDate) problems.push("start and end dates");
    else if (days <= 0) problems.push("an end date on or after the start date");
    if (isRcukRental) {
      if (row.rentalType === "Monthly" && !numberValue(row.months)) problems.push("the number of months");
      if (days > 0 && rowZoneDays(row) !== days) problems.push(`UK + EU + WTS + TP to add up to ${days}`);
      if (days > 0 && days < getMinimumRentalDays(shared.rentalRegion)) {
        problems.push(`at least ${getMinimumRentalDays(shared.rentalRegion)} days`);
      }
    }
    if (rowPricing(row).totalPrice <= 0) problems.push("a price above zero");
    return problems;
  }

  const filledRows = rows.filter((row) => digitsOnly(row.simNumber) || row.rentalId);
  const batchTotal = filledRows.reduce((sum, row) => sum + rowPricing(row).totalPrice, 0);
  const activeRows = rows.filter((row) => row.rentalId);
  const requiresCardCharge = isCardPayment(shared.paymentMethod);

  const sharedProblems = [
    ...(localPhoneDigits(shared.customerPhone).length >= 6 ? [] : ["Enter the customer's phone number."]),
    ...(shared.paymentMethod ? [] : ["Choose a payment method."]),
    ...(String(shared.returnDays).trim() ? [] : ["Enter how many days until the phone comes back."]),
    ...(filledRows.length ? [] : ["Add at least one SIM."]),
  ];
  const rowProblemList = filledRows
    .filter((row) => !row.rentalId)
    .map((row) => ({ row, problems: rowProblems(row) }))
    .filter((entry) => entry.problems.length);
  const readyToRun = !sharedProblems.length && !rowProblemList.length && !busy;

  // ---- talking to RCUK ----------------------------------------------------
  async function postFunction(path, body) {
    const response = await fetch(`${FUNCTIONS_BASE_URL}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    let data = {};
    try {
      data = await response.json();
    } catch {
      data = { message: "The server sent something that wasn't JSON." };
    }
    return { ok: response.ok && data.ok, data };
  }

  function rcukPayloadFor(row) {
    return {
      sim_number: normalizeRcukSimNumber(row.simNumber),
      rental_type: row.rentalType.toLowerCase(),
      no_of_months: numberValue(row.months),
      rental_package: row.package,
      service_type: packageServiceType(row.package),
      start_date: row.startDate,
      end_date: row.endDate,
      uk_days: numberValue(row.ukDays),
      eu_days: numberValue(row.euDays),
      wts_days: numberValue(row.wtsDays),
      tp_days: numberValue(row.tpDays),
      il_ddi: row.ilDdi ? "yes" : "no",
      us_ddi: row.usDdi ? "yes" : "no",
      sms: row.sms ? "yes" : "no",
      customer_phone: shared.customerPhone,
      notes: row.ref || shared.notes,
    };
  }

  // The whole run in one press: check every SIM, take the money, activate every
  // row, file them. Nothing is charged until RCUK agrees every SIM can be
  // rented, and nothing is filed until every row is live — a row that fails
  // keeps its reason on screen and the run can be pressed again once it's fixed.
  async function activateAndFile() {
    if (!readyToRun) return;

    if (!FUNCTIONS_BASE_URL) {
      setRun({ status: "error", message: "Set VITE_FUNCTIONS_BASE_URL before activating rentals." });
      return;
    }

    const pending = rows.filter((row) => digitsOnly(row.simNumber) && !row.rentalId);
    setRun({ status: "running", message: "Checking the SIMs with RCUK..." });

    // 1. Every SIM has to check out before any money moves.
    if (isRcukRental) {
      let simsOk = true;
      for (const row of pending) {
        updateRow(row.id, { status: "checking", message: "Checking with RCUK..." });
        const { ok, data } = await postFunction("/rcukCheckSim", { sim_number: row.simNumber });
        if (ok) {
          updateRow(row.id, { status: "idle", message: data.message || "SIM is free." });
        } else {
          simsOk = false;
          updateRow(row.id, { status: "error", message: data.message || "RCUK turned this SIM down." });
        }
      }
      if (!simsOk) {
        setRun({
          status: "error",
          message: "Some SIMs were turned down. Nothing was charged — fix those rows and run it again.",
        });
        return;
      }
    }

    // 2. The card, once, for the lot.
    if (requiresCardCharge && card.status !== "paid") {
      setRun({ status: "running", message: "Charging the card..." });
      try {
        setCard({ status: "charging", message: "Follow the terminal...", refNum: "", cardType: "", maskedCardNumber: "" });
        const result = await chargeOnLocalTerminal({
          amount: Number(batchTotal).toFixed(2),
          externalRequestId: `rental-${Date.now()}`,
          onStatus: (text) => setCard((current) => ({ ...current, message: text })),
        });
        setCard({
          status: "paid",
          message: result.maskedCardNumber
            ? `Card approved (${result.cardType || "card"} ${result.maskedCardNumber}).`
            : "Card approved.",
          refNum: result.refNum || "",
          cardType: result.cardType || "",
          maskedCardNumber: result.maskedCardNumber || "",
        });
      } catch (error) {
        setCard({ status: "error", message: error.message || "Card payment failed.", refNum: "", cardType: "", maskedCardNumber: "" });
        setRun({ status: "error", message: "The card was declined, so nothing was activated." });
        return;
      }
    }

    // 3. Activate, then ask RCUK for the numbers.
    const activated = [];
    let allOk = true;

    if (isRcukRental) {
      setRun({ status: "running", message: "Activating on RCUK..." });
      for (const row of pending) {
        updateRow(row.id, { status: "activating", message: "Activating on RCUK..." });
        const { ok, data } = await postFunction("/rcukAddRental", rcukPayloadFor(row));
        if (!ok || !data.rentalId) {
          allOk = false;
          updateRow(row.id, { status: "error", message: data.message || "RCUK did not activate this SIM." });
          continue;
        }

        const numbers = await postFunction("/rcukGetRental", { rental_id: data.rentalId });
        const patch = {
          rentalId: data.rentalId,
          cli: numbers.ok ? numbers.data.cli || "" : "",
          usDdiNumber: numbers.ok ? numbers.data.usDdi || "" : "",
          status: "active",
          message: numbers.ok && numbers.data.cli ? "Active." : "Active — numbers still pending.",
        };
        updateRow(row.id, patch);
        activated.push({ ...row, ...patch });
      }
    } else {
      // Israel / Local / Canada rentals are ours alone — nothing to activate.
      pending.forEach((row) => activated.push(row));
    }

    if (!allOk) {
      setRun({
        status: "error",
        message: requiresCardCharge
          ? "Not every SIM activated. The card HAS been charged — fix the rows that failed and run it again. Nothing is filed until they are all live."
          : "Not every SIM activated. Fix the rows that failed and run it again.",
      });
      return;
    }

    // 4. All live — file them.
    setRun({ status: "running", message: "Saving..." });
    fileRentals([...activeRows, ...activated]);
  }

  function fileRentals(entries) {
    if (!entries.length) return;
    const batchId = crypto.randomUUID();
    const createdAt = new Date().toISOString();

    entries.forEach((row) => {
      const days = rowDays(row);
      const pricing = rowPricing(row);
      const report = {
        id: crypto.randomUUID(),
        type: "rental",
        createdAt,
        servedBy: activeEmployee,
        location: activeLocation || "",
        customerPhone: shared.customerPhone.trim(),
        customerPhoneDigits: digitsOnly(shared.customerPhone),
        paymentAmount: String(pricing.totalPrice),
        paymentMethod: shared.paymentMethod,
        notes: [shared.notes.trim(), row.ref.trim()].filter(Boolean).join(" · "),
        details: {
          rentalId: row.rentalId,
          rentalRegion: shared.rentalRegion,
          serviceType: packageServiceType(row.package),
          rcukRentalType: row.rentalType,
          months: numberValue(row.months),
          // "Device" on the receipt: what physically went out with the SIM.
          rentalType: row.rentalPhoneId ? "Phone" : "SIM only",
          model: row.model,
          imei: row.imei,
          rentalPhoneId: row.rentalPhoneId,
          simNumber: normalizeRcukSimNumber(row.simNumber),
          startDate: row.startDate,
          endDate: row.endDate,
          returnTime: `${shared.returnDays || 0} days`,
          returnDueDate: calculateReturnDueDate(row.endDate, shared.returnDays),
          returnReminderPreference: shared.returnReminderPreference,
          lateFeeWeekly: Number.parseFloat(shared.lateFeeWeekly) || 0,
          totalDays: days,
          ukDays: numberValue(row.ukDays),
          euDays: numberValue(row.euDays),
          wtsDays: numberValue(row.wtsDays),
          tpDays: numberValue(row.tpDays),
          addSms: row.sms ? "Yes" : "No",
          usaNumber: row.usDdi ? "Yes" : "No",
          ilNumber: row.ilDdi ? "Yes" : "No",
          cli: row.cli,
          usDdi: row.usDdiNumber,
          rcukActivated: isRcukRental ? (row.rentalId ? "Yes" : "No") : "",
          // Several SIMs rented together: the batch ties the reports (and the
          // single card charge) back to each other.
          rentalBatchId: entries.length > 1 ? batchId : "",
          rentalBatchSize: entries.length > 1 ? entries.length : "",
          dailyRate: pricing.dailyRate,
          totalPrice: pricing.totalPrice,
          calculatedPrice: pricing.totalPrice,
          pricingLabel: pricing.label,
          location: activeLocation || "",
          storeAddress: activeStoreInfo?.address || "",
          storeHours: activeStoreInfo?.hours || "",
          cardStatus: requiresCardCharge ? card.status : "",
          cardRefNum: requiresCardCharge ? card.refNum : "",
          cardType: requiresCardCharge ? card.cardType : "",
          maskedCardNumber: requiresCardCharge ? card.maskedCardNumber : "",
          batchChargeTotal: entries.length > 1 ? batchTotal : "",
        },
      };

      onSave(report);
      // The handset is now out with the customer — flag it so the fleet list and
      // the next rental both know it isn't on the shelf.
      if (row.rentalPhoneId && onIssueRentalPhone) {
        onIssueRentalPhone(row.rentalPhoneId, { reportId: report.id, customerPhone: shared.customerPhone });
      }
      printRentalReceipt(report);
    });
  }

  const zoneFields = ["ukDays", "euDays", "wtsDays", "tpDays"];
  const flagFields = [["ilDdi", "IL DDI"], ["usDdi", "US DDI"], ["sms", "SMS"]];

  return (
    <section className="workspace">
      <div className="workspace-header">
        <div>
          <p className="eyebrow">New customer report</p>
          <h2>Phone rental</h2>
        </div>
        <div className="clock-pill">{formatDateTime(now)}</div>
      </div>

      <div className="form-grid">
        <label className="field">
          <span>Rental region</span>
          <select
            value={shared.rentalRegion}
            onChange={(event) => updateShared("rentalRegion", event.target.value)}
            disabled={Boolean(activeRows.length)}
          >
            <option>RCUK</option>
            <option>Canada</option>
            <option>Israel</option>
            <option>Local</option>
          </select>
        </label>
        <label className="field">
          <span>Customer phone</span>
          <CustomerPhoneInput
            value={shared.customerPhone}
            onChange={(value) => updateShared("customerPhone", value)}
            onSaveCustomerName={onSaveCustomerName}
            onSaveCustomer={onSaveCustomer}
            onSelectCustomer={(customer) => updateShared("customerPhone", customer.phone)}
            required
          />
        </label>
        <label className="field">
          <span>Days until return</span>
          <input inputMode="numeric" value={shared.returnDays} onChange={(event) => updateShared("returnDays", event.target.value)} />
        </label>
        <label className="field">
          <span>Payment method</span>
          <select value={shared.paymentMethod} onChange={(event) => updateShared("paymentMethod", event.target.value)}>
            <option value="" disabled>Select one</option>
            {paymentMethods.map((method) => <option key={method}>{method}</option>)}
          </select>
        </label>
        <label className="field">
          <span>Return reminder</span>
          <select value={shared.returnReminderPreference} onChange={(event) => updateShared("returnReminderPreference", event.target.value)}>
            <option>Text message</option>
            <option>Phone call</option>
            <option>Both</option>
          </select>
        </label>
        <label className="field">
          <span>Late fee per week (if overdue)</span>
          <input
            inputMode="decimal"
            value={shared.lateFeeWeekly}
            onChange={(event) => updateShared("lateFeeWeekly", event.target.value)}
            placeholder="0.00"
          />
          {(Number.parseFloat(shared.lateFeeWeekly) || 0) > 0 ? (
            <small className="muted">{formatMoney((Number.parseFloat(shared.lateFeeWeekly) || 0) / 7)}/day after the return date</small>
          ) : null}
        </label>
        <label className="field">
          <span>Served by</span>
          <input value={activeEmployee} disabled readOnly />
        </label>
      </div>

      <div className="rental-rows-wrap">
        <table className="rental-rows">
          <thead>
            <tr>
              <th className="rental-col-sim">SIM</th>
              <th>Rental type</th>
              <th>Months</th>
              <th>Package</th>
              <th>Start date</th>
              <th>End date</th>
              <th>Total days</th>
              <th>Days left</th>
              <th>UK</th>
              <th>EU</th>
              <th>WTS</th>
              <th>TP</th>
              <th>IL DDI</th>
              <th>US DDI</th>
              <th>SMS</th>
              <th>Phone issued</th>
              <th>Ref / notes</th>
              <th>Price</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const days = rowDays(row);
              const left = rentalDaysLeft(row.endDate);
              const locked = Boolean(row.rentalId);
              const zoneOff = isRcukRental && days > 0 && rowZoneDays(row) !== days;
              return (
                <tr
                  key={row.id}
                  className={locked ? "rental-row-active" : row.status === "error" ? "rental-row-error" : ""}
                >
                  <td className="rental-col-sim">
                    <input
                      value={row.simNumber}
                      onChange={(event) => editRow(row.id, { simNumber: event.target.value })}
                      placeholder="Scan SIM"
                      inputMode="numeric"
                      autoComplete="off"
                      spellCheck={false}
                      readOnly={locked}
                    />
                    {row.rentalId ? (
                      <span className="rental-row-id">
                        Rental {row.rentalId}
                        {row.cli ? ` · ${row.cli}` : ""}
                        {row.usDdiNumber ? ` · US ${row.usDdiNumber}` : ""}
                      </span>
                    ) : null}
                    {row.message ? (
                      <span className={row.status === "error" ? "rental-row-msg error" : "rental-row-msg"}>{row.message}</span>
                    ) : null}
                  </td>
                  <td>
                    <select value={row.rentalType} onChange={(event) => editRow(row.id, { rentalType: event.target.value })} disabled={locked}>
                      <option>Daily</option>
                      <option>Monthly</option>
                    </select>
                  </td>
                  <td>
                    <input
                      className="rental-cell-num"
                      inputMode="numeric"
                      value={row.months}
                      onChange={(event) => editRow(row.id, { months: event.target.value })}
                      disabled={locked || row.rentalType !== "Monthly"}
                    />
                  </td>
                  <td>
                    <select value={row.package} onChange={(event) => editRow(row.id, { package: event.target.value })} disabled={locked}>
                      {RENTAL_PACKAGES.map((entry) => <option key={entry.value}>{entry.value}</option>)}
                    </select>
                  </td>
                  <td>
                    <input type="date" value={row.startDate} onChange={(event) => editRow(row.id, { startDate: event.target.value })} readOnly={locked} />
                  </td>
                  <td>
                    <input type="date" value={row.endDate} onChange={(event) => editRow(row.id, { endDate: event.target.value })} readOnly={locked} />
                  </td>
                  <td className="rental-cell-computed">{days || "-"}</td>
                  <td className="rental-cell-computed">{left === "" ? "-" : left}</td>
                  {zoneFields.map((zone) => (
                    <td key={zone}>
                      <input
                        className={`rental-cell-num ${zoneOff ? "input-invalid" : ""}`}
                        inputMode="numeric"
                        value={row[zone]}
                        onChange={(event) => editRow(row.id, { [zone]: event.target.value })}
                        disabled={locked || !isRcukRental}
                      />
                    </td>
                  ))}
                  {flagFields.map(([flag, label]) => (
                    <td key={flag} className="rental-cell-check">
                      <input
                        type="checkbox"
                        checked={row[flag]}
                        onChange={(event) => editRow(row.id, { [flag]: event.target.checked })}
                        disabled={locked || !isRcukRental}
                        aria-label={label}
                      />
                    </td>
                  ))}
                  <td>
                    <select
                      value={row.rentalPhoneId}
                      onChange={(event) => {
                        const value = event.target.value;
                        if (value === "__add__") { setAddPhoneRow(row.id); return; }
                        selectFleetPhone(row.id, value);
                      }}
                      disabled={locked}
                    >
                      <option value="">SIM only</option>
                      {availableFleetPhones.map((phone) => (
                        <option key={phone.id} value={phone.id}>{phone.name} · {phone.imei}</option>
                      ))}
                      <option value="__add__">+ Add a phone…</option>
                    </select>
                  </td>
                  <td>
                    <input value={row.ref} onChange={(event) => editRow(row.id, { ref: event.target.value })} readOnly={locked} />
                  </td>
                  <td className="rental-cell-computed">{formatMoney(rowPricing(row).totalPrice)}</td>
                  <td className="rental-cell-actions">
                    <button type="button" className="ghost-button compact-button" onClick={() => duplicateRow(row.id)} title="Duplicate this row">
                      Copy
                    </button>
                    <button type="button" className="dialog-close" onClick={() => removeRow(row.id)} aria-label="Remove this row" title="Remove this row">
                      &times;
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="rental-row-actions">
        <button type="button" className="ghost-button" onClick={() => addRow(1)} disabled={busy}>+ Add row</button>
        <button
          type="button"
          className="ghost-button"
          disabled={busy}
          onClick={() => {
            const answer = window.prompt("How many more rows?", "3");
            const count = Math.min(20, Math.max(0, Number.parseInt(answer || "", 10) || 0));
            if (count) addRow(count);
          }}
        >
          + Add multiple rows
        </button>
      </div>

      <label className="field full">
        <span>Notes (all of these rentals)</span>
        <textarea value={shared.notes} onChange={(event) => updateShared("notes", event.target.value)} rows="3" />
      </label>

      <div className="rental-run">
        <div className="rental-run-total">
          <span>{filledRows.length} rental{filledRows.length === 1 ? "" : "s"}</span>
          <strong>{formatMoney(batchTotal)}</strong>
        </div>

        {sharedProblems.length || rowProblemList.length ? (
          <div className="summary-error">
            <strong>Before activating:</strong>
            <ul className="blocker-list">
              {sharedProblems.map((problem) => <li key={problem}>{problem}</li>)}
              {rowProblemList.map(({ row, problems }) => (
                <li key={row.id}>
                  SIM {digitsOnly(row.simNumber).slice(-6) || "(blank)"} needs {problems.join(", ")}.
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {card.message ? <p className={card.status === "error" ? "summary-error" : "muted"}>{card.message}</p> : null}
        {run.message ? <p className={run.status === "error" ? "summary-error" : "muted"}>{run.message}</p> : null}

        <button className="primary-button rental-run-button" type="button" onClick={activateAndFile} disabled={!readyToRun}>
          {busy
            ? (card.status === "charging" ? "Follow the terminal…" : "Working…")
            : requiresCardCharge && card.status !== "paid"
              ? `Charge ${formatMoney(batchTotal)} · activate & save`
              : `Activate & save ${filledRows.length} rental${filledRows.length === 1 ? "" : "s"}`}
        </button>
        <p className="muted">
          {isRcukRental
            ? `Every SIM is checked with RCUK first${requiresCardCharge ? ", then the card is charged once for the lot" : ""}, then each row is activated, stamped with its rental ID and filed as its own report.`
            : "Each row is filed as its own rental report."}
        </p>
      </div>

      {addPhoneRow ? (
        <AddRentalPhoneDialog
          existingPhones={rentalPhones}
          onClose={() => setAddPhoneRow("")}
          onAdd={(phone) => {
            const saved = onSaveRentalPhone?.(phone);
            if (saved) selectFleetPhone(addPhoneRow, saved.id);
            setAddPhoneRow("");
          }}
        />
      ) : null}
    </section>
  );
}

// Register a handset into the rental fleet without leaving the rental form —
// scan the IMEI, name it, and it's immediately selectable as the phone issued.
// A barcode / IMEI scanner types the code and then sends Enter. In a plain
// <form> that Enter means "submit", so scanning the IMEI at repair intake saved
// the ticket before the rest of the details were filled in — and scanning a
// barcode into the product form added the product. Enter inside a single-line
// field no longer submits; the Save button (or Enter while it is focused, which
// arrives as a click on the button) still does. Textareas keep their newline.
function preventEnterSubmit(event) {
  if (event.key !== "Enter") return;
  const target = event.target;
  if (target instanceof HTMLInputElement && target.type !== "submit" && target.type !== "button") {
    event.preventDefault();
  }
}

// Every popup closes the same way: an X in its top-right corner. Several of
// these cards scroll (a long form, a receipt), so the header it sits in is
// pinned — see `.dialog-head` in the stylesheet — and the way out never
// scrolls off with the content.
function DialogCloseButton({ onClose, label = "Close" }) {
  return (
    <button className="dialog-close" type="button" aria-label={label} title={label} onClick={onClose}>
      &times;
    </button>
  );
}

function AddRentalPhoneDialog({ existingPhones = [], onAdd, onClose }) {
  const [name, setName] = useState("");
  const [imei, setImei] = useState("");
  const [error, setError] = useState("");

  function submit(event) {
    event.preventDefault();
    const cleanImei = digitsOnly(imei);
    if (!cleanImei) { setError("Scan or type the phone's IMEI."); return; }
    if (!name.trim()) { setError("Give the phone a name so staff can recognise it."); return; }
    if (existingPhones.some((phone) => digitsOnly(phone.imei) === cleanImei)) {
      setError("That IMEI is already in the fleet.");
      return;
    }
    onAdd({ name: name.trim(), imei: cleanImei });
  }

  return createPortal(
    <div className="dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <div className="dialog-card" role="dialog" aria-modal="true" onMouseDown={(event) => event.stopPropagation()}>
        <div className="dialog-head">
          <div>
            <p className="eyebrow">Rental fleet</p>
            <h3>Add a phone</h3>
          </div>
          <DialogCloseButton onClose={onClose} label="Close add a phone" />
        </div>
        <form className="form-grid dialog-form" onSubmit={submit}>
          <label className="field full">
            <span>IMEI</span>
            <input
              value={imei}
              onChange={(event) => { setImei(event.target.value); setError(""); }}
              inputMode="numeric"
              autoComplete="off"
              spellCheck={false}
              placeholder="Scan the IMEI"
              autoFocus
            />
          </label>
          <label className="field full">
            <span>Phone name</span>
            <input
              value={name}
              onChange={(event) => { setName(event.target.value); setError(""); }}
              placeholder="e.g. Nokia 105 — blue"
            />
          </label>
          {error ? <p className="summary-error full">{error}</p> : null}
          <div className="pos-form-actions form-actions-row">
            <button className="primary-button" type="submit">Add to fleet</button>
            <button className="secondary-button" type="button" onClick={onClose}>Cancel</button>
          </div>
        </form>
      </div>
    </div>,
    document.body,
  );
}

function ReportHistory({
  employees,
  activeEmployee,
  storeLocations,
  reports,
  filters,
  onFiltersChange,
  onClearFilters,
  onStatusChange,
  onUpdateReport,
  onExport,
  onExportAll,
  onClearReports,
  onDeleteReport,
  onReturn,
  onScanReturn,
  notifications,
}) {
  const hasActions = Boolean(onDeleteReport || onReturn);
  const columnCount = hasActions ? 9 : 8;
  const [returnScan, setReturnScan] = useState("");
  // Show the log in pages of 20; "See more" reveals another 20. Reset whenever
  // the filters change so a new search starts from the top.
  const PAGE_SIZE = 20;
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  useEffect(() => setVisibleCount(PAGE_SIZE), [filters]);

  function handleReturnScan(event) {
    event.preventDefault();
    const code = returnScan.trim();
    if (!code) return;
    onScanReturn?.(code);
    setReturnScan("");
  }

  function confirmExport(callback) {
    const confirmed = window.confirm(
      "Exporting too often may incur extra charges. Continue with this export?",
    );
    if (!confirmed) return;
    callback?.();
  }

  const MAX_RANGE_DAYS = 30;
  const hasRange = Boolean(filters.dateFrom && filters.dateTo);
  const rangeDays = hasRange ? calculateInclusiveDays(filters.dateFrom, filters.dateTo) : 0;
  const rangeTooLong = rangeDays > MAX_RANGE_DAYS;
  const rangeReversed = hasRange && rangeDays === 0;
  const rangeValid = hasRange && !rangeTooLong && !rangeReversed;
  const maxToDate = filters.dateFrom
    ? calculateReturnDueDate(filters.dateFrom, MAX_RANGE_DAYS - 1)
    : "";
  const totals = reports.reduce(
    (acc, report) => {
      acc.count += 1;
      acc.amount += Number.parseFloat(report.paymentAmount || "0") || 0;
      acc[report.type] += 1;
      return acc;
    },
        { count: 0, amount: 0, call: 0, sale: 0, repair: 0, sim: 0, rental: 0, phoneOrder: 0, return: 0 },
  );

  function updateFilter(name, value) {
    onFiltersChange((current) => ({ ...current, [name]: value }));
  }

  return (
    <section className="history">
      <div className="history-header">
        <div>
          <p className="eyebrow">Store log</p>
          <h2>Reports</h2>
        </div>
        <div className="history-actions">
          {onScanReturn ? (
            <form className="scan-return" onSubmit={handleReturnScan}>
              <input
                value={returnScan}
                onChange={(event) => setReturnScan(event.target.value)}
                placeholder="Scan receipt to return"
                inputMode="text"
                autoComplete="off"
                spellCheck={false}
              />
              <button className="secondary-button" type="submit">Return</button>
            </form>
          ) : null}
          <button className="secondary-button" type="button" onClick={() => confirmExport(onExport)} disabled={!rangeValid}>Export view (CSV)</button>
          {onExportAll ? (
            <button className="secondary-button" type="button" onClick={() => confirmExport(onExportAll)}>Export all (CSV)</button>
          ) : null}
          {onClearReports ? (
            <button className="danger-button" type="button" onClick={onClearReports}>Clear local data</button>
          ) : null}
        </div>
      </div>

      <div className="filters">
        <label className="field">
          <span>Fast search</span>
          <input
            value={filters.query}
            onChange={(event) => updateFilter("query", event.target.value)}
            placeholder="Phone, IMEI, model, carrier, employee, notes"
          />
        </label>
        <label className="field">
          <span>Type</span>
          <select value={filters.type} onChange={(event) => updateFilter("type", event.target.value)}>
            <option value="all">All</option>
            <option value="call">Phone calls</option>
            <option value="sale">Sales</option>
            <option value="repair">Repairs</option>
            <option value="sim">SIM activations</option>
            <option value="rental">Phone rentals</option>
            <option value="phoneOrder">Phone orders</option>
            <option value="return">Returns</option>
          </select>
        </label>
        <label className="field">
          <span>Status</span>
          <select value={filters.status} onChange={(event) => updateFilter("status", event.target.value)}>
            <option value="all">All statuses</option>
            {repairStatuses.map((status) => (
              <option value={status} key={status}>{status}</option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Employee</span>
          <select value={filters.employee} onChange={(event) => updateFilter("employee", event.target.value)}>
            <option value="all">All employees</option>
            {employees.map((employee) => (
              <option value={employee} key={employee}>{employee}</option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Payment</span>
          <select value={filters.paymentMethod} onChange={(event) => updateFilter("paymentMethod", event.target.value)}>
            <option value="all">All methods</option>
            {paymentMethods.map((method) => (
              <option value={method} key={method}>{method}</option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Store</span>
          <select value={filters.location} onChange={(event) => updateFilter("location", event.target.value)}>
            <option value="all">All stores</option>
            {(storeLocations || []).map((location) => (
              <option value={location} key={location}>{location}</option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Item / model</span>
          <input
            value={filters.item}
            onChange={(event) => updateFilter("item", event.target.value)}
            placeholder="Model, item, SKU, IMEI"
          />
        </label>
        <label className="field">
          <span>Customer name</span>
          <input
            value={filters.customerName}
            onChange={(event) => updateFilter("customerName", event.target.value)}
            placeholder="Customer or caller name"
          />
        </label>
        <label className="field">
          <span>From date</span>
          <input type="date" value={filters.dateFrom} max={filters.dateTo || undefined} onChange={(event) => updateFilter("dateFrom", event.target.value)} required />
        </label>
        <label className="field">
          <span>To date (max 30 days)</span>
          <input type="date" value={filters.dateTo} min={filters.dateFrom || undefined} max={maxToDate || undefined} onChange={(event) => updateFilter("dateTo", event.target.value)} required />
        </label>
        <label className="field">
          <span>Min paid</span>
          <input inputMode="decimal" value={filters.amountMin} onChange={(event) => updateFilter("amountMin", event.target.value)} placeholder="0" />
        </label>
        <label className="field">
          <span>Max paid</span>
          <input inputMode="decimal" value={filters.amountMax} onChange={(event) => updateFilter("amountMax", event.target.value)} placeholder="500" />
        </label>
        <button className="secondary-button align-end" type="button" onClick={onClearFilters}>
          Clear filters
        </button>
      </div>

      {rangeValid ? (
      <>
      <div className="summary-strip">
        <span className="metric">Reports <strong>{totals.count}</strong></span>
        <span className="metric">Payments <strong>{formatMoney(totals.amount)}</strong></span>
        <span className="metric">Calls <strong>{totals.call}</strong></span>
        <span className="metric">Sales <strong>{totals.sale}</strong></span>
        <span className="metric">Repairs <strong>{totals.repair}</strong></span>
        <span className="metric">SIM <strong>{totals.sim}</strong></span>
        <span className="metric">Rentals <strong>{totals.rental}</strong></span>
        <span className="metric">Orders <strong>{totals.phoneOrder}</strong></span>
        <span className="metric">Returns <strong>{totals.return}</strong></span>
        <span className="metric">Queued notices <strong>{notifications.length}</strong></span>
      </div>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Date</th>
              <th>Type</th>
              <th>Customer</th>
              <th>Details</th>
              <th>Paid</th>
              <th>Method</th>
              <th>Served by</th>
              <th>Status</th>
              {hasActions ? <th></th> : null}
            </tr>
          </thead>
          <tbody>
            {reports.length ? (
              reports.slice(0, visibleCount).map((report) => (
                <ReportRow
                  report={report}
                  key={report.id}
                  onStatusChange={onStatusChange}
                  onUpdateReport={onUpdateReport}
                  onDeleteReport={onDeleteReport}
                  onReturn={onReturn}
                  activeEmployee={activeEmployee}
                  hasActions={hasActions}
                />
              ))
            ) : (
              <tr>
                <td colSpan={columnCount} className="empty-state">No reports match this view.</td>
              </tr>
            )}
          </tbody>
        </table>
        {reports.length > visibleCount ? (
          <div className="see-more-row">
            <span className="muted">Showing {visibleCount} of {reports.length}</span>
            <button className="secondary-button" type="button" onClick={() => setVisibleCount((count) => count + PAGE_SIZE)}>
              See more ({Math.min(PAGE_SIZE, reports.length - visibleCount)})
            </button>
          </div>
        ) : null}
      </div>
      </>
      ) : (
        <p className="empty-state">
          {rangeReversed
            ? "The from date is after the to date."
            : rangeTooLong
              ? `Pick a range of ${MAX_RANGE_DAYS} days or fewer (you selected ${rangeDays} days), or use Export all (CSV) for the full history.`
              : "Select a date range (max 30 days) to view reports. Use Export all (CSV) to download the full history."}
        </p>
      )}
      {notifications.length ? (
        <div className="notification-panel">
          <div>
            <p className="eyebrow">Delivery notifications</p>
            <h3>Queued text / call requests</h3>
          </div>
          {notifications.slice(0, 3).map((notice) => (
            <div className="notice-row" key={notice.id}>
              <span>{notice.method} to {notice.customerPhone}</span>
              <span className="muted">{notice.status}</span>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function OpenRepairsPage({ reports, employees = [], storeTax = [], activeTaxRate = 0, onStatusChange, onSetReady, onMarkPaid, onEditRepair }) {
  const [paying, setPaying] = useState({ id: "", status: "", message: "" });
  // When set, the take-payment dialog is open for this repair.
  const [payPrompt, setPayPrompt] = useState(null);
  // When set, the final-price dialog is open for this repair before it goes Ready.
  const [finalPrompt, setFinalPrompt] = useState(null);
  // When set, the edit dialog is open for this repair.
  const [editing, setEditing] = useState(null);
  // Free-text search across ticket #, customer name/phone, date, and store.
  const [search, setSearch] = useState("");
  const allOpenRepairs = reports.filter((report) =>
    report.type === "repair" && !["Completed", "Cancelled"].includes(report.details?.status),
  );

  function taxRateFor(repair) {
    const name = repair?.location || repair?.details?.location || "";
    const match = (storeTax || []).find((entry) => entry?.name === name);
    return Number(match?.rate) || Number(activeTaxRate) || 0;
  }

  const query = search.trim().toLowerCase();
  const openRepairs = query
    ? allOpenRepairs.filter((repair) => {
        const haystack = [
          repair.details?.ticketNumber,
          repair.details?.customerName,
          repair.customerPhone,
          repair.location,
          shortStoreName(repair.location),
          repair.details?.technician,
          formatShortDate(repair.createdAt),
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        return haystack.includes(query);
      })
    : allOpenRepairs;

  // Marking a repair "Ready" requires the final price. Open the dialog first (any
  // other status change just persists). The estimate pre-fills the dialog.
  function handleStatusChange(repair, status) {
    if (status === "Ready" && repair.details?.status !== "Ready") {
      setFinalPrompt({
        id: repair.id,
        ticket: repair.details?.ticketNumber || "",
        value: repair.details?.finalPrice || repair.details?.estimatedPrice || repair.paymentAmount || "",
      });
      return;
    }
    onStatusChange(repair.id, status);
  }

  function confirmFinalPrice() {
    if (!finalPrompt) return;
    onSetReady(finalPrompt.id, finalPrompt.value);
    setFinalPrompt(null);
  }

  // Open the take-payment dialog for a repair. Everything the cashier needs to
  // collect money lives in that one dialog — the amount and the method the
  // customer is actually paying with, which is often not what was guessed at
  // intake — so no one has to go and edit the ticket first.
  function openPayment(repair) {
    if (repair.details?.paymentStatus === "Paid") return;
    setPaying({ id: "", status: "", message: "" });
    setPayPrompt(repair);
  }

  // Take the payment. For card payments, run the charge on the local terminal
  // first and only mark paid once the card is approved. The "paid" SMS to the
  // customer is sent by the notifyRepairPaid Cloud Function on the status change.
  async function confirmPayment({ amount, method, manualEntry, taxRate, taxAmount }) {
    const repair = payPrompt;
    if (!repair || repair.details?.paymentStatus === "Paid") {
      setPayPrompt(null);
      return;
    }

    const value = Number.parseFloat(amount);
    if (!Number.isFinite(value) || value <= 0) {
      setPaying({ id: repair.id, status: "error", message: "Enter the amount the customer is paying." });
      return;
    }
    if (!method) {
      setPaying({ id: repair.id, status: "error", message: "Pick how the customer is paying." });
      return;
    }

    // Record what was actually collected before marking paid, so the ticket and
    // the reports show the real amount and method instead of the intake guess.
    // paymentAmount is what the customer hands over — the repair price plus the
    // sales tax — with the split kept in details for the paperwork.
    const tax = Math.max(0, Number(taxAmount) || 0);
    const paidAmount = (value + tax).toFixed(2);
    onEditRepair(repair.id, {
      paymentAmount: paidAmount,
      paymentMethod: method,
      details: {
        subtotal: value.toFixed(2),
        taxRate: tax > 0 ? Number(taxRate) || 0 : 0,
        taxAmount: tax.toFixed(2),
      },
    });

    if (!isCardPayment(method)) {
      onMarkPaid(repair.id);
      setPaying({ id: "", status: "", message: "" });
      setPayPrompt(null);
      return;
    }

    try {
      setPaying({ id: repair.id, status: "charging", message: manualEntry ? "Follow the terminal: key in the card by hand." : "Follow the terminal: tap, insert, or swipe the card." });
      const result = await chargeOnLocalTerminal({
        amount: paidAmount,
        externalRequestId: `repair-${repair.id}`.slice(0, 32),
        manualEntry,
        onStatus: (text) => setPaying((current) => ({ ...current, message: text })),
      });
      onMarkPaid(repair.id, {
        paymentRefNum: result.refNum || "",
        cardType: result.cardType || "",
        maskedCardNumber: result.maskedCardNumber || "",
      });
      setPaying({ id: "", status: "", message: "" });
      setPayPrompt(null);
    } catch (error) {
      setPaying({ id: repair.id, status: "error", message: error.message || "Card payment failed." });
    }
  }

  return (
    <section className="history">
      <div className="history-header">
        <div>
          <p className="eyebrow">Repair queue</p>
          <h2>Open repairs</h2>
        </div>
        <input
          className="pos-search"
          type="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search ticket, name, date, store…"
          aria-label="Search repairs"
        />
        <span className="metric">Open <strong>{openRepairs.length}</strong></span>
      </div>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Ticket</th>
              <th>Date</th>
              <th>Store</th>
              <th>Customer</th>
              <th>Phone</th>
              <th>Damage</th>
              <th>Payment</th>
              <th>Technician</th>
              <th>Served by</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {openRepairs.length ? (
              openRepairs.map((repair) => {
                const isPaid = repair.details?.paymentStatus === "Paid";
                const isCharging = paying.id === repair.id && paying.status === "charging";
                return (
                  <tr key={repair.id}>
                    <td>
                      <strong>{repair.details?.ticketNumber || "-"}</strong>
                      {repair.details?.originalTicket ? (
                        <div className="muted">↩ follow-up of #{repair.details.originalTicket}</div>
                      ) : null}
                    </td>
                    <td>{formatShortDate(repair.createdAt)}</td>
                    <td>{shortStoreName(repair.location || repair.details?.location) || "-"}</td>
                    <td>
                      <div>{repair.details?.customerName || repair.customerPhone || "-"}</div>
                      {repair.details?.customerName && repair.customerPhone ? (
                        <div className="muted">{repair.customerPhone}</div>
                      ) : null}
                    </td>
                    <td>{repair.details?.model || "-"}</td>
                    <td>{repair.details?.damage || "-"}</td>
                    <td>
                      <div>{formatPayment(repair.paymentAmount)} · {isPaid ? "Paid" : "Not paid"}{repair.paymentMethod ? ` · ${repair.paymentMethod}` : ""}</div>
                      <div className="muted">
                        {repair.details?.finalPrice
                          ? `Final ${formatPayment(repair.details.finalPrice)}`
                          : `Est. ${formatPayment(repair.details?.estimatedPrice || repair.paymentAmount)}`}
                      </div>
                      {isPaid ? null : (
                        <div className="pos-row-actions">
                          <button
                            className="primary-button compact-button"
                            type="button"
                            disabled={isCharging}
                            onClick={() => openPayment(repair)}
                          >
                            {isCharging ? "Charging…" : "Take payment"}
                          </button>
                        </div>
                      )}
                      {!payPrompt && paying.id === repair.id && paying.message ? (
                        <p className={paying.status === "error" ? "summary-error" : "muted"}>{paying.message}</p>
                      ) : null}
                    </td>
                    <td>
                      <select
                        className="status-select"
                        value={repair.details?.technician || ""}
                        onChange={(event) => onEditRepair(repair.id, { details: { technician: event.target.value } })}
                      >
                        <option value="">Unassigned</option>
                        {employees.map((employee) => (
                          <option key={employee}>{employee}</option>
                        ))}
                        {repair.details?.technician && !employees.includes(repair.details.technician) ? (
                          <option value={repair.details.technician}>{repair.details.technician}</option>
                        ) : null}
                      </select>
                    </td>
                    <td>{repair.servedBy || "-"}</td>
                    <td>
                      <select
                        className="status-select"
                        value={repair.details?.status || repairStatuses[0]}
                        onChange={(event) => handleStatusChange(repair, event.target.value)}
                      >
                        {repairStatuses.map((status) => (
                          <option key={status}>{status}</option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <button className="secondary-button compact-button" type="button" onClick={() => setEditing(repair)}>
                        Edit
                      </button>
                    </td>
                  </tr>
                );
              })
            ) : (
              <tr>
                <td colSpan="11" className="empty-state">
                  {query ? "No repairs match your search." : "No open repairs."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {payPrompt ? (
        <RepairPaymentDialog
          repair={payPrompt}
          taxRate={taxRateFor(payPrompt)}
          paying={paying}
          onConfirm={confirmPayment}
          onClose={() => {
            setPayPrompt(null);
            setPaying({ id: "", status: "", message: "" });
          }}
        />
      ) : null}

      {finalPrompt ? (
        <FinalPriceDialog
          prompt={finalPrompt}
          onChange={(value) => setFinalPrompt((current) => ({ ...current, value }))}
          onConfirm={confirmFinalPrice}
          onClose={() => setFinalPrompt(null)}
        />
      ) : null}

      {editing ? (
        <EditRepairDialog
          repair={editing}
          employees={employees}
          onSave={(patch) => {
            onEditRepair(editing.id, patch);
            setEditing(null);
          }}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </section>
  );
}

function EditRepairDialog({ repair, employees = [], onSave, onClose }) {
  const details = repair.details || {};
  const [form, setForm] = useState({
    model: details.model || "",
    damage: details.damage || "",
    imei: details.imei || "",
    devicePin: details.devicePin || "",
    estimatedPrice: details.estimatedPrice || repair.paymentAmount || "",
    finalPrice: details.finalPrice || "",
    dueDate: details.dueDate || "",
    notificationPreference: details.notificationPreference || "Text message",
    paymentMethod: repair.paymentMethod || "",
    customerPhone: repair.customerPhone || "",
    technician: details.technician || "",
    originalTicket: details.originalTicket || "",
    notes: repair.notes || "",
  });
  // Extra jobs found on the same handset after intake, each priced on its own.
  const [extraFixes, setExtraFixes] = useState(() =>
    (details.additionalFixes || []).map((fix) => ({
      description: fix?.description || "",
      price: fix?.price || "",
    })),
  );

  const set = (name, value) => setForm((current) => ({ ...current, [name]: value }));

  function setFix(index, patch) {
    setExtraFixes((current) => current.map((fix, i) => (i === index ? { ...fix, ...patch } : fix)));
  }

  const cleanFixes = extraFixes
    .map((fix) => ({ description: fix.description.trim(), price: String(fix.price ?? "").trim() }))
    .filter((fix) => fix.description || fix.price);
  // What every job on the ticket adds up to, so the tech can see the number
  // before deciding what to put in Final price.
  const fixesTotal = cleanFixes.reduce((sum, fix) => sum + (Number(fix.price) || 0), 0);
  const basePrice = Number(form.finalPrice || form.estimatedPrice) || 0;
  const combinedTotal = basePrice + fixesTotal;

  function submit(event) {
    event.preventDefault();
    event.stopPropagation();
    // Final price, once set, is the amount owed — mirror it to paymentAmount.
    const amount = String(form.finalPrice ?? "").trim() || String(form.estimatedPrice ?? "").trim();
    onSave({
      customerPhone: form.customerPhone.trim(),
      paymentMethod: form.paymentMethod,
      paymentAmount: amount,
      notes: form.notes.trim(),
      details: {
        model: form.model.trim(),
        damage: form.damage.trim(),
        imei: form.imei.trim(),
        devicePin: form.devicePin.trim(),
        estimatedPrice: String(form.estimatedPrice ?? "").trim(),
        finalPrice: String(form.finalPrice ?? "").trim(),
        dueDate: form.dueDate,
        notificationPreference: form.notificationPreference,
        technician: form.technician.trim(),
        originalTicket: String(form.originalTicket ?? "").trim(),
        additionalFixes: cleanFixes,
      },
    });
  }

  return createPortal(
    <div className="dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <div className="dialog-card dialog-card-wide" role="dialog" aria-modal="true" onMouseDown={(event) => event.stopPropagation()}>
        <div className="dialog-head">
          <h2>Edit repair {details.ticketNumber ? `#${details.ticketNumber}` : ""}</h2>
          <DialogCloseButton onClose={onClose} label="Close edit repair" />
        </div>
        <form className="form-grid" onSubmit={submit} onKeyDown={preventEnterSubmit}>
          <label className="field"><span>Phone model</span><input value={form.model} onChange={(event) => set("model", event.target.value)} autoFocus /></label>
          <label className="field"><span>What is damaged?</span><input value={form.damage} onChange={(event) => set("damage", event.target.value)} /></label>
          <label className="field"><span>Phone IMEI</span><input value={form.imei} inputMode="numeric" onChange={(event) => set("imei", event.target.value)} /></label>
          <label className="field">
            <span>Phone PIN / passcode</span>
            <input
              value={form.devicePin}
              placeholder="Prints on the phone label only"
              autoComplete="off"
              onChange={(event) => set("devicePin", event.target.value)}
            />
          </label>
          <label className="field"><span>Customer phone</span><input value={form.customerPhone} inputMode="tel" onChange={(event) => set("customerPhone", event.target.value)} /></label>
          <label className="field"><span>Estimated price</span><input value={form.estimatedPrice} inputMode="decimal" placeholder="0.00" onChange={(event) => set("estimatedPrice", event.target.value)} /></label>
          <label className="field"><span>Final price</span><input value={form.finalPrice} inputMode="decimal" placeholder="0.00" onChange={(event) => set("finalPrice", event.target.value)} /></label>
          <label className="field"><span>Expected ready date</span><input type="date" value={form.dueDate} onChange={(event) => set("dueDate", event.target.value)} /></label>
          <label className="field">
            <span>Repair technician</span>
            <select value={form.technician} onChange={(event) => set("technician", event.target.value)}>
              <option value="">Unassigned</option>
              {employees.map((employee) => <option key={employee}>{employee}</option>)}
              {form.technician && !employees.includes(form.technician) ? (
                <option value={form.technician}>{form.technician}</option>
              ) : null}
            </select>
          </label>
          <label className="field"><span>Follow-up of ticket #</span><input value={form.originalTicket} inputMode="numeric" placeholder="Original ticket, if returned" onChange={(event) => set("originalTicket", event.target.value)} /></label>
          <label className="field">
            <span>Payment method</span>
            <select value={form.paymentMethod} onChange={(event) => set("paymentMethod", event.target.value)}>
              <option value="" disabled>Select one</option>
              {paymentMethods.map((method) => <option key={method}>{method}</option>)}
            </select>
          </label>
          <label className="field">
            <span>When ready notify by</span>
            <select value={form.notificationPreference} onChange={(event) => set("notificationPreference", event.target.value)}>
              {["Text message", "Phone call", "Both"].map((option) => <option key={option}>{option}</option>)}
            </select>
          </label>
          <div className="field full repair-fixes">
            <span className="repair-fixes-label">Additional fixes on this phone</span>
            {extraFixes.length ? (
              extraFixes.map((fix, index) => (
                <div className="repair-fix-row" key={index}>
                  <input
                    value={fix.description}
                    placeholder="What else is being fixed?"
                    onChange={(event) => setFix(index, { description: event.target.value })}
                  />
                  <input
                    value={fix.price}
                    inputMode="decimal"
                    placeholder="0.00"
                    onChange={(event) => setFix(index, { price: event.target.value })}
                  />
                  <button
                    className="secondary-button compact-button"
                    type="button"
                    onClick={() => setExtraFixes((current) => current.filter((_, i) => i !== index))}
                  >
                    Remove
                  </button>
                </div>
              ))
            ) : (
              <p className="muted">No extra fixes on this ticket yet.</p>
            )}
            <div className="repair-fixes-footer">
              <button
                className="secondary-button compact-button"
                type="button"
                onClick={() => setExtraFixes((current) => [...current, { description: "", price: "" }])}
              >
                + Add another fix
              </button>
              {cleanFixes.length ? (
                <span className="muted">
                  Extras {formatMoney(fixesTotal)} · all jobs {formatMoney(combinedTotal)}
                </span>
              ) : null}
            </div>
          </div>
          <label className="field full"><span>Notes</span><textarea rows={2} value={form.notes} onChange={(event) => set("notes", event.target.value)} /></label>
          <div className="pos-form-actions form-actions-row">
            <button className="primary-button" type="submit">Save changes</button>
            {/* A PIN is often given after drop-off, so the bench label has to be
                printable again without re-taking the whole ticket. */}
            <button
              className="secondary-button"
              type="button"
              onClick={() => printRepairPhoneLabel({
                ...repair,
                details: { ...details, model: form.model, imei: form.imei, damage: form.damage, devicePin: form.devicePin },
              })}
            >
              Print phone label
            </button>
            <button className="secondary-button" type="button" onClick={onClose}>Cancel</button>
          </div>
        </form>
      </div>
    </div>,
    document.body,
  );
}

// One dialog for taking money on a repair: confirm the amount, tap how the
// customer is actually paying, and charge/mark paid in a single press. Before
// this, the row buttons could only charge the method picked at intake and only
// the amount already on the ticket, so a cashier had to open Edit first.
function RepairPaymentDialog({ repair, taxRate = 0, paying, onConfirm, onClose }) {
  const details = repair.details || {};
  const fixesTotal = (details.additionalFixes || []).reduce(
    (sum, fix) => sum + (Number(fix?.price) || 0),
    0,
  );
  const basePrice = Number(details.finalPrice || details.estimatedPrice || repair.paymentAmount) || 0;
  const suggested = Number(repair.paymentAmount) || basePrice;
  const withFixes = basePrice + fixesTotal;

  const [amount, setAmount] = useState(suggested ? String(suggested) : "");
  const [method, setMethod] = useState(repair.paymentMethod || "");
  const [manualEntry, setManualEntry] = useState(false);
  // Repairs are taxed like any other sale. It is a checkbox, not a fixed rule,
  // so a tax-exempt or out-of-state customer is one click rather than a
  // recalculation done in the cashier's head.
  const rate = Number(taxRate) || 0;
  const [applyTax, setApplyTax] = useState(rate > 0);

  const charging = paying.status === "charging";
  const needsTerminal = isCardPayment(method);
  const value = Number.parseFloat(amount);
  const base = Number.isFinite(value) && value > 0 ? value : 0;
  const taxAmount = applyTax && rate > 0 ? base * (rate / 100) : 0;
  const dueTotal = base + taxAmount;
  const amountLabel = dueTotal > 0 ? formatMoney(dueTotal) : "";

  function submit(event) {
    event.preventDefault();
    event.stopPropagation();
    if (charging) return;
    onConfirm({ amount, method, manualEntry, taxRate: rate, taxAmount });
  }

  return createPortal(
    <div className="dialog-backdrop" role="presentation" onMouseDown={charging ? undefined : onClose}>
      <div className="dialog-card pay-dialog" role="dialog" aria-modal="true" onMouseDown={(event) => event.stopPropagation()}>
        <div className="dialog-head">
          <div>
            <h2>Take payment</h2>
            <p className="muted">
              {details.ticketNumber ? `Repair #${details.ticketNumber}` : "Repair"}
              {details.customerName ? ` · ${details.customerName}` : ""}
              {details.model ? ` · ${details.model}` : ""}
            </p>
          </div>
          {charging ? null : <DialogCloseButton onClose={onClose} label="Close take payment" />}
        </div>
        <form className="form-grid pay-form" onSubmit={submit}>
          <label className="field full">
            <span>Amount</span>
            <input
              className="pay-amount-input"
              inputMode="decimal"
              placeholder="0.00"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              autoFocus
            />
          </label>
          <div className="pay-amount-hints full">
            <span className="muted">
              {details.finalPrice
                ? `Final ${formatPayment(details.finalPrice)}`
                : `Est. ${formatPayment(details.estimatedPrice || repair.paymentAmount)}`}
            </span>
            {fixesTotal > 0 && withFixes !== value ? (
              <button className="secondary-button compact-button" type="button" onClick={() => setAmount(String(withFixes))}>
                Use {formatMoney(withFixes)} (with extra jobs)
              </button>
            ) : null}
          </div>

          <div className="pay-totals full">
            <div className="pay-totals-row"><span>Repair</span><span>{formatMoney(base)}</span></div>
            {rate > 0 ? (
              <label className="checkbox-field pay-tax-toggle">
                <input
                  type="checkbox"
                  checked={applyTax}
                  disabled={charging}
                  onChange={(event) => setApplyTax(event.target.checked)}
                />
                <span>Sales tax ({rate}%)</span>
                <strong>{formatMoney(taxAmount)}</strong>
              </label>
            ) : (
              <p className="muted">No tax rate set for this store. Add the store address in Inventory.</p>
            )}
            <div className="pay-totals-row pay-totals-grand"><span>Total due</span><strong>{formatMoney(dueTotal)}</strong></div>
          </div>

          <div className="field full">
            <span>Paying with</span>
            <div className="pay-method-grid">
              {paymentMethods.map((option) => (
                <button
                  key={option}
                  className={`pay-method${option === method ? " selected" : ""}`}
                  type="button"
                  disabled={charging}
                  onClick={() => setMethod(option)}
                >
                  {option}
                </button>
              ))}
            </div>
          </div>

          {needsTerminal ? (
            <label className="checkbox-field full">
              <input
                type="checkbox"
                checked={manualEntry}
                disabled={charging}
                onChange={(event) => setManualEntry(event.target.checked)}
              />
              <span>Key the card in by hand (no tap / dip / swipe)</span>
            </label>
          ) : null}

          {paying.message ? (
            <p className={`full ${paying.status === "error" ? "summary-error" : "muted"}`}>{paying.message}</p>
          ) : null}

          <div className="pos-form-actions form-actions-row">
            <button className="primary-button" type="submit" disabled={charging}>
              {charging
                ? "Charging…"
                : needsTerminal
                  ? `Charge card${amountLabel ? ` · ${amountLabel}` : ""}`
                  : `Mark paid${amountLabel ? ` · ${amountLabel}` : ""}`}
            </button>
            <button className="secondary-button" type="button" onClick={onClose} disabled={charging}>
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body,
  );
}

function FinalPriceDialog({ prompt, onChange, onConfirm, onClose }) {
  function submit(event) {
    event.preventDefault();
    event.stopPropagation();
    onConfirm();
  }

  return createPortal(
    <div className="dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <div className="dialog-card" role="dialog" aria-modal="true" onMouseDown={(event) => event.stopPropagation()}>
        <div className="dialog-head">
          <div>
            <h2>Final price</h2>
            <p className="muted">
              Enter the final price for repair {prompt.ticket ? `#${prompt.ticket}` : ""} before marking it Ready.
              This becomes the amount the customer owes.
            </p>
          </div>
          <DialogCloseButton onClose={onClose} label="Close final price" />
        </div>
        <form className="form-grid" onSubmit={submit}>
          <label className="field">
            <span>Final price</span>
            <input
              inputMode="decimal"
              placeholder="0.00"
              value={prompt.value}
              onChange={(event) => onChange(event.target.value)}
              autoFocus
            />
          </label>
          <div className="pos-form-actions form-actions-row">
            <button className="primary-button" type="submit">Save &amp; mark Ready</button>
            <button className="secondary-button" type="button" onClick={onClose}>Cancel</button>
          </div>
        </form>
      </div>
    </div>,
    document.body,
  );
}

function PendingReportsPage({ pendingReports, activeEmployee, onSaveCustomerName, onSaveCustomer, onClaim, onSave, onDismiss }) {
  return (
    <section className="history">
      <div className="history-header">
        <div>
          <p className="eyebrow">Shared queue</p>
          <h2>Pending reports</h2>
        </div>
        <span className="metric">Pending <strong>{pendingReports.length}</strong></span>
      </div>

      <div className="pending-grid">
        {pendingReports.length ? (
          pendingReports.map((pendingReport) => (
            <PendingReportCard
              key={pendingReport.id}
              pendingReport={pendingReport}
              activeEmployee={activeEmployee}
              onSaveCustomerName={onSaveCustomerName}
              onSaveCustomer={onSaveCustomer}
              onClaim={onClaim}
              onSave={onSave}
              onDismiss={onDismiss}
            />
          ))
        ) : (
          <p className="empty-state">No pending reports.</p>
        )}
      </div>
    </section>
  );
}

function PendingReportCard({ pendingReport, activeEmployee, onSaveCustomerName, onSaveCustomer, onClaim, onSave, onDismiss }) {
  const imported = pendingReport.imported || {};
  const isCallReport = pendingReport.type === "call" || pendingReport.source === "telebroad";
  const isShopifySale = pendingReport.source === "shopify_pos";
  // Legacy call imports have no callResult — treat them as answered.
  const callResult = isCallReport ? (pendingReport.callResult || "answered") : "";
  const isVoicemailCall = callResult === "voicemail";
  const isMissedCall = callResult === "missed";
  // Missed calls and voicemails are just a "call them back, then dismiss" card —
  // no claim, no completion form. Answered calls keep the full report flow.
  const isReturnableCall = isVoicemailCall || isMissedCall;
  const importedAgentName = (
    imported.employeeName
    || pendingReport.details?.handledBy
    || ""
  ).trim();
  const readyToComplete = isShopifySale || Boolean(importedAgentName);
  const claimedBySomeoneElse = !readyToComplete && pendingReport.claimedBy && pendingReport.claimedBy !== activeEmployee;
  const isClaimedByMe = readyToComplete || pendingReport.claimedBy === activeEmployee;
  const imeiInputRef = useRef(null);
  // Missed/voicemail cards stay collapsed so a long backlog doesn't need much
  // scrolling; the employee expands one to see the details.
  const [expanded, setExpanded] = useState(false);
  // If the caller's number is already in the CRM, pull their saved name and
  // address so the employee only has to add the call reason.
  const [crmMatch, setCrmMatch] = useState(null);
  useEffect(() => {
    const digits = localPhoneDigits(
      pendingReport.customerPhone || imported.customerPhone || imported.callerIdExternal || "",
    );
    if (!digits) { setCrmMatch(null); return undefined; }
    let cancelled = false;
    findCustomerByPhone(digits).then((c) => { if (!cancelled) setCrmMatch(c || null); }).catch(() => {});
    return () => { cancelled = true; };
  }, [pendingReport.customerPhone, imported.customerPhone, imported.callerIdExternal]);
  const [fields, setFields] = useState(() => ({
    customerPhone: pendingReport.customerPhone || imported.customerPhone || imported.callerIdExternal || "",
    callerName: pendingReport.details?.callerName || imported.callerNameExternal || "",
    address: pendingReport.details?.customerAddress || "",
    reason: pendingReport.details?.reason || "",
    outcome: pendingReport.details?.outcome || "Answered",
    followUpDate: pendingReport.details?.followUpDate || "",
    productType: pendingReport.details?.productType || "Phone",
    model: pendingReport.details?.model || imported.lineItemsText || "",
    imei: pendingReport.details?.imei || imported.imei || "",
    notes: pendingReport.notes || "",
    paymentAmount: pendingReport.paymentAmount || imported.totalPrice || "",
    // Shopify is no longer a payment channel: the employee records how the
    // customer actually paid (cash, card on the Sola terminal, etc.).
    paymentMethod:
      pendingReport.paymentMethod && pendingReport.paymentMethod !== "Shopify POS"
        ? pendingReport.paymentMethod
        : "",
  }));

  function updateField(name, value) {
    setFields((current) => ({ ...current, [name]: value }));
  }

  // Backfill name/address from the CRM once customers finish syncing, without
  // clobbering anything the employee has already typed.
  useEffect(() => {
    if (!crmMatch) return;
    setFields((current) => ({
      ...current,
      callerName: current.callerName || crmMatch.name || "",
      address: current.address || crmMatch.address || "",
    }));
  }, [crmMatch]);

  useEffect(() => {
    if (isClaimedByMe && isShopifySale && imeiInputRef.current) {
      imeiInputRef.current.focus();
    }
  }, [isClaimedByMe, isShopifySale]);

  const canSave = isClaimedByMe && fields.customerPhone.trim() && (
    isCallReport
      ? fields.reason.trim() && fields.outcome.trim()
      : fields.productType.trim() && fields.model.trim() && fields.paymentAmount.trim() && fields.paymentMethod.trim()
  );

  function saveCompletedReport() {
    if (!canSave) return;

    const payload = isCallReport
      ? {
        id: crypto.randomUUID(),
        type: "call",
        source: pendingReport.source || "telebroad",
        pendingSourceId: pendingReport.id,
        createdAt: new Date().toISOString(),
        importedAt: pendingReport.createdAt,
        servedBy: activeEmployee,
        signature: activeEmployee,
        signedAt: new Date().toISOString(),
        customerPhone: fields.customerPhone.trim(),
        customerPhoneDigits: digitsOnly(fields.customerPhone),
        paymentAmount: fields.paymentAmount.trim(),
        paymentMethod: fields.paymentMethod.trim(),
        notes: fields.notes.trim(),
        details: {
          callerName: fields.callerName.trim(),
          customerName: fields.callerName.trim(),
          customerAddress: fields.address.trim(),
          reason: fields.reason.trim(),
          outcome: fields.outcome.trim(),
          followUpDate: fields.followUpDate.trim(),
          direction: imported.direction || pendingReport.details?.direction || "",
          handledBy: imported.employeeName || pendingReport.details?.handledBy || "",
          telebroadCallId: imported.callId || pendingReport.details?.telebroadCallId || "",
          telebroadUniqueId: imported.uniqueId || pendingReport.details?.telebroadUniqueId || "",
          recordingUrl: imported.recordingUrl || pendingReport.details?.recordingUrl || "",
          callDuration: imported.callDuration ?? pendingReport.details?.callDuration ?? "",
          talkDuration: imported.talkDuration ?? pendingReport.details?.talkDuration ?? "",
        },
      }
      : {
        id: crypto.randomUUID(),
        type: pendingReport.type || "sale",
        source: pendingReport.source || "shopify_pos",
        pendingSourceId: pendingReport.id,
        createdAt: new Date().toISOString(),
        importedAt: pendingReport.createdAt,
        servedBy: activeEmployee,
        signature: activeEmployee,
        signedAt: new Date().toISOString(),
        customerPhone: fields.customerPhone.trim(),
        customerPhoneDigits: digitsOnly(fields.customerPhone),
        paymentAmount: fields.paymentAmount.trim(),
        paymentMethod: fields.paymentMethod.trim(),
        notes: fields.notes.trim(),
        details: {
          request: "Shopify POS sale",
          productType: fields.productType.trim(),
          model: fields.model.trim(),
          imei: fields.imei.trim(),
          shopifyOrderId: imported.shopifyOrderId || "",
          shopifyOrderName: imported.shopifyOrderName || "",
          shopifyLocation: imported.locationName || "",
          lineItems: imported.lineItems || [],
        },
      };

    Promise.resolve(onSave(pendingReport.id, payload));
  }

  const callTypeLabel = isMissedCall ? "Missed call" : isVoicemailCall ? "Voicemail" : "Call";
  const sourceLabel = isCallReport
    ? `Telebroad · ${callTypeLabel}`
    : isShopifySale
      ? "Shopify POS"
      : "Pending";
  const cardTitle = pendingReport.title
    || imported.shopifyOrderName
    || (isCallReport ? "Pending call report" : "Pending sale");

  // Missed calls and voicemails: a compact row (badge + who + when + Returned)
  // that expands for details, so a long backlog stays short. "Returned" just
  // dismisses the card — no claim, no completion form.
  if (isReturnableCall) {
    const recordingHref = imported.recordingUrl || callRecordingUrl(imported.callId, imported.uniqueId);
    const who = crmMatch?.name || fields.callerName || fields.customerPhone || "Unknown caller";
    return (
      <article className={`pending-card returnable compact ${isMissedCall ? "missed" : "voicemail"} ${expanded ? "open" : ""}`}>
        <div className="returnable-row">
          <button type="button" className="returnable-summary" onClick={() => setExpanded((value) => !value)} aria-expanded={expanded}>
            <span className="expand-caret">{expanded ? "▾" : "▸"}</span>
            <span className={`badge call ${isMissedCall ? "missed" : "voicemail"}`}>{callTypeLabel}</span>
            <span className="returnable-who">{who}</span>
            <span className="returnable-phone">{fields.customerPhone || "-"}</span>
            <span className="returnable-when">{pendingReport.createdAt ? formatShortDate(pendingReport.createdAt) : ""}</span>
          </button>
          <button className="primary-button compact-button" type="button" onClick={() => onDismiss(pendingReport.id)}>
            Returned
          </button>
        </div>

        {expanded ? (
          <div className="pending-import returnable-detail">
            <span><strong>Direction:</strong> {imported.direction || pendingReport.details?.direction || "-"}</span>
            <span><strong>Customer:</strong> {fields.customerPhone || "-"}</span>
            {crmMatch ? <span><strong>Name:</strong> {crmMatch.name || "-"}</span> : <span className="muted">Not in CRM</span>}
            {crmMatch?.address ? <span><strong>Address:</strong> {crmMatch.address}</span> : null}
            <span><strong>Received:</strong> {pendingReport.createdAt ? formatShortDate(pendingReport.createdAt) : "-"}</span>
            {recordingHref ? (
              <a className="secondary-button compact-button" href={recordingHref} target="_blank" rel="noopener noreferrer">
                {isVoicemailCall ? "▶ Voicemail" : "▶ Recording"}
              </a>
            ) : null}
          </div>
        ) : null}
      </article>
    );
  }

  const recordingHref = imported.recordingUrl || callRecordingUrl(imported.callId, imported.uniqueId);
  const summaryRight = isCallReport
    ? (pendingReport.createdAt ? formatShortDate(pendingReport.createdAt) : "")
    : formatPayment(fields.paymentAmount);

  return (
    <article className={`pending-card ${isClaimedByMe ? "claimed" : ""} ${expanded ? "open" : "compact"}`}>
      <div className="returnable-row">
        <button type="button" className="returnable-summary" onClick={() => setExpanded((value) => !value)} aria-expanded={expanded}>
          <span className="expand-caret">{expanded ? "▾" : "▸"}</span>
          <span className={`badge ${isCallReport ? "call" : "sale"}`}>{isCallReport ? callTypeLabel : (pendingReport.type || "sale")}</span>
          <span className="returnable-who">{cardTitle}</span>
          {pendingReport.claimedBy && !readyToComplete ? (
            <span className="returnable-phone">{isClaimedByMe ? "you" : pendingReport.claimedBy}</span>
          ) : null}
          <span className="returnable-when">{summaryRight}</span>
        </button>
      </div>

      {!expanded ? null : (
      <>
      <div className="pending-import">
        {isCallReport ? (
          <>
            <span><strong>Direction:</strong> {imported.direction || pendingReport.details?.direction || "-"}</span>
            <span><strong>Customer:</strong> {fields.customerPhone || "-"}</span>
            {crmMatch ? <span><strong>Name:</strong> {crmMatch.name || "-"}</span> : null}
            {crmMatch?.address ? <span><strong>Address:</strong> {crmMatch.address}</span> : null}
            <span><strong>Handled by:</strong> {importedAgentName || "-"}</span>
            <span><strong>Talk time:</strong> {imported.talkDuration !== "" && imported.talkDuration !== undefined ? `${imported.talkDuration}s` : "-"}</span>
            <span><strong>Imported:</strong> {pendingReport.createdAt ? formatShortDate(pendingReport.createdAt) : "-"}</span>
            {recordingHref ? (
              <a className="secondary-button compact-button" href={recordingHref} target="_blank" rel="noopener noreferrer">
                ▶ Call recording
              </a>
            ) : null}
          </>
        ) : (
          <>
            <span><strong>Total:</strong> {formatPayment(fields.paymentAmount)}</span>
            <span><strong>Customer:</strong> {fields.customerPhone || "-"}</span>
            <span><strong>Location:</strong> {imported.locationName || "-"}</span>
            <span><strong>Items:</strong> {imported.lineItemsText || fields.model || "-"}</span>
            <span><strong>Imported:</strong> {pendingReport.createdAt ? formatShortDate(pendingReport.createdAt) : "-"}</span>
          </>
        )}
      </div>

      {!readyToComplete ? (
        <div className="claim-strip">
          {pendingReport.claimedBy ? (
            <span>
              Claimed by <strong>{isClaimedByMe ? `you (${activeEmployee})` : pendingReport.claimedBy}</strong>
              {pendingReport.claimedAt ? ` · ${formatShortDate(pendingReport.claimedAt)}` : ""}
            </span>
          ) : (
            <span>Unclaimed</span>
          )}
          {!pendingReport.claimedBy ? (
            <button className="primary-button" type="button" onClick={() => onClaim(pendingReport.id)}>
              Claim it
            </button>
          ) : null}
        </div>
      ) : (
        <div className="claim-strip">
          <span>Imported from {isCallReport ? "Telebroad" : "Shopify POS"} · ready to complete</span>
        </div>
      )}

      {isClaimedByMe ? (
        <div className="pending-fields">
          <label className="field">
            <span>Customer phone</span>
            <CustomerPhoneInput
              value={fields.customerPhone}
              onChange={(value) => updateField("customerPhone", value)}
              onSaveCustomerName={onSaveCustomerName}
              onSaveCustomer={onSaveCustomer}
              onSelectCustomer={(customer) => setFields((current) => ({
                ...current,
                customerPhone: customer.phone || current.customerPhone,
                callerName: customer.name || current.callerName,
              }))}
            />
          </label>
          {isCallReport ? (
            <>
              <label className="field">
                <span>Caller name</span>
                <input value={fields.callerName} onChange={(event) => updateField("callerName", event.target.value)} />
              </label>
              <label className="field full">
                <span>Customer address</span>
                <input
                  value={fields.address}
                  onChange={(event) => updateField("address", event.target.value)}
                  placeholder={crmMatch ? "" : "Not in CRM yet"}
                />
              </label>
              <label className="field">
                <span>What does the caller want?</span>
                <input value={fields.reason} onChange={(event) => updateField("reason", event.target.value)} required autoFocus />
              </label>
              <label className="field">
                <span>Call outcome</span>
                <input value={fields.outcome} onChange={(event) => updateField("outcome", event.target.value)} required />
              </label>
              <label className="field">
                <span>Follow-up date</span>
                <input type="date" value={fields.followUpDate} onChange={(event) => updateField("followUpDate", event.target.value)} />
              </label>
            </>
          ) : (
            <>
              <label className="field">
                <span>Product type</span>
                <input value={fields.productType} onChange={(event) => updateField("productType", event.target.value)} />
              </label>
              <label className="field">
                <span>Model / items</span>
                <input value={fields.model} onChange={(event) => updateField("model", event.target.value)} />
              </label>
              <label className="field">
                <span>IMEI</span>
                <input
                  ref={imeiInputRef}
                  value={fields.imei}
                  onChange={(event) => updateField("imei", event.target.value)}
                  inputMode="numeric"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="Scan or type IMEI"
                />
              </label>
              <label className="field">
                <span>Amount</span>
                <input value={fields.paymentAmount} onChange={(event) => updateField("paymentAmount", event.target.value)} />
              </label>
              <label className="field">
                <span>Payment method</span>
                <select value={fields.paymentMethod} onChange={(event) => updateField("paymentMethod", event.target.value)}>
                  <option value="" disabled>Select one</option>
                  {paymentMethods.map((method) => <option key={method}>{method}</option>)}
                </select>
              </label>
            </>
          )}
          <label className="field full">
            <span>Notes / missing details</span>
            <textarea rows="3" value={fields.notes} onChange={(event) => updateField("notes", event.target.value)} />
          </label>
          <button className="primary-button" type="button" disabled={!canSave} onClick={saveCompletedReport}>
            Save report with signature
          </button>
        </div>
      ) : null}

      {claimedBySomeoneElse ? (
        <p className="muted">Only {pendingReport.claimedBy} can complete this pending report.</p>
      ) : null}
      </>
      )}
    </article>
  );
}

function PhoneOrderPage({ activeEmployee, sessionRole, activeLocation, storeLocations, phoneOrders, orderHandlers, storeTax, storeDevices, products, onSaveCustomerName, onSaveCustomer, onCreate, onMarkReady, onAssignDriver, onCancel, onDelivered }) {
  const [outOfState, setOutOfState] = useState(false);
  // Customer resolved by the phone field (queried on demand), for prompts/snapshot.
  const [resolvedCustomer, setResolvedCustomer] = useState(null);
  const [form, setForm] = useState({
    location: activeLocation || (storeLocations || [])[0] || "",
    customerName: "",
    customerPhone: "",
    contactDetails: "",
    customerAddress: "",
    deliveryAddress: "",
    paymentStatus: "",
    paymentMethod: "",
    notes: "",
  });
  const [cart, setCart] = useState([]);
  const [scan, setScan] = useState("");
  const [productSearch, setProductSearch] = useState("");
  const [scanMode, setScanMode] = useState(true);
  const [message, setMessage] = useState("");
  const [customerPrompt, setCustomerPrompt] = useState(null);
  const scanRef = useRef(null);

  function fillFromCustomer(customer) {
    setForm((current) => ({
      ...current,
      customerPhone: customer.phone || current.customerPhone,
      customerName: customer.name || current.customerName,
      contactDetails: customer.contactDetails || current.contactDetails,
      // The on-file address always reflects the selected customer.
      customerAddress: customer.address || current.customerAddress,
      // Pre-fill delivery with the on-file address as a convenience; the employee
      // can change it if this order ships somewhere else.
      deliveryAddress: current.deliveryAddress || customer.address || "",
    }));
  }

  const isAdmin = sessionRole === "admin";
  const locations = uniqueValues([...(storeLocations || []), ...orderHandlers.map((handler) => handler.location)]);

  // An employee runs each pipeline stage for the store they are signed in at;
  // admins see every store. Orders move: At store -> Ready -> Out for delivery.
  const atMyStore = (order) => isAdmin || order.location === activeLocation;
  const fulfillmentOrders = phoneOrders.filter((order) => order.status === "At store" && atMyStore(order));
  const readyOrders = phoneOrders.filter((order) => order.status === "Ready" && atMyStore(order));
  const deliveryOrders = phoneOrders.filter(
    (order) => order.status === "Out for delivery" && (atMyStore(order) || order.assignedTo === activeEmployee),
  );

  const availableProducts = useMemo(
    () => products
      .filter((product) => !form.location || !product.location || product.location === form.location)
      .sort((a, b) => String(a.name || "").localeCompare(String(b.name || ""))),
    [products, form.location],
  );
  const productsById = useMemo(
    () => Object.fromEntries(products.map((product) => [product.id, product])),
    [products],
  );

  function productHaystack(product) {
    return [product.name, product.sku, product.barcode, product.category]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
  }

  function findProductsByTerm(term) {
    const clean = String(term || "").trim().toLowerCase();
    if (!clean) return [];
    const exact = availableProducts.filter((product) => {
      const sku = String(product.sku || "").trim().toLowerCase();
      const barcode = String(product.barcode || "").trim().toLowerCase();
      const name = String(product.name || "").trim().toLowerCase();
      return sku === clean || barcode === clean || name === clean;
    });
    if (exact.length) return exact;
    return availableProducts.filter((product) => productHaystack(product).includes(clean));
  }

  const productMatches = useMemo(() => {
    const clean = productSearch.trim().toLowerCase();
    if (!clean) return [];
    return findProductsByTerm(productSearch).slice(0, 20);
  }, [productSearch, availableProducts]);

  // Don't dump the whole catalog — only surface matches once the user has typed
  // a couple of characters.
  const quickAddProducts = useMemo(() => {
    const clean = productSearch.trim().toLowerCase();
    if (clean.length < 2) return [];
    return findProductsByTerm(productSearch);
  }, [productSearch, availableProducts]);

  function imeiLineStatus(line) {
    if (!line.requiresImei) return "ok";
    if (!line.imei) return "missing";
    const duplicate = cart.filter((other) => other.requiresImei && other.imei === line.imei).length > 1;
    if (duplicate) return "duplicate";
    const stock = productsById[line.productId]?.imeis || [];
    if (stock.length > 0 && !stock.includes(line.imei)) return "notstock";
    return "ok";
  }

  function makeLine(product) {
    return {
      lineId: crypto.randomUUID(),
      productId: product.id,
      sku: product.sku,
      name: product.name,
      price: Number(product.price) || 0,
      qty: 1,
      requiresImei: Boolean(product.requiresImei),
      imei: "",
      category: product.category || "",
      adjustCode: "",
    };
  }

  function addProductToCart(product) {
    const stock = product.requiresImei ? (product.imeis?.length || 0) : (Number(product.quantity) || 0);
    const inCart = cart
      .filter((line) => line.productId === product.id)
      .reduce((sum, line) => sum + (Number(line.qty) || 0), 0);
    if (stock <= 0) {
      playScanError();
      setMessage(`${product.name} is out of stock — can't add it to the order.`);
      return false;
    }
    if (inCart >= stock) {
      playScanError();
      setMessage(`Only ${stock} of ${product.name} in stock.`);
      return false;
    }
    setCart((current) => {
      if (!product.requiresImei) {
        const existing = current.find((line) => line.productId === product.id && !line.requiresImei);
        if (existing) {
          return current.map((line) => (line.lineId === existing.lineId ? { ...line, qty: line.qty + 1 } : line));
        }
      }
      return [...current, makeLine(product)];
    });
    return true;
  }

  function addProductFromSearch(product) {
    if (addProductToCart(product)) {
      playScanBeep();
      setMessage(`Added ${product.name}.`);
    }
  }

  function handleScan(event) {
    event.preventDefault();
    const term = scan.trim();
    if (!term) return;
    const matches = findProductsByTerm(term);
    if (!matches.length) {
      playScanError();
      setMessage(`No product matches "${term}".`);
      return;
    }
    if (matches.length > 1) {
      setProductSearch(term);
      setMessage(`Multiple items match "${term}". Pick one below.`);
      setScan("");
      return;
    }
    if (addProductToCart(matches[0])) {
      playScanBeep();
      setMessage(`Added ${matches[0].name}.`);
    }
    setScan("");
    scanRef.current?.focus();
  }

  function updateQty(lineId, value) {
    const qty = Math.max(1, Number.parseInt(value, 10) || 1);
    setCart((current) => current.map((line) => (line.lineId === lineId ? { ...line, qty } : line)));
  }
  function updateImei(lineId, value) {
    setCart((current) => current.map((line) => (line.lineId === lineId ? { ...line, imei: value.trim() } : line)));
  }
  // Price code: keep only a leading +/- and digits/decimal (see PosPage).
  function updateAdjust(lineId, value) {
    const code = String(value || "").replace(/[^\d.+-]/g, "").replace(/(?!^)[+-]/g, "").slice(0, 10);
    setCart((current) => current.map((line) => (line.lineId === lineId ? { ...line, adjustCode: code } : line)));
  }
  function removeLine(lineId) {
    setCart((current) => current.filter((line) => line.lineId !== lineId));
  }

  const subtotal = cart.reduce((sum, line) => sum + effectiveLinePrice(line) * line.qty, 0);
  const taxRate = Number((storeTax || []).find((entry) => entry?.name === form.location)?.rate) || 0;
  const taxApplies = !outOfState && taxRate > 0;
  const taxAmount = taxApplies ? subtotal * (taxRate / 100) : 0;
  const orderTotal = subtotal + taxAmount;
  const itemCount = cart.reduce((sum, line) => sum + line.qty, 0);
  const itemsText = cart.map((line) => `${line.qty}x ${line.name}`).join(", ");

  // The call-taker only routes the order to a store. The IMEI is scanned and the
  // card is charged later by the store, so creation just needs a store, a
  // customer, a delivery address, and at least one item.
  const canCreate = Boolean(form.location.trim())
    && localPhoneDigits(form.customerPhone).length >= 6
    && Boolean(form.deliveryAddress.trim())
    && Boolean(form.paymentStatus)
    && Boolean(form.paymentMethod)
    && cart.length > 0;

  function updateField(name, value) {
    setForm((current) => ({ ...current, [name]: value }));
  }

  function handleCreateOrder() {
    if (!canCreate) return;
    const digits = localPhoneDigits(form.customerPhone);
    const matched = customerMatchesDigits(resolvedCustomer, digits) ? resolvedCustomer : null;
    // Prompt for a new/incomplete customer, just like POS, before creating.
    if (!matched || !matched.name) {
      setCustomerPrompt({ phone: form.customerPhone.trim(), customer: matched });
      return;
    }
    createOrder(matched);
  }

  function createOrder(matchedCustomer) {
    const onFileAddress = form.customerAddress.trim() || matchedCustomer?.address || form.deliveryAddress.trim();
    const order = {
      id: crypto.randomUUID(),
      type: "phoneOrder",
      // Routed to a store; the store fulfills it (scan IMEI / charge) before it
      // becomes Ready and then Out for delivery.
      status: "At store",
      receiptCode: generateReceiptCode(),
      createdAt: new Date().toISOString(),
      createdBy: activeEmployee,
      location: form.location.trim(),
      assignedTo: "",
      assignedPhone: "",
      customerName: titleCaseName(form.customerName) || titleCaseName(matchedCustomer?.name || ""),
      customerPhone: form.customerPhone.trim(),
      customerPhoneDigits: localPhoneDigits(form.customerPhone),
      contactDetails: form.contactDetails.trim(),
      address: onFileAddress,
      deliveryAddress: form.deliveryAddress.trim(),
      model: cart.length === 1 ? cart[0].name : itemsText,
      itemsText,
      // IMEI is scanned by the store at fulfillment, not here.
      imei: "",
      lineItems: cart.map((line) => ({
        productId: line.productId,
        sku: line.sku,
        name: line.name,
        // Store the adjusted price actually owed; keep the base + code for audit.
        price: effectiveLinePrice(line),
        basePrice: line.price,
        priceAdjust: parsePriceAdjust(line.adjustCode),
        qty: line.qty,
        imei: "",
        requiresImei: line.requiresImei,
        category: line.category,
      })),
      subtotal: subtotal.toFixed(2),
      taxRate,
      taxAmount: taxAmount.toFixed(2),
      outOfState: outOfState ? "Yes" : "No",
      orderTotal: orderTotal.toFixed(2),
      paymentStatus: form.paymentStatus,
      paymentMethod: form.paymentMethod,
      cardStatus: "",
      solaRefNum: "",
      storeAddress: formatStoreAddress((storeTax || []).find((entry) => entry?.name === form.location)),
      storeHours: (storeTax || []).find((entry) => entry?.name === form.location)?.hours || "",
      notes: form.notes.trim(),
    };
    onCreate(order);
    printPhoneOrderReceipt(order);
    setCart([]);
    setCustomerPrompt(null);
    setForm((current) => ({
      ...current,
      customerName: "",
      customerPhone: "",
      contactDetails: "",
      customerAddress: "",
      deliveryAddress: "",
      paymentStatus: "",
      paymentMethod: "",
      notes: "",
    }));
    setMessage(`Order created and sent to ${order.location || "the store"}.`);
  }

  async function handleCustomerPromptSave(values) {
    if (!customerPrompt) return;
    await onSaveCustomer?.({
      // Keep the fields this dialog doesn't edit (contact details, notes) so
      // saving here never blanks them on the stored record.
      ...(customerPrompt.customer || {}),
      id: customerPrompt.customer?.id || "",
      phone: customerPrompt.phone,
      name: values.name.trim(),
      mobile: values.mobile.trim(),
      address: values.address.trim(),
      email: (values.email ?? customerPrompt.customer?.email ?? "").trim(),
    });
    const merged = {
      ...(customerPrompt.customer || {}),
      name: values.name.trim(),
      address: values.address.trim() || customerPrompt.customer?.address || "",
    };
    if (values.name.trim()) updateField("customerName", values.name.trim());
    createOrder(merged);
  }

  function handleCustomerPromptSkip() {
    const customer = customerPrompt?.customer || null;
    createOrder(customer);
  }

  return (
    <>
      <section className="workspace">
        <div className="workspace-header">
          <div>
            <p className="eyebrow">Phone order · take the call</p>
            <h2>Build the order and send it to a store</h2>
          </div>
          <div className="summary-strip">
            <span className="metric">Store <strong>{form.location || "Unassigned"}</strong></span>
            <span className="metric">Total <strong>{formatMoney(orderTotal)}</strong></span>
          </div>
        </div>

        <div className="form-grid">
          <label className="field">
            <span>Assign to store</span>
            <select value={form.location} onChange={(event) => updateField("location", event.target.value)} required>
              <option value="">Select store</option>
              {locations.map((location) => <option key={location}>{location}</option>)}
            </select>
          </label>
          <label className="field">
            <span>Created by</span>
            <input value={activeEmployee} readOnly disabled />
          </label>
        </div>

        <div className="form-grid">
          <label className="field full">
            <span>Customer phone</span>
            <CustomerPhoneInput
              value={form.customerPhone}
              onChange={(value) => updateField("customerPhone", value)}
              onSaveCustomerName={onSaveCustomerName}
              onSaveCustomer={onSaveCustomer}
              onResolveCustomer={setResolvedCustomer}
              onSelectCustomer={(customer) => { fillFromCustomer(customer); setResolvedCustomer(customer); }}
              required
            />
          </label>
          <label className="field">
            <span>Contact details</span>
            <input value={form.contactDetails} onChange={(event) => updateField("contactDetails", event.target.value)} placeholder="Email, WhatsApp, alternate phone" />
          </label>
          <label className="field full">
            <span>Delivery address</span>
            <input value={form.deliveryAddress} onChange={(event) => updateField("deliveryAddress", event.target.value)} placeholder="Where to deliver this order" required />
            <small className="muted">Defaults to the customer address — change it if delivering somewhere else.</small>
          </label>
        </div>

        <div className="segmented-control scan-mode" role="tablist" aria-label="Entry mode">
          <button type="button" className={scanMode ? "selected" : ""} onClick={() => { setScanMode(true); scanRef.current?.focus(); }}>Scan</button>
          <button type="button" className={!scanMode ? "selected" : ""} onClick={() => { setScanMode(false); scanRef.current?.focus(); }}>Manual</button>
        </div>
        <form className="pos-scan" onSubmit={handleScan}>
          <input
            ref={scanRef}
            className="pos-scan-input"
            value={scan}
            onChange={(event) => setScan(event.target.value)}
            placeholder={scanMode ? "Scan a barcode — it adds automatically" : "Type item name, SKU, or barcode, then press Enter"}
            inputMode="text"
            autoComplete="off"
            spellCheck={false}
          />
          {!scanMode ? <button className="primary-button" type="submit">Add</button> : null}
        </form>
        <label className="field full product-search-field">
          <span>Find item by name</span>
          <input
            className="pos-search"
            value={productSearch}
            onChange={(event) => setProductSearch(event.target.value)}
            placeholder="Search item name, SKU, or barcode"
            autoComplete="off"
            spellCheck={false}
          />
        </label>
        {productSearch.trim() ? (
          productMatches.length ? (
            <div className="product-search-results">
              {productMatches.map((product) => {
                const stock = product.requiresImei ? product.imeis?.length || 0 : Number(product.quantity) || 0;
                return (
                  <button
                    className="product-search-row"
                    type="button"
                    key={product.id}
                    onClick={() => addProductFromSearch(product)}
                  >
                    <div>
                      <strong>{product.name}</strong>
                      <p className="muted">
                        {[product.sku, product.barcode].filter(Boolean).join(" · ") || "No SKU"}
                        {" · "}{formatMoney(Number(product.price) || 0)}
                        {" · "}{stock} in stock{product.requiresImei ? " · IMEI" : ""}
                      </p>
                    </div>
                    <span className="product-search-add">Add</span>
                  </button>
                );
              })}
            </div>
          ) : (
            <p className="muted">No matching items for &ldquo;{productSearch.trim()}&rdquo;.</p>
          )
        ) : null}
        {message ? <p className="pos-message">{message}</p> : null}
      </section>

      <div className="pos-layout">
        <section className="history pos-cart">
          <div className="history-header">
            <div>
              <p className="eyebrow">Cart</p>
              <h2>{itemCount} item{itemCount === 1 ? "" : "s"}</h2>
            </div>
          </div>
          {cart.length ? (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr><th>Item</th><th>Price</th><th>Code</th><th>Qty</th><th>IMEI</th><th>Line</th><th></th></tr>
                </thead>
                <tbody>
                  {cart.map((line) => {
                    const adjust = parsePriceAdjust(line.adjustCode);
                    const unitPrice = effectiveLinePrice(line);
                    return (
                    <tr key={line.lineId}>
                      <td><strong>{line.name}</strong><p className="muted">{line.sku}</p></td>
                      <td>
                        {formatMoney(line.price)}
                        {adjust ? <p className="muted">→ {formatMoney(unitPrice)}</p> : null}
                      </td>
                      <td>
                        <input className="pos-adjust" value={line.adjustCode} onChange={(event) => updateAdjust(line.lineId, event.target.value)} placeholder="+/- $" autoComplete="off" spellCheck={false} />
                      </td>
                      <td>
                        {line.requiresImei ? <span className="muted">1</span> : (
                          <input className="pos-qty" type="number" min="1" value={line.qty} onChange={(event) => updateQty(line.lineId, event.target.value)} />
                        )}
                      </td>
                      <td>
                        {line.requiresImei ? <span className="muted">At store</span> : <span className="muted">-</span>}
                      </td>
                      <td>{formatMoney(unitPrice * line.qty)}</td>
                      <td><button className="secondary-button" type="button" onClick={() => removeLine(line.lineId)}>Remove</button></td>
                    </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="empty-state">Scan a product to start the order.</p>
          )}
        </section>

        <section className="workspace pos-checkout">
          <div className="workspace-header">
            <div>
              <p className="eyebrow">Checkout</p>
              <h2>{formatMoney(orderTotal)}</h2>
            </div>
          </div>

          <div className="pos-totals">
            <div className="pos-totals-row"><span>Subtotal</span><span>{formatMoney(subtotal)}</span></div>
            <label className="checkbox-field pos-out-of-state">
              <input type="checkbox" checked={outOfState} onChange={(event) => setOutOfState(event.target.checked)} />
              <span>Out of state (no sales tax)</span>
            </label>
            <div className="pos-totals-row"><span>Tax{taxApplies ? ` (${taxRate}%)` : ""}</span><span>{formatMoney(taxAmount)}</span></div>
            <div className="pos-totals-row pos-totals-grand"><span>Order total</span><strong>{formatMoney(orderTotal)}</strong></div>
          </div>

          <div className="form-grid">
            <label className="field">
              <span>Payment status</span>
              <select value={form.paymentStatus} onChange={(event) => updateField("paymentStatus", event.target.value)}>
                <option value="" disabled>Select one</option>
                <option>Paid</option>
                <option>Collect on delivery</option>
              </select>
            </label>
            <label className="field">
              <span>Payment method</span>
              <select value={form.paymentMethod} onChange={(event) => updateField("paymentMethod", event.target.value)}>
                <option value="" disabled>Select one</option>
                {paymentMethods.map((method) => <option key={method}>{method}</option>)}
              </select>
            </label>
            <label className="field full">
              <span>Notes</span>
              <textarea rows={2} value={form.notes} onChange={(event) => updateField("notes", event.target.value)} />
            </label>
          </div>

          {form.paymentStatus === "Paid" && isCardPayment(form.paymentMethod) ? (
            <p className="muted pos-warning">The store will charge the card on its terminal before marking the order ready.</p>
          ) : null}
          <p className="muted pos-checkout-hint">Use the Create order bar at the bottom of the screen.</p>
        </section>
      </div>

      <section className="history">
        <div className="history-header">
          <div>
            <p className="eyebrow">Quick add</p>
            <h2>Products</h2>
          </div>
          <input
            className="pos-search"
            value={productSearch}
            onChange={(event) => setProductSearch(event.target.value)}
            placeholder="Search item name, SKU, or barcode"
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        <div className="pos-product-grid">
          {quickAddProducts.length ? quickAddProducts.map((product) => (
            <button className="pos-product" type="button" key={product.id} onClick={() => addProductFromSearch(product)}>
              <strong>{product.name}</strong>
              <span>{formatMoney(Number(product.price) || 0)}</span>
              <small className="muted">{product.requiresImei ? `In stock ${product.imeis?.length || 0} - IMEI` : `Stock ${Number(product.quantity) || 0}`}</small>
            </button>
          )) : (
            <p className="empty-state">{productSearch.trim().length >= 2 ? "No matching products for this store." : "Start typing to find a product."}</p>
          )}
        </div>
      </section>

      <div className="pos-action-spacer" />
      <div className="pos-action-bar">
        <div className="pos-action-bar-info">
          <span>{itemCount} item{itemCount === 1 ? "" : "s"} · {form.location || "Store"}</span>
          <strong>{formatMoney(orderTotal)}</strong>
        </div>
        <div className="pos-action-bar-cta">
          {!form.location.trim() ? <span className="pos-action-warn">Pick a store</span> : null}
          {!form.paymentStatus ? <span className="pos-action-warn">Choose payment status</span> : null}
          {!form.paymentMethod ? <span className="pos-action-warn">Choose payment method</span> : null}
          <button className="primary-button pos-complete-button" type="button" disabled={!canCreate} onClick={handleCreateOrder}>
            {cart.length ? `Create order · ${formatMoney(orderTotal)}` : "Scan items to start"}
          </button>
        </div>
      </div>

      {customerPrompt ? (
        <CustomerInfoDialog
          phone={customerPrompt.phone}
          customer={customerPrompt.customer}
          saveLabel="Save & create order"
          onSave={handleCustomerPromptSave}
          onSkip={handleCustomerPromptSkip}
          onClose={() => setCustomerPrompt(null)}
        />
      ) : null}

      <StoreFulfillmentBoard
        orders={fulfillmentOrders}
        products={products}
        onMarkReady={onMarkReady}
        onCancel={onCancel}
      />

      <AssignDriverBoard
        orders={readyOrders}
        orderHandlers={orderHandlers}
        onAssignDriver={onAssignDriver}
        onCancel={onCancel}
      />

      <DeliveryBoard
        orders={deliveryOrders}
        activeEmployee={activeEmployee}
        sessionRole={sessionRole}
        activeLocation={activeLocation}
        onDelivered={onDelivered}
        onCancel={onCancel}
      />
    </>
  );
}

function confirmCancelOrder(order, onCancel) {
  if (!onCancel) return;
  const restores = order.status === "Ready" || order.status === "Out for delivery";
  const ok = window.confirm(
    `Cancel the order for ${order.customerName || order.customerPhone || "this customer"}? It will be removed from the pipeline${restores ? " and the items returned to stock" : ""}.`,
  );
  if (ok) onCancel(order.id);
}

// Shared order summary block used across the three pipeline boards.
function PhoneOrderSummary({ order }) {
  return (
    <>
      <div className="pending-import">
        <span><strong>Customer:</strong> {order.customerName || order.customerPhone}</span>
        <span><strong>Phone:</strong> {order.customerPhone}</span>
        <span><strong>Items:</strong> {order.itemsText || order.model}</span>
        <span><strong>Total:</strong> {formatPayment(order.orderTotal)}</span>
      </div>
      <div className="details">
        <span><strong>Deliver to:</strong> {order.deliveryAddress || order.address}</span>
        {order.contactDetails ? <span><strong>Contact:</strong> {order.contactDetails}</span> : null}
        {order.notes ? <span className="muted">{order.notes}</span> : null}
      </div>
    </>
  );
}

// Stage 2 — the store fulfills each order: scan the IMEI(s), charge the card if
// it's a pay-now CC order, then mark it ready for a driver.
function StoreFulfillmentBoard({ orders, products, onMarkReady, onCancel }) {
  return (
    <div className="order-board">
      <div className="history-header">
        <div>
          <p className="eyebrow">At your store · fulfill</p>
          <h2>Orders to prepare</h2>
        </div>
        <span className="metric">Waiting <strong>{orders.length}</strong></span>
      </div>
      <div className="pending-grid">
        {orders.length ? (
          orders.map((order) => (
            <StoreOrderCard key={order.id} order={order} products={products} onMarkReady={onMarkReady} onCancel={onCancel} />
          ))
        ) : (
          <p className="empty-state">No orders waiting to be prepared.</p>
        )}
      </div>
    </div>
  );
}

// Taking the money for a phone order. Used twice: by the store before it marks
// a prepaid order ready, and by whoever closes out a "Collect on delivery" one.
// A card can be run on the in-store terminal from here, and there is always a
// manual path — the terminal lives on one PC, and an order must never be stuck
// with no way to record what the customer actually paid.
function OrderPaymentDialog({ order, heading, confirmLabel, onConfirm, onClose }) {
  const amount = Number(order.orderTotal) || 0;
  const [method, setMethod] = useState(order.paymentMethod || "");
  const [cardEntryMode, setCardEntryMode] = useState("terminal");
  const [card, setCard] = useState({ status: "idle", message: "", refNum: "" });
  const needsTerminal = isCardPayment(method);
  const charging = card.status === "charging";

  function pickMethod(next) {
    setMethod(next);
    setCard({ status: "idle", message: "", refNum: "" });
  }

  async function chargeCard() {
    if (!amount) return;
    try {
      setCard({ status: "charging", message: "Sending sale to the terminal...", refNum: "" });
      const result = await chargeOnLocalTerminal({
        amount: amount.toFixed(2),
        externalRequestId: `order-${order.id}`.slice(0, 32),
        manualEntry: cardEntryMode === "manual",
        onStatus: (text) => setCard((current) => ({ ...current, message: text })),
      });
      setCard({
        status: "paid",
        message: result.maskedCardNumber
          ? `Card approved (${result.cardType || "card"} ${result.maskedCardNumber}).`
          : "Card approved.",
        refNum: result.refNum || "",
      });
    } catch (error) {
      setCard({ status: "error", message: error.message || "Card payment failed.", refNum: "" });
    }
  }

  return createPortal(
    <div className="dialog-backdrop" role="presentation" onMouseDown={charging ? undefined : onClose}>
      <div className="dialog-card" role="dialog" aria-modal="true" onMouseDown={(event) => event.stopPropagation()}>
        <div className="dialog-head">
          <div>
            <h2>{heading}</h2>
            <p className="muted">{order.customerName || order.customerPhone} · {order.itemsText || order.model}</p>
          </div>
          {charging ? null : <DialogCloseButton onClose={onClose} label="Close take payment" />}
        </div>

        <div className="pos-totals">
          <div className="pos-totals-row pos-totals-grand">
            <span>Amount due</span>
            <strong>{formatMoney(amount)}</strong>
          </div>
        </div>

        <label className="field">
          <span>Paid by</span>
          <select value={method} onChange={(event) => pickMethod(event.target.value)} disabled={charging || card.status === "paid"}>
            <option value="" disabled>Select one</option>
            {paymentMethods.map((entry) => <option key={entry}>{entry}</option>)}
          </select>
        </label>

        {needsTerminal ? (
          <div className="payment-panel payment-panel-stack">
            <div>
              <p className="eyebrow">Card payment</p>
              <h3>Charge {formatMoney(amount)} on the terminal</h3>
            </div>
            <div className="segmented-control" role="tablist" aria-label="Card entry mode">
              <button type="button" className={cardEntryMode === "terminal" ? "selected" : ""} onClick={() => setCardEntryMode("terminal")} disabled={charging || card.status === "paid"}>Tap / dip / swipe</button>
              <button type="button" className={cardEntryMode === "manual" ? "selected" : ""} onClick={() => setCardEntryMode("manual")} disabled={charging || card.status === "paid"}>Manual entry</button>
            </div>
            <button className="secondary-button" type="button" onClick={chargeCard} disabled={charging || card.status === "paid" || !amount}>
              {card.status === "paid" ? "Card charged ✓" : charging ? "Waiting for card..." : cardEntryMode === "manual" ? "Charge card (manual entry)" : "Charge card (tap / dip / swipe)"}
            </button>
            {card.message ? <p className={card.status === "error" ? "summary-error" : "muted"}>{card.message}</p> : null}
            {card.status !== "paid" ? (
              <p className="muted">
                No terminal on this computer, or the card was run somewhere else? Record the payment anyway — the
                order still needs to move on.
              </p>
            ) : null}
          </div>
        ) : null}

        <div className="pos-form-actions form-actions-row">
          <button
            className="primary-button"
            type="button"
            disabled={!method || charging}
            onClick={() => onConfirm({ paymentMethod: method, refNum: card.refNum, amount })}
          >
            {confirmLabel}
          </button>
          <button className="secondary-button" type="button" onClick={onClose} disabled={charging}>
            Cancel
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function StoreOrderCard({ order, products, onMarkReady, onCancel }) {
  const imeiLines = (order.lineItems || []).filter((line) => line.requiresImei);
  const [imeis, setImeis] = useState(() => imeiLines.map((line) => line.imei || ""));
  const [payOpen, setPayOpen] = useState(false);
  // What was actually collected here, once it has been. Prepaid orders can't go
  // out until this is filled in; collect-on-delivery ones are paid at the door.
  const [payment, setPayment] = useState(null);

  const needsPayment = order.paymentStatus === "Paid";
  const paid = !needsPayment || Boolean(payment);

  function imeiStatus(index) {
    const value = imeis[index];
    if (!value) return "missing";
    if (imeis.filter((other) => other === value).length > 1) return "duplicate";
    const stock = products.find((product) => product.id === imeiLines[index].productId)?.imeis || [];
    if (stock.length > 0 && !stock.includes(value)) return "notstock";
    return "ok";
  }
  const imeisOk = imeiLines.every((_, index) => imeiStatus(index) === "ok");
  const canReady = imeisOk && paid;

  function markReady() {
    if (!canReady) return;
    let cursor = 0;
    const lineItems = (order.lineItems || []).map((line) => {
      if (!line.requiresImei) return line;
      const imei = imeis[cursor];
      cursor += 1;
      return { ...line, imei };
    });
    onMarkReady(order.id, {
      lineItems,
      cardStatus: payment?.refNum ? "paid" : "",
      solaRefNum: payment?.refNum || "",
      paymentMethod: payment?.paymentMethod || order.paymentMethod,
      paymentStatus: payment ? "Paid" : order.paymentStatus,
      paidAt: payment ? new Date().toISOString() : "",
    });
  }

  return (
    <article className="pending-card" key={order.id}>
      <div className="pending-card-head">
        <div>
          <p className="eyebrow">{order.location}</p>
          <h3>{order.model}</h3>
        </div>
        <span className="badge phoneOrder">{order.paymentMethod} · {order.paymentStatus}</span>
      </div>
      <PhoneOrderSummary order={order} />

      {imeiLines.length ? (
        <div className="store-imei-list">
          {imeiLines.map((line, index) => (
            <label className="field" key={`${line.lineId || line.productId}-${index}`}>
              <span>IMEI · {line.name}</span>
              <input
                className={`pos-imei ${imeiStatus(index) === "ok" ? "" : "pos-imei-missing"}`}
                value={imeis[index]}
                onChange={(event) => setImeis((current) => current.map((value, i) => (i === index ? event.target.value.trim() : value)))}
                placeholder="Scan IMEI"
                inputMode="numeric"
                autoComplete="off"
                spellCheck={false}
              />
            </label>
          ))}
        </div>
      ) : null}

      {needsPayment ? (
        <div className="payment-panel payment-panel-stack">
          <div>
            <p className="eyebrow">Payment</p>
            <h3>{payment ? `Paid · ${payment.paymentMethod}` : `${formatPayment(order.orderTotal)} due before this goes out`}</h3>
          </div>
          {payment ? (
            <p className="muted">
              Recorded as {payment.paymentMethod}{payment.refNum ? ` · ref ${payment.refNum}` : ""}.
              <button className="ghost-button compact-button" type="button" onClick={() => setPayment(null)}>Undo</button>
            </p>
          ) : (
            <button className="secondary-button" type="button" onClick={() => setPayOpen(true)}>
              Take payment {formatPayment(order.orderTotal)}
            </button>
          )}
        </div>
      ) : (
        <p className="muted">Collect on delivery — the driver takes the {formatPayment(order.orderTotal)} at the door.</p>
      )}

      {!imeisOk ? <p className="muted pos-warning">Scan a valid in-stock IMEI for every phone.</p> : null}
      {imeisOk && !paid ? <p className="muted pos-warning">Take the payment before marking ready.</p> : null}
      <div className="order-card-actions">
        <button className="primary-button" type="button" disabled={!canReady} onClick={markReady}>
          Mark ready
        </button>
        <button className="secondary-button" type="button" onClick={() => confirmCancelOrder(order, onCancel)}>
          Cancel order
        </button>
      </div>

      {payOpen ? (
        <OrderPaymentDialog
          order={order}
          heading="Take payment"
          confirmLabel="Record payment"
          onConfirm={(taken) => {
            setPayment(taken);
            setPayOpen(false);
          }}
          onClose={() => setPayOpen(false)}
        />
      ) : null}
    </article>
  );
}

// Stage 3 — the store hands a ready order to a driver, which texts the driver
// and the customer.
function AssignDriverBoard({ orders, orderHandlers, onAssignDriver, onCancel }) {
  return (
    <div className="order-board">
      <div className="history-header">
        <div>
          <p className="eyebrow">Ready · assign a driver</p>
          <h2>Hand off to a driver</h2>
        </div>
        <span className="metric">Ready <strong>{orders.length}</strong></span>
      </div>
      <div className="pending-grid">
        {orders.length ? (
          orders.map((order) => (
            <AssignDriverCard key={order.id} order={order} orderHandlers={orderHandlers} onAssignDriver={onAssignDriver} onCancel={onCancel} />
          ))
        ) : (
          <p className="empty-state">No orders ready for a driver.</p>
        )}
      </div>
    </div>
  );
}

function AssignDriverCard({ order, orderHandlers, onAssignDriver, onCancel }) {
  const drivers = orderHandlers.filter((handler) => handler.location === order.location);
  const list = drivers.length ? drivers : orderHandlers;
  const [driverId, setDriverId] = useState(list[0]?.id || "");
  const driver = list.find((handler) => handler.id === driverId) || list[0] || null;

  return (
    <article className="pending-card" key={order.id}>
      <div className="pending-card-head">
        <div>
          <p className="eyebrow">{order.location}</p>
          <h3>{order.model}</h3>
        </div>
        <span className="badge phoneOrder">Ready</span>
      </div>
      <PhoneOrderSummary order={order} />
      <label className="field">
        <span>Driver</span>
        <select value={driverId} onChange={(event) => setDriverId(event.target.value)}>
          {list.length ? (
            list.map((handler) => <option key={handler.id} value={handler.id}>{handler.name}</option>)
          ) : (
            <option value="">No drivers for this store</option>
          )}
        </select>
      </label>
      <div className="order-card-actions">
        <button className="primary-button" type="button" disabled={!driver} onClick={() => driver && onAssignDriver(order.id, driver)}>
          Assign driver &amp; notify
        </button>
        <button className="secondary-button" type="button" onClick={() => confirmCancelOrder(order, onCancel)}>
          Cancel order
        </button>
      </div>
    </article>
  );
}

// Stage 4 — out for delivery. The assigned driver, the store, or an admin can
// mark it delivered, which files the report and texts the customer.
function DeliveryBoard({ orders, activeEmployee, sessionRole, activeLocation, onDelivered, onCancel }) {
  return (
    <div className="order-board">
      <div className="history-header">
        <div>
          <p className="eyebrow">Out for delivery</p>
          <h2>Open deliveries</h2>
        </div>
        <span className="metric">Open <strong>{orders.length}</strong></span>
      </div>
      <div className="pending-grid">
        {orders.length ? orders.map((order) => {
          const canDeliver = sessionRole === "admin"
            || order.assignedTo === activeEmployee
            || order.location === activeLocation;
          return (
            <DeliveryCard
              key={order.id}
              order={order}
              canDeliver={canDeliver}
              onDelivered={onDelivered}
              onCancel={onCancel}
            />
          );
        }) : (
          <p className="empty-state">No open deliveries.</p>
        )}
      </div>
    </div>
  );
}

// One open delivery. A collect-on-delivery order takes its payment here — the
// money changes hands at the door, and this is the last point where the app can
// record what it was. Prepaid orders were already settled at the store.
function DeliveryCard({ order, canDeliver, onDelivered, onCancel }) {
  const [payOpen, setPayOpen] = useState(false);
  const collectOnDelivery = order.paymentStatus !== "Paid";

  return (
    <article className="pending-card">
      <div className="pending-card-head">
        <div>
          <p className="eyebrow">{order.location}</p>
          <h3>{order.model}</h3>
        </div>
        <span className="badge phoneOrder">{order.paymentStatus}</span>
      </div>
      <PhoneOrderSummary order={order} />
      <div className="details">
        <span><strong>Driver:</strong> {order.assignedTo || "-"}</span>
      </div>
      {collectOnDelivery ? (
        <p className="muted pos-warning">Collect {formatPayment(order.orderTotal)} from the customer, then mark it delivered.</p>
      ) : null}
      <div className="order-card-actions">
        <button
          className="primary-button"
          type="button"
          disabled={!canDeliver}
          onClick={() => (collectOnDelivery ? setPayOpen(true) : onDelivered(order.id))}
        >
          {collectOnDelivery ? `Take payment · mark delivered` : "Mark delivered"}
        </button>
        <button className="secondary-button" type="button" disabled={!canDeliver} onClick={() => confirmCancelOrder(order, onCancel)}>
          Cancel order
        </button>
      </div>

      {payOpen ? (
        <OrderPaymentDialog
          order={order}
          heading="Collect payment"
          confirmLabel="Record payment & mark delivered"
          onConfirm={(taken) => {
            setPayOpen(false);
            onDelivered(order.id, taken);
          }}
          onClose={() => setPayOpen(false)}
        />
      ) : null}
    </article>
  );
}

function PosPage({ products, reports = [], storeLocations = [], activeEmployee, activeLocation, activeDeviceId, activeTaxRate, activeStoreInfo, onSaveCustomerName, onSaveCustomer, onSaveProduct, onCompleteSale }) {
  const [cart, setCart] = useState([]);
  const [scan, setScan] = useState("");
  const [scanMode, setScanMode] = useState(true);
  // When set, the restock dialog is open for this product (add stock without
  // leaving checkout).
  const [restock, setRestock] = useState(null);
  // Customer resolved by the phone field (queried on demand) for the receipt/CRM.
  const [resolvedCustomer, setResolvedCustomer] = useState(null);
  const [productSearch, setProductSearch] = useState("");
  const [sortMode, setSortMode] = useState("used");
  const [customerPhone, setCustomerPhone] = useState("");
  const [paymentMethod, setPaymentMethod] = useState("");
  // Split tender: the cashier types how much goes on the first method and the
  // rest falls to the second, so the two always add up to the grand total.
  const [splitPayment, setSplitPayment] = useState(false);
  const [splitSecondMethod, setSplitSecondMethod] = useState("");
  const [splitFirstInput, setSplitFirstInput] = useState("");
  const [outOfState, setOutOfState] = useState(false);
  const [notes, setNotes] = useState("");
  const [message, setMessage] = useState("");
  const [completedSale, setCompletedSale] = useState(null);
  const [customAmountOpen, setCustomAmountOpen] = useState(false);
  const [card, setCard] = useState({ status: "idle", message: "", refNum: "" });
  const scanRef = useRef(null);

  useEffect(() => {
    scanRef.current?.focus();
  }, []);

  const availableProducts = useMemo(
    () =>
      products
        .filter((product) => !activeLocation || !product.location || product.location === activeLocation)
        .sort((a, b) => String(a.name || "").localeCompare(String(b.name || ""))),
    [products, activeLocation],
  );

  const productsById = useMemo(
    () => Object.fromEntries(products.map((product) => [product.id, product])),
    [products],
  );

  // Units sold per product across every recorded sale, so the search can float
  // the items this shop actually rings up to the top. Read off the reports
  // already in memory — no extra queries.
  const unitsSoldByProduct = useMemo(() => {
    const counts = new Map();
    reports.forEach((report) => {
      (report.details?.lineItems || []).forEach((line) => {
        if (!line.productId) return;
        counts.set(line.productId, (counts.get(line.productId) || 0) + (Number(line.qty) || 1));
      });
    });
    return counts;
  }, [reports]);

  // Quick-add only surfaces matches once a couple of characters are typed,
  // instead of listing the entire catalog up front.
  const quickAddProducts = useMemo(() => {
    const clean = productSearch.trim().toLowerCase();
    if (clean.length < 2) return [];
    const matches = availableProducts.filter((product) =>
      [product.name, product.sku, product.barcode, product.category]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(clean),
    );
    // availableProducts is already name-sorted, so name order needs no re-sort
    // and doubles as the tie-breaker for the other two modes.
    const byName = (a, b) => String(a.name || "").localeCompare(String(b.name || ""));
    if (sortMode === "price") {
      return matches.slice().sort((a, b) => (Number(a.price) || 0) - (Number(b.price) || 0) || byName(a, b));
    }
    if (sortMode === "used") {
      return matches
        .slice()
        .sort((a, b) => (unitsSoldByProduct.get(b.id) || 0) - (unitsSoldByProduct.get(a.id) || 0) || byName(a, b));
    }
    return matches;
  }, [productSearch, availableProducts, sortMode, unitsSoldByProduct]);

  // True once the search is long enough to actually be filtering, so the panel
  // can tell "nothing typed yet" apart from "typed, but nothing matches".
  const searching = productSearch.trim().length >= 2;

  function imeiLineStatus(line) {
    if (!line.requiresImei) return "ok";
    if (!line.imei) return "missing";
    const duplicate = cart.filter((other) => other.requiresImei && other.imei === line.imei).length > 1;
    if (duplicate) return "duplicate";
    const stock = productsById[line.productId]?.imeis || [];
    if (stock.length > 0 && !stock.includes(line.imei)) return "notstock";
    return "ok";
  }

  function makeLine(product, imei = "") {
    return {
      lineId: crypto.randomUUID(),
      productId: product.id,
      sku: product.sku,
      name: product.name,
      price: Number(product.price) || 0,
      qty: 1,
      requiresImei: Boolean(product.requiresImei),
      imei: product.requiresImei ? imei : "",
      category: product.category || "",
      adjustCode: "",
    };
  }

  function makeCustomLine(amount, name) {
    const price = Number.parseFloat(String(amount || "").replace(/[^\d.]/g, ""));
    if (!Number.isFinite(price) || price <= 0) return null;
    const label = String(name || "").trim() || "Custom item";
    return {
      lineId: crypto.randomUUID(),
      productId: "",
      sku: "CUSTOM",
      name: label,
      price,
      qty: 1,
      requiresImei: false,
      imei: "",
      category: "Custom",
      adjustCode: "",
      isCustom: true,
    };
  }

  function addCustomItemToCart(amount, name) {
    const line = makeCustomLine(amount, name);
    if (!line) {
      playScanError();
      setMessage("Enter a valid custom amount greater than zero.");
      return false;
    }
    setCart((current) => [...current, line]);
    playScanBeep();
    setMessage(`Added ${line.name} for ${formatMoney(line.price)}.`);
    return true;
  }

  function updateCustomPrice(lineId, value) {
    const price = Number.parseFloat(String(value || "").replace(/[^\d.]/g, ""));
    if (!Number.isFinite(price) || price <= 0) return;
    setCart((current) =>
      current.map((line) => (line.lineId === lineId && line.isCustom ? { ...line, price } : line)),
    );
  }

  function findProductByImei(imei) {
    const clean = digitsOnly(imei);
    if (!clean) return null;
    const matches = products.filter(
      (product) =>
        product.requiresImei
        && (product.imeis || []).some((value) => digitsOnly(value) === clean),
    );
    if (!matches.length) return null;
    return (
      matches.find((product) => product.location === activeLocation) ||
      matches.find((product) => !product.location) ||
      matches[0]
    );
  }

  function findProductBySku(sku) {
    const clean = String(sku || "").trim().toLowerCase();
    if (!clean) return null;
    const matches = products.filter(
      (product) =>
        String(product.sku || "").trim().toLowerCase() === clean ||
        String(product.barcode || "").trim().toLowerCase() === clean,
    );
    if (!matches.length) return null;
    return (
      matches.find((product) => product.location === activeLocation) ||
      matches.find((product) => !product.location) ||
      matches[0]
    );
  }

  function addProductToCart(product, imei = "") {
    const stock = product.requiresImei ? (product.imeis?.length || 0) : (Number(product.quantity) || 0);
    const inCart = cart
      .filter((line) => line.productId === product.id)
      .reduce((sum, line) => sum + (Number(line.qty) || 0), 0);
    if (stock <= 0) {
      playScanError();
      setMessage(`${product.name} is out of stock — can't sell it.`);
      return false;
    }
    if (inCart >= stock) {
      playScanError();
      setMessage(`Only ${stock} of ${product.name} in stock.`);
      return false;
    }
    setCart((current) => {
      if (product.requiresImei) {
        return [...current, makeLine(product, imei)];
      }
      const existing = current.find((line) => line.productId === product.id && !line.requiresImei);
      if (existing) {
        return current.map((line) =>
          line.lineId === existing.lineId ? { ...line, qty: line.qty + 1 } : line,
        );
      }
      return [...current, makeLine(product)];
    });
    return true;
  }

  function handleScan(event) {
    event.preventDefault();
    const term = scan.trim();
    if (!term) return;

    // A scanned IMEI resolves to the handset carrying it and fills the line's
    // IMEI in for the cashier. Only IMEIs already on file match; anything else
    // falls through to the normal SKU/barcode lookup.
    const imeiProduct = findProductByImei(term);
    if (imeiProduct) {
      const imei = digitsOnly(term);
      if (cart.some((line) => line.imei === imei)) {
        playScanError();
        setMessage(`IMEI ${imei} is already on this sale.`);
      } else if (addProductToCart(imeiProduct, imei)) {
        playScanBeep();
        setMessage(`Added ${imeiProduct.name} · IMEI ${imei}.`);
      }
      setScan("");
      scanRef.current?.focus();
      return;
    }

    const product = findProductBySku(term);
    if (!product) {
      playScanError();
      setMessage(`No product found for "${term}".`);
    } else if (addProductToCart(product)) {
      playScanBeep();
      setMessage(`Added ${product.name}.`);
    }
    setScan("");
    scanRef.current?.focus();
  }

  function updateQty(lineId, qty) {
    const value = Math.max(1, Number(qty) || 1);
    setCart((current) => current.map((line) => (line.lineId === lineId ? { ...line, qty: value } : line)));
  }

  function updateImei(lineId, imei) {
    const digits = String(imei || "").replace(/\D/g, "");
    setCart((current) => current.map((line) => (line.lineId === lineId ? { ...line, imei: digits } : line)));
  }

  // Price code: keep only a leading +/- and digits/decimal so the field can't
  // hold anything parsePriceAdjust would reject.
  function updateAdjust(lineId, value) {
    const code = String(value || "").replace(/[^\d.+-]/g, "").replace(/(?!^)[+-]/g, "").slice(0, 10);
    setCart((current) => current.map((line) => (line.lineId === lineId ? { ...line, adjustCode: code } : line)));
  }

  function removeLine(lineId) {
    setCart((current) => current.filter((line) => line.lineId !== lineId));
  }

  // Add stock to a product straight from checkout (e.g. a scanned item that just
  // came in). Mirrors Inventory's restock so counts stay consistent.
  function addStock(product, { addQuantity, newImeis, location, barcode }) {
    if (!onSaveProduct || !product) return;
    const nextLocation = location === undefined ? product.location : location;
    const barcodePatch = barcode && !product.barcode ? { barcode: String(barcode).trim() } : {};
    if (product.requiresImei) {
      onSaveProduct({ ...product, location: nextLocation, ...barcodePatch, imeis: [...(product.imeis || []), ...newImeis] });
    } else {
      onSaveProduct({ ...product, location: nextLocation, ...barcodePatch, quantity: (Number(product.quantity) || 0) + addQuantity });
    }
    setMessage(`Restocked ${product.name}.`);
  }

  const subtotal = cart.reduce((sum, line) => sum + effectiveLinePrice(line) * line.qty, 0);
  const taxRate = Number(activeTaxRate) || 0;
  const itemCount = cart.reduce((sum, line) => sum + line.qty, 0);

  const firstIsCard = isCardPayment(paymentMethod);
  const secondIsCard = isCardPayment(splitSecondMethod);
  // Splitting a sale between cash and a card taxes the card share only: the
  // amount typed for each side is its share of the pre-tax subtotal, and the
  // sales tax rides on top of whichever side is the card.
  const splitTaxOnCardOnly = splitPayment && Boolean(splitSecondMethod) && firstIsCard !== secondIsCard;
  const splitFirstEntered = splitPayment ? Math.max(0, Number(splitFirstInput) || 0) : 0;
  // What the split is measured against: the pre-tax subtotal when only the card
  // share is taxed, otherwise the full total the customer owes.
  const splitBasis = splitTaxOnCardOnly ? subtotal : 0;
  const taxBase = splitTaxOnCardOnly
    ? Math.min(subtotal, Math.max(0, firstIsCard ? splitFirstEntered : subtotal - splitFirstEntered))
    : subtotal;
  const taxApplies = !outOfState && taxRate > 0;
  const taxAmount = taxApplies ? taxBase * (taxRate / 100) : 0;
  const total = subtotal + taxAmount;
  // The card side pays its share plus the tax; the cash side pays its share flat.
  const splitFirstAmount = splitTaxOnCardOnly && firstIsCard ? splitFirstEntered + taxAmount : splitFirstEntered;
  const splitSecondAmount = splitPayment ? Math.max(0, total - splitFirstAmount) : 0;
  // Only the card's share goes to the terminal, not the whole sale.
  const cardAmount = splitPayment
    ? (firstIsCard ? splitFirstAmount : 0) + (secondIsCard ? splitSecondAmount : 0)
    : (firstIsCard ? total : 0);
  const requiresCardCharge = cardAmount > 0;
  const cardChargeComplete = !requiresCardCharge || card.status === "paid";
  const splitIssue = (() => {
    if (!splitPayment) return "";
    if (!splitSecondMethod) return "Choose the second payment method.";
    if (splitSecondMethod === paymentMethod) return "Pick two different payment methods.";
    if (!(splitFirstEntered > 0)) return "Enter how much goes on the first method.";
    if (splitFirstEntered >= (splitBasis || total)) {
      return `The first amount has to be less than ${formatMoney(splitBasis || total)}.`;
    }
    return "";
  })();
  const payments = splitPayment && !splitIssue
    ? [
        { method: paymentMethod, amount: splitFirstAmount.toFixed(2) },
        { method: splitSecondMethod, amount: splitSecondAmount.toFixed(2) },
      ]
    : [{ method: paymentMethod, amount: total.toFixed(2) }];
  const imeiIssue = (() => {
    if (cart.some((line) => imeiLineStatus(line) === "missing")) {
      return "Scan an IMEI for every phone before checkout.";
    }
    if (cart.some((line) => imeiLineStatus(line) === "duplicate")) {
      return "The same IMEI is on two lines. Each phone needs its own unique IMEI.";
    }
    if (cart.some((line) => imeiLineStatus(line) === "notstock")) {
      return "An IMEI is not in this product's inventory. Scan a phone that is in stock.";
    }
    return "";
  })();
  const saleCustomer = findSaleCustomer();
  // Customer details are optional: a sale can be rung up with no phone, name or
  // address. Whatever is filled in still rides along to the receipt and the CRM.
  const canCheckout =
    cart.length > 0
    && !imeiIssue
    && !splitIssue
    && cardChargeComplete
    && Boolean(paymentMethod);

  useEffect(() => {
    setCard((current) =>
      current.status === "idle" ? current : { status: "idle", message: "", refNum: "" },
    );
  }, [total, paymentMethod, splitPayment, splitSecondMethod, splitFirstInput]);

  async function chargeCard() {
    if (!requiresCardCharge || !cardAmount) return;
    try {
      setCard({ status: "charging", message: "Sending sale to the terminal...", refNum: "" });
      const result = await chargeOnLocalTerminal({
        amount: cardAmount.toFixed(2),
        externalRequestId: `sale-${Date.now()}`,
        onStatus: (text) => setCard((current) => ({ ...current, message: text })),
      });
      setCard({
        status: "paid",
        message: result.maskedCardNumber
          ? `Card approved (${result.cardType || "card"} ${result.maskedCardNumber}).`
          : "Card approved.",
        refNum: result.refNum || "",
      });
    } catch (error) {
      setCard({ status: "error", message: error.message || "Card payment failed.", refNum: "" });
    }
  }

  function findSaleCustomer() {
    const localDigits = localPhoneDigits(customerPhone);
    if (localDigits.length < 6) return null;
    return customerMatchesDigits(resolvedCustomer, localDigits) ? resolvedCustomer : null;
  }

  function handleCheckout() {
    if (!canCheckout) {
      if (imeiIssue) setMessage(imeiIssue);
      else if (!paymentMethod) setMessage("Choose a payment method before completing the sale.");
      else if (splitIssue) setMessage(splitIssue);
      else if (!cardChargeComplete) setMessage("Charge the card before completing the sale.");
      return;
    }
    completeSale(saleCustomer);
  }

  function completeSale(customerInfo) {
    const lineItems = cart.map((line) => ({
      productId: line.productId,
      sku: line.sku,
      name: line.name,
      // Store the price actually charged (base + code); keep the base + code for audit.
      price: effectiveLinePrice(line),
      basePrice: line.price,
      priceAdjust: parsePriceAdjust(line.adjustCode),
      qty: line.qty,
      imei: line.imei,
      requiresImei: line.requiresImei,
      category: line.category,
    }));
    const itemsText = cart
      .map((line) => `${line.qty}x ${line.name}${line.imei ? ` (IMEI ${line.imei})` : ""}`)
      .join(", ");
    const phoneLine = cart.find((line) => line.requiresImei && line.imei);
    const sale = {
      id: crypto.randomUUID(),
      receiptCode: generateReceiptCode(),
      type: "sale",
      source: "pos",
      servedBy: activeEmployee,
      location: activeLocation,
      customerPhone: customerPhone.trim(),
      paymentAmount: total.toFixed(2),
      paymentMethod: payments.length > 1
        ? payments.map((entry) => entry.method).join(" + ")
        : paymentMethod,
      notes: notes.trim(),
      createdAt: new Date().toISOString(),
      details: {
        request: "POS sale",
        productType: cart.every((line) => line.isCustom)
          ? "Custom"
          : cart.length === 1
            ? cart[0].category || "Item"
            : "Mixed",
        location: activeLocation,
        itemsText,
        model: cart.length === 1 ? cart[0].name : itemsText,
        imei: phoneLine?.imei || "",
        itemCount,
        lineItems,
        subtotal: subtotal.toFixed(2),
        taxRate,
        taxAmount: taxAmount.toFixed(2),
        outOfState: outOfState ? "Yes" : "No",
        payments,
        storeAddress: activeStoreInfo?.address || "",
        storeHours: activeStoreInfo?.hours || "",
        customerName: customerInfo?.name || "",
        customerMobile: customerInfo?.mobile || "",
        customerAddress: customerInfo?.address || "",
        customerEmail: customerInfo?.email || "",
        cardStatus: requiresCardCharge ? card.status : "",
        solaRefNum: requiresCardCharge ? card.refNum : "",
      },
    };
    onCompleteSale(sale);
    setCompletedSale(sale);
    setCart([]);
    setCustomerPhone("");
    setNotes("");
    setPaymentMethod("");
    setSplitPayment(false);
    setSplitSecondMethod("");
    setSplitFirstInput("");
    setOutOfState(false);
    setCard({ status: "idle", message: "", refNum: "" });
    setMessage("");
  }

  function startNewSale() {
    setCompletedSale(null);
    setCard({ status: "idle", message: "", refNum: "" });
    setMessage("Ready for the next customer.");
    setTimeout(() => scanRef.current?.focus(), 0);
  }

  return (
    <div className="pos-page">
      <section className="workspace pos-hero pos-hero-compact">
        <div className="pos-hero-top">
          <div className="summary-strip">
            <span className="metric">Store <strong>{activeLocation || "Unassigned"}</strong></span>
            <span className="metric">Cashier <strong>{activeEmployee}</strong></span>
          </div>
          <div className="segmented-control scan-mode" role="tablist" aria-label="Entry mode">
            <button type="button" className={scanMode ? "selected" : ""} onClick={() => { setScanMode(true); scanRef.current?.focus(); }}>Scan</button>
            <button type="button" className={!scanMode ? "selected" : ""} onClick={() => { setScanMode(false); scanRef.current?.focus(); }}>Manual</button>
          </div>
        </div>
        <form className="pos-scan" onSubmit={handleScan}>
          <input
            ref={scanRef}
            className="pos-scan-input"
            value={scan}
            onChange={(event) => setScan(event.target.value)}
            placeholder={scanMode ? "Scan a barcode — it adds automatically" : "Type SKU / barcode, then press Enter"}
            inputMode="text"
            autoComplete="off"
            spellCheck={false}
          />
          {!scanMode ? <button className="primary-button" type="submit">Add</button> : null}
        </form>
        {message ? (
          <p className={`pos-message ${message.includes("Added") || message.includes("Ready") ? "pos-message-ok" : ""}`}>
            {message}
          </p>
        ) : null}
      </section>

      <div className="pos-body">
      <div className="pos-layout">
        {/* `is-searching` lets the results panel claim the height the cart isn't
            using; without it the list is capped short with dead space beneath. */}
        <div className={`pos-left${searching ? " is-searching" : ""}`}>
        <section className="history pos-cart">
          <div className="history-header">
            <div>
              <p className="eyebrow">Cart</p>
              <h2>{itemCount} item{itemCount === 1 ? "" : "s"}</h2>
            </div>
          </div>
          {cart.length ? (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Item</th>
                    <th>Price</th>
                    <th>Code</th>
                    <th>Qty</th>
                    <th>IMEI</th>
                    <th>Line</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {cart.map((line) => {
                    const adjust = parsePriceAdjust(line.adjustCode);
                    const unitPrice = effectiveLinePrice(line);
                    return (
                    <tr key={line.lineId}>
                      <td>
                        <strong>{line.name}</strong>
                        <p className="muted">{line.isCustom ? "Custom charge" : line.sku}</p>
                      </td>
                      <td>
                        {line.isCustom ? (
                          <input
                            className="pos-adjust"
                            type="number"
                            min="0.01"
                            step="0.01"
                            value={line.price}
                            onChange={(event) => updateCustomPrice(line.lineId, event.target.value)}
                          />
                        ) : (
                          <>
                            {formatMoney(line.price)}
                            {adjust ? <p className="muted">→ {formatMoney(unitPrice)}</p> : null}
                          </>
                        )}
                      </td>
                      <td>
                        {line.isCustom ? (
                          <span className="muted">—</span>
                        ) : (
                        <input
                          className="pos-adjust"
                          value={line.adjustCode}
                          onChange={(event) => updateAdjust(line.lineId, event.target.value)}
                          placeholder="+/- $"
                          inputMode="text"
                          autoComplete="off"
                          spellCheck={false}
                        />
                        )}
                      </td>
                      <td>
                        {line.requiresImei ? (
                          <span className="muted">1</span>
                        ) : (
                          <input
                            className="pos-qty"
                            type="number"
                            min="1"
                            value={line.qty}
                            onChange={(event) => updateQty(line.lineId, event.target.value)}
                          />
                        )}
                      </td>
                      <td>
                        {line.requiresImei ? (
                          <input
                            className={`pos-imei ${imeiLineStatus(line) === "ok" ? "" : "pos-imei-missing"}`}
                            value={line.imei}
                            onChange={(event) => updateImei(line.lineId, event.target.value)}
                            placeholder="Scan IMEI"
                            inputMode="numeric"
                            autoComplete="off"
                            spellCheck={false}
                          />
                        ) : (
                          <span className="muted">-</span>
                        )}
                      </td>
                      <td>{formatMoney(unitPrice * line.qty)}</td>
                      <td className="pos-row-actions">
                        {!line.isCustom && onSaveProduct ? (
                          <button
                            className="secondary-button compact-button"
                            type="button"
                            onClick={() => {
                              const product = products.find((item) => item.id === line.productId);
                              if (product) setRestock(product);
                              else setMessage("This item isn't in inventory, so it can't be restocked.");
                            }}
                          >
                            Restock
                          </button>
                        ) : null}
                        <button className="secondary-button compact-button" type="button" onClick={() => removeLine(line.lineId)}>
                          Remove
                        </button>
                      </td>
                    </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="empty-state">Scan a product to start a sale.</p>
          )}
        </section>

        <section className="history pos-quick-panel">
          <div className="history-header">
            <div>
              <p className="eyebrow">Inventory</p>
              <h2>
                Find a product
                {searching ? <span className="pos-result-count">{quickAddProducts.length} found</span> : null}
              </h2>
            </div>
            <div className="pos-quick-actions">
              <input
                className="pos-search"
                value={productSearch}
                onChange={(event) => setProductSearch(event.target.value)}
                placeholder="Search name, SKU, or barcode"
                autoComplete="off"
                spellCheck={false}
              />
              <select
                className="pos-sort"
                value={sortMode}
                aria-label="Sort search results"
                onChange={(event) => setSortMode(event.target.value)}
              >
                <option value="used">Most used</option>
                <option value="price">Price: low to high</option>
                <option value="name">Name: A to Z</option>
              </select>
              {productSearch ? (
                <button
                  className="secondary-button compact-button"
                  type="button"
                  onClick={() => { setProductSearch(""); scanRef.current?.focus(); }}
                >
                  Clear
                </button>
              ) : null}
              <button className="secondary-button compact-button" type="button" onClick={() => setCustomAmountOpen(true)}>
                Custom item
              </button>
            </div>
          </div>
          <div className="pos-product-grid">
            {quickAddProducts.length ? (
              quickAddProducts.map((product) => {
                const stock = product.requiresImei ? product.imeis?.length || 0 : Number(product.quantity) || 0;
                // Colour-code the count so a cashier sees at a glance what is
                // running out, instead of reading a bare number.
                const level = stock <= 0 ? "out" : stock <= 3 ? "low" : "ok";
                const stockLabel = stock <= 0
                  ? "Out of stock"
                  : `${stock} in stock${product.requiresImei ? " · IMEI" : ""}`;
                return (
                  <div className={`pos-product-card level-${level}`} key={product.id}>
                    <button
                      className="pos-product"
                      type="button"
                      onClick={() => {
                        if (addProductToCart(product)) setMessage(`Added ${product.name}.`);
                        scanRef.current?.focus();
                      }}
                    >
                      <strong>{product.name}</strong>
                      <span>{formatMoney(Number(product.price) || 0)}</span>
                      <small className={`pos-product-stock level-${level}`}>{stockLabel}</small>
                    </button>
                    {onSaveProduct ? (
                      /* Restock without putting the item in the sale first. */
                      <button
                        className="pos-product-restock"
                        type="button"
                        title={`Add stock to ${product.name}`}
                        aria-label={`Add stock to ${product.name}`}
                        onClick={() => setRestock(product)}
                      >
                        +
                      </button>
                    ) : null}
                  </div>
                );
              })
            ) : (
              <p className="empty-state">
                {searching ? `No product matches "${productSearch.trim()}".` : "Type at least 2 letters to search the catalog."}
              </p>
            )}
          </div>
        </section>
        </div>

        <section className="workspace pos-checkout">
          <div className="workspace-header">
            <div>
              <p className="eyebrow">Checkout</p>
              <h2>{formatMoney(total)}</h2>
            </div>
          </div>
          <div className="pos-checkout-scroll">
          <div className="form-grid">
            <label className="field">
              <span>Customer phone</span>
              <CustomerPhoneInput
                value={customerPhone}
                onChange={setCustomerPhone}
                onSaveCustomerName={onSaveCustomerName}
                onSaveCustomer={onSaveCustomer}
                onResolveCustomer={setResolvedCustomer}
                onSelectCustomer={(customer) => { setCustomerPhone(customer.phone); setResolvedCustomer(customer); }}
                placeholder="Optional — search or add customer"
              />
            </label>
            {saleCustomer?.name ? (
              <p className="pos-customer-name">{saleCustomer.name}</p>
            ) : null}
            <label className="field">
              <span>Payment method</span>
              <select value={paymentMethod} onChange={(event) => setPaymentMethod(event.target.value)}>
                <option value="" disabled>Select one</option>
                {paymentMethods.map((method) => (
                  <option key={method}>{method}</option>
                ))}
              </select>
            </label>
            <label className="checkbox-field full pos-split-toggle">
              <input
                type="checkbox"
                checked={splitPayment}
                onChange={(event) => {
                  setSplitPayment(event.target.checked);
                  if (!event.target.checked) { setSplitSecondMethod(""); setSplitFirstInput(""); }
                }}
              />
              <span>Split between two payment methods</span>
            </label>
            {splitPayment ? (
              <div className="pos-split full">
                <label className="field">
                  <span>
                    {paymentMethod || "First method"} amount
                    {splitTaxOnCardOnly ? <small className="muted"> (before tax)</small> : null}
                  </span>
                  <input
                    inputMode="decimal"
                    placeholder="0.00"
                    value={splitFirstInput}
                    onChange={(event) => setSplitFirstInput(event.target.value)}
                  />
                </label>
                <label className="field">
                  <span>Second method</span>
                  <select value={splitSecondMethod} onChange={(event) => setSplitSecondMethod(event.target.value)}>
                    <option value="" disabled>Select one</option>
                    {paymentMethods.filter((method) => method !== paymentMethod).map((method) => (
                      <option key={method}>{method}</option>
                    ))}
                  </select>
                </label>
                <p className="pos-split-remainder">
                  <span>{splitSecondMethod || "Second method"}</span>
                  <strong>{formatMoney(splitSecondAmount)}</strong>
                </p>
                {splitTaxOnCardOnly && taxApplies ? (
                  <p className="pos-split-note muted">
                    Sales tax ({taxRate}%) is charged on the {firstIsCard ? paymentMethod : splitSecondMethod} share
                    only — {formatMoney(taxAmount)} on {formatMoney(taxBase)}.
                  </p>
                ) : null}
              </div>
            ) : null}
            <label className="field full">
              <span>Notes (optional)</span>
              <textarea value={notes} onChange={(event) => setNotes(event.target.value)} rows={1} />
            </label>
          </div>

          <div className="pos-totals">
            <div className="pos-totals-row pos-totals-sub"><span>Subtotal</span><span>{formatMoney(subtotal)}</span></div>
            <label className="checkbox-field pos-out-of-state">
              <input type="checkbox" checked={outOfState} onChange={(event) => setOutOfState(event.target.checked)} />
              <span>Out of state (no sales tax)</span>
            </label>
            <div className="pos-totals-row pos-totals-tax">
              <span>Tax{taxApplies ? ` (${taxRate}%${splitTaxOnCardOnly ? " · card share" : ""})` : ""}</span>
              <span>{formatMoney(taxAmount)}</span>
            </div>
            {!outOfState && taxRate === 0 ? (
              <p className="muted">No tax rate set for this store. Add the store address in Inventory.</p>
            ) : null}
            <div className="pos-totals-row pos-totals-grand"><span>Grand total</span><strong>{formatMoney(total)}</strong></div>
          </div>
          </div>
          <div className="pos-checkout-actions">
            {requiresCardCharge ? (
              <div className="payment-panel payment-panel-stack payment-panel-compact">
                <div className="card-reader-row">
                  <span className="reader-dot connected" aria-hidden="true" />
                  <span className="muted">Verifone P200 · charge {formatMoney(cardAmount)}</span>
                </div>
                <button
                  className="secondary-button"
                  type="button"
                  onClick={chargeCard}
                  disabled={!total || card.status === "charging" || card.status === "paid"}
                >
                  {card.status === "paid"
                    ? "Card charged ✓"
                    : card.status === "charging"
                      ? "Waiting for card…"
                      : "Charge card (tap / dip / swipe)"}
                </button>
                {card.message ? (
                  <p className={card.status === "error" ? "summary-error" : "muted"}>{card.message}</p>
                ) : null}
              </div>
            ) : null}
            {imeiIssue ? <p className="pos-warning">{imeiIssue}</p> : null}
            {!imeiIssue && splitIssue ? <p className="pos-warning">{splitIssue}</p> : null}
            {!imeiIssue && !splitIssue && requiresCardCharge && !cardChargeComplete ? (
              <p className="pos-warning">Charge the card before completing the sale.</p>
            ) : null}
            <button className="primary-button pos-complete-button" type="button" disabled={!canCheckout} onClick={handleCheckout}>
              {cart.length ? `Complete sale · ${formatMoney(total)}` : "Scan items to start"}
            </button>
          </div>
        </section>
      </div>
      </div>

      {customAmountOpen ? (
        <CustomAmountDialog
          onAdd={(amount, name) => {
            if (addCustomItemToCart(amount, name)) {
              setCustomAmountOpen(false);
              scanRef.current?.focus();
            }
          }}
          onClose={() => setCustomAmountOpen(false)}
        />
      ) : null}

      {completedSale ? (
        <SaleReceiptDialog sale={completedSale} onClose={startNewSale} />
      ) : null}

      {restock ? (
        <RestockDialog
          product={restock}
          storeLocations={storeLocations}
          onClose={() => setRestock(null)}
          onAddStock={(payload) => {
            addStock(restock, payload);
            setRestock(null);
            scanRef.current?.focus();
          }}
        />
      ) : null}
    </div>
  );
}

// Google-backed address field: type a street address, pick a suggestion to fill
// it in, and add a unit/apt number separately (Google rarely captures the unit).
// Emits a single combined address string so every existing consumer is unchanged.
function AddressAutocomplete({ value, onChange, autoFocus }) {
  const [base, setBase] = useState(value || "");
  const [unit, setUnit] = useState("");
  const [suggestions, setSuggestions] = useState([]);
  const [open, setOpen] = useState(false);
  const sessionTokenRef = useRef(crypto.randomUUID());
  const skipNextFetchRef = useRef(false);
  const boxRef = useRef(null);

  function combine(nextBase, nextUnit) {
    const trimmedBase = nextBase.trim();
    const trimmedUnit = nextUnit.trim();
    return trimmedUnit ? `${trimmedBase}, ${trimmedUnit}` : trimmedBase;
  }

  // Debounced lookup as the street address is typed (skipped right after we fill
  // the field from a chosen suggestion, so it doesn't immediately re-query).
  useEffect(() => {
    if (skipNextFetchRef.current) {
      skipNextFetchRef.current = false;
      return;
    }
    const query = base.trim();
    if (query.length < 3) {
      setSuggestions([]);
      setOpen(false);
      return;
    }
    let cancelled = false;
    const handle = setTimeout(async () => {
      try {
        const result = await callFunction("placesAutocomplete", {
          input: query,
          sessionToken: sessionTokenRef.current,
        });
        if (cancelled) return;
        const items = result?.suggestions || [];
        setSuggestions(items);
        setOpen(items.length > 0);
      } catch {
        if (!cancelled) {
          setSuggestions([]);
          setOpen(false);
        }
      }
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [base]);

  useEffect(() => {
    function onDocMouseDown(event) {
      if (boxRef.current && !boxRef.current.contains(event.target)) setOpen(false);
    }
    document.addEventListener("mousedown", onDocMouseDown);
    return () => document.removeEventListener("mousedown", onDocMouseDown);
  }, []);

  async function selectSuggestion(suggestion) {
    let line = suggestion.description;
    try {
      const details = await callFunction("placeDetails", {
        placeId: suggestion.placeId,
        sessionToken: sessionTokenRef.current,
      });
      const composed = [
        details.street,
        details.city,
        [details.state, details.zip].filter(Boolean).join(" "),
      ]
        .filter(Boolean)
        .join(", ");
      if (composed) line = composed;
    } catch {
      // Fall back to the suggestion text if details lookup fails.
    }
    skipNextFetchRef.current = true;
    setBase(line);
    setSuggestions([]);
    setOpen(false);
    sessionTokenRef.current = crypto.randomUUID();
    onChange(combine(line, unit));
  }

  return (
    <>
      <label className="field full address-autocomplete" ref={boxRef}>
        <span>Address</span>
        <input
          value={base}
          autoFocus={autoFocus}
          autoComplete="off"
          placeholder="Start typing the street address"
          onChange={(event) => {
            setBase(event.target.value);
            onChange(combine(event.target.value, unit));
          }}
          onFocus={() => {
            if (suggestions.length) setOpen(true);
          }}
        />
        {open ? (
          <ul className="address-suggestions">
            {suggestions.map((suggestion) => (
              <li key={suggestion.placeId}>
                <button
                  type="button"
                  onMouseDown={(event) => {
                    event.preventDefault();
                    selectSuggestion(suggestion);
                  }}
                >
                  {suggestion.description}
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </label>
      <label className="field">
        <span>Unit / Apt # (optional)</span>
        <input
          value={unit}
          placeholder="e.g. Apt 4B"
          onChange={(event) => {
            setUnit(event.target.value);
            onChange(combine(base, event.target.value));
          }}
        />
      </label>
    </>
  );
}

// Enter a one-off charge that prints on the receipt as Custom item.
function CustomAmountDialog({ onAdd, onClose }) {
  const [amount, setAmount] = useState("");
  const [name, setName] = useState("");

  function submit(event) {
    event.preventDefault();
    event.stopPropagation();
    onAdd(amount, name);
  }

  return createPortal(
    <div className="dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <div className="dialog-card" role="dialog" aria-modal="true" onMouseDown={(event) => event.stopPropagation()}>
        <div className="dialog-head">
          <div>
            <h2>Custom item</h2>
            <p className="muted">Enter an item name and amount. The receipt lists the name you enter (or “Custom item” if left blank).</p>
          </div>
          <DialogCloseButton onClose={onClose} label="Close custom item" />
        </div>
        <form className="form-grid" onSubmit={submit}>
          <label className="field">
            <span>Item name</span>
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              autoFocus
              placeholder="Custom item"
            />
          </label>
          <label className="field">
            <span>Amount</span>
            <input
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              inputMode="decimal"
              placeholder="0.00"
            />
          </label>
          <div className="pos-form-actions form-actions-row">
            <button className="primary-button" type="submit">Add to cart</button>
            <button className="secondary-button" type="button" onClick={onClose}>Cancel</button>
          </div>
        </form>
      </div>
    </div>,
    document.body,
  );
}

// Prompt shown at checkout when the entered phone is a new customer or is missing
// a name / address — captures those for the receipt and the CRM.
function CustomerInfoDialog({ phone, customer, onSave, onSkip, onClose, saveLabel = "Save customer" }) {
  const isNew = !customer?.name && !customer?.address;
  const [name, setName] = useState(customer?.name || "");
  const [mobile, setMobile] = useState(customer?.mobile || "");
  const [address, setAddress] = useState(customer?.address || "");
  const [email, setEmail] = useState(customer?.email || "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  // Every field here is optional — nothing in this dialog blocks a sale or an
  // order; it only captures what the cashier has for the receipt and the CRM.
  async function submit(event) {
    event.preventDefault();
    // Stop the submit from bubbling (through React's portal tree) to any parent
    // report/order form, which would otherwise also fire its own submit.
    event.stopPropagation();
    if (saving) return;
    // onSave may write to the CRM before it returns; block a second submit until
    // it settles, so one click can't file two records.
    setSaving(true);
    setError("");
    try {
      await onSave({ name, mobile, address, email });
    } catch (saveError) {
      // A rejected save used to escape unhandled, which left the dialog sitting
      // open with no explanation and nothing written — the "add customer doesn't
      // save" report. Say what went wrong and let them try again.
      setError(saveError?.message || "Could not save this customer. Check the connection and try again.");
    } finally {
      setSaving(false);
    }
  }

  // Rendered through a portal so the dialog's <form> is never nested inside the
  // parent report/order form. Nested forms make the browser submit the outer
  // form instead — which skips this dialog's save and reloads the app.
  return createPortal(
    <div className="dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <div className="dialog-card" role="dialog" aria-modal="true" onMouseDown={(event) => event.stopPropagation()}>
        <div className="dialog-head">
          <div>
            <h2>{isNew ? "Add customer" : "Complete customer details"}</h2>
            <p className="muted">
              {isNew
                ? `${phone} isn't in the CRM yet. Add whatever you have — all of it is optional.`
                : `${phone} is missing some details. Add them for the receipt and follow-up.`}
            </p>
          </div>
          <DialogCloseButton onClose={onClose} label="Close customer details" />
        </div>
        <form className="form-grid" onSubmit={submit}>
          <label className="field"><span>Phone</span><input value={phone} disabled /></label>
          <label className="field">
            <span>Name (optional)</span>
            <input value={name} onChange={(event) => setName(event.target.value)} autoFocus />
          </label>
          <label className="field"><span>Mobile (optional)</span><input value={mobile} inputMode="tel" onChange={(event) => setMobile(event.target.value)} /></label>
          {/* Captured here so emailing a receipt doesn't mean re-typing the
              address at the till every single time. */}
          <label className="field">
            <span>Email (optional)</span>
            <input type="email" value={email} autoComplete="off" placeholder="customer@example.com" onChange={(event) => setEmail(event.target.value)} />
          </label>
          <AddressAutocomplete value={address} onChange={setAddress} />
          {error ? <p className="form-error" role="alert">{error}</p> : null}
          <div className="pos-form-actions form-actions-row">
            <button className="primary-button" type="submit" disabled={saving}>
              {saving ? "Saving..." : saveLabel}
            </button>
            {onSkip ? <button className="secondary-button" type="button" onClick={onSkip}>Skip</button> : null}
            <button className="secondary-button" type="button" onClick={onClose}>Cancel</button>
          </div>
        </form>
      </div>
    </div>,
    document.body,
  );
}

// Shared 80mm thermal receipt styling — smaller type with generous vertical spacing.
const THERMAL_BASE_CSS = `
  @page { size: 80mm auto; margin: 0; }
  html, body { margin: 0; }
  body { width: 80mm; box-sizing: border-box; padding: 4mm 2.5mm 6mm; color: #000;
    font-family: ui-sans-serif, system-ui, "Segoe UI", Arial, sans-serif;
    font-size: 14px; line-height: 1.65; font-weight: 400;
    -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .receipt-logo { display: block; width: 68mm; max-width: 68mm; max-height: 52px; margin: 0 auto 4mm; object-fit: contain;
    filter: grayscale(1) brightness(0); }
  table { width: 100%; border-collapse: collapse; font-size: 14px; }
  td { padding: 3.5mm 0; vertical-align: top; }
  td:first-child { width: 100%; font-weight: 400; line-height: 1.55; }
  td:last-child { text-align: right; white-space: nowrap; font-weight: 500; padding-left: 2mm; }
  .meta { font-size: 12px; text-align: center; font-weight: 400; margin: 2mm 0; line-height: 1.55; }
  .divider { border-top: 1px dashed #000; margin: 5mm 0; }
  .contact { text-align: center; font-size: 12px; font-weight: 400; line-height: 1.6; margin-bottom: 2mm; }
  .store-name { text-align: center; font-weight: 600; font-size: 16px; margin-top: 2mm; line-height: 1.45; }
  .store-addr { text-align: center; font-size: 12px; font-weight: 400; line-height: 1.6; margin-top: 1.5mm; }
  .cust { text-align: left; margin-top: 4mm; line-height: 1.6; }
  .cust-name { font-size: 15px; font-weight: 600; margin-bottom: 2.5mm; }
  .cust-phone { font-size: 13px; font-weight: 400; margin-bottom: 2mm; }
  .cust-addr { font-size: 12px; font-weight: 400; margin-top: 0; line-height: 1.55; }
  .hours { text-align: center; font-size: 12px; font-weight: 400; margin-bottom: 3mm; line-height: 1.55; }
  .thanks { text-align: center; margin-top: 4mm; font-weight: 600; font-size: 14px; line-height: 1.5; }
  .feedback { text-align: center; font-size: 11px; font-weight: 400; margin-top: 3mm; line-height: 1.55; }
  .powered { text-align: center; font-size: 10px; margin-top: 4mm; color: #000; font-weight: 400; line-height: 1.5; }
  small { font-size: 11px; color: #000; font-weight: 400; line-height: 1.5; }
`;

// Totals, payment line, and barcode — shared by sale + phone-order receipts.
const THERMAL_CHECKOUT_CSS = `
  .line { display: flex; justify-content: space-between; align-items: baseline; gap: 2mm; margin: 2.5mm 0; line-height: 1.55; }
  .line-subtotal { font-size: 13px; font-weight: 400; }
  .line-tax { font-size: 13px; font-weight: 500; }
  .line-tax span:last-child { font-weight: 600; }
  .total { display: flex; justify-content: space-between; align-items: baseline; margin-top: 4mm; padding-top: 4mm; border-top: 1px solid #000; line-height: 1.5; }
  .total-grand { font-size: 16px; font-weight: 600; }
  .total-grand span:last-child { font-size: 17px; font-weight: 600; }
  .paid { font-size: 13px; font-weight: 500; text-align: center; margin-top: 4mm; line-height: 1.55; }
  .barcode { text-align: center; margin-top: 5mm; }
  .barcode svg { max-width: 92%; height: 40px; }
  .barcode-text { font-size: 11px; font-weight: 500; letter-spacing: 1.5px; margin-top: 2mm; }`;

// Shared receipt header: logo, company-wide contact, and the store's name + address.
function receiptHeaderHtml(storeName, storeAddress) {
  const logoUrl = `${window.location.origin}/logo.webp`;
  const storeBlock = (storeName || storeAddress)
    ? `<div class="store-name">${escapeHtml(storeName || "")}</div>${storeAddress ? `<div class="store-addr">${escapeHtml(storeAddress)}</div>` : ""}`
    : "";
  return `
    <img class="receipt-logo" src="${logoUrl}" alt="Diamant Telecom" onerror="this.style.display='none'" />
    <div class="contact">${escapeHtml(COMPANY.phone)} &middot; ${escapeHtml(COMPANY.web)}<br/>${escapeHtml(COMPANY.email)}</div>
    ${storeBlock}`;
}

// Shared receipt footer: store hours, thank-you, feedback, and credit.
function receiptFooterHtml(storeHours) {
  const hours = storeHours ? `<div class="hours">Hours: ${escapeHtml(storeHours)}</div>` : "";
  return `
    ${hours}
    <div class="thanks">Thank you for choosing Diamant Telecom!</div>
    <div class="feedback">Questions or feedback? Call our direct line ${escapeHtml(COMPANY.phone)} ext 9</div>
    <div class="powered">Powered by Advanced Automations · info@advancedautomations.net</div>`;
}

// Builds the customer block for a receipt from snapshotted details.
function receiptCustomerHtml(name, phone, mobile, address) {
  if (!name && !phone && !mobile && !address) return "";
  const phoneFormatted = formatReceiptPhone(phone);
  const mobileDigits = localPhoneDigits(mobile);
  const phoneDigits = localPhoneDigits(phone);
  const mobileFormatted = mobile && mobileDigits && mobileDigits !== phoneDigits
    ? formatReceiptPhone(mobile)
    : "";
  return `<div class="cust">
    ${name ? `<div class="cust-name">${escapeHtml(name)}</div>` : ""}
    ${phoneFormatted ? `<div class="cust-phone">${escapeHtml(phoneFormatted)}</div>` : ""}
    ${mobileFormatted ? `<div class="cust-phone">${escapeHtml(mobileFormatted)}</div>` : ""}
    ${address ? `<div class="cust-addr">${escapeHtml(address)}</div>` : ""}
  </div>`;
}

// Opens a hidden 80mm print window that prints immediately and closes itself.
// With the browser's default printer set to the thermal printer (and Chrome
// kiosk printing for no dialog at all), this is a true one-click receipt.
function openThermalReceipt(title, css, bodyHtml) {
  const printWindow = window.open("", "_blank", "width=360,height=640");
  if (!printWindow) {
    window.print();
    return;
  }
  printWindow.document.write(`<!doctype html><html><head><meta charset="utf-8" />
    <title>${escapeHtml(title)}</title>
    <style>${THERMAL_BASE_CSS}${css || ""}</style>
    </head>
    <body>${bodyHtml}
    <script>
      function closeReceipt(){ try { window.close(); } catch (e) {} }
      window.onafterprint = closeReceipt;
      window.onload = function () { window.focus(); window.print(); setTimeout(closeReceipt, 60000); };
    <\/script>
    </body></html>`);
  printWindow.document.close();
}

// Prints the sale receipt. Reused by the manual button and the auto-print on checkout.
function buildReceiptText(sale) {
  const details = sale.details || {};
  const soldAt = toJsDate(sale.createdAt) || new Date();
  const lines = (details.lineItems || []).map((line) => {
    const amount = formatMoney((Number(line.price) || 0) * (Number(line.qty) || 0));
    const imei = line.imei ? ` (IMEI ${line.imei})` : "";
    return `${line.qty}x ${line.name}${imei} - ${amount}`;
  });

  const payments = (details.payments || []).filter((entry) => entry?.method);
  const paidLines = payments.length > 1
    ? payments.map((entry) => `Paid by ${entry.method}: ${formatMoney(Number(entry.amount) || 0)}`)
    : [`Paid by ${sale.paymentMethod || "-"}`];

  const taxLabel = `Tax${details.taxRate ? ` (${details.taxRate}%)` : ""}`;
  const out = [
    `Diamant Telecom${details.location ? ` - ${details.location}` : ""}`,
    details.storeAddress || null,
    "",
    `Receipt ${sale.receiptCode || "-"}`,
    soldAt.toLocaleString(),
    sale.servedBy ? `Cashier: ${staffInitials(sale.servedBy)}` : null,
    details.customerName ? `Customer: ${details.customerName}` : null,
    "",
    ...lines,
    "",
    `Subtotal: ${formatMoney(Number(details.subtotal) || 0)}`,
    `${taxLabel}: ${formatMoney(Number(details.taxAmount) || 0)}`,
    `Total: ${formatMoney(Number(sale.paymentAmount) || 0)}`,
    ...paidLines,
    "",
    "Thank you for shopping at Diamant Telecom.",
  ];
  return out.filter((line) => line !== null).join("\n");
}

function printSaleReceipt(sale) {
  const details = sale.details || {};
  const lines = details.lineItems || [];
  const total = Number(sale.paymentAmount) || 0;
  const soldAt = toJsDate(sale.createdAt) || new Date();
  const location = details.location || sale.location || "";

  const rows = lines
    .map(
      (line) => `
        <tr>
          <td>${line.qty}x ${escapeHtml(line.name)}${line.imei ? `<br/><small>IMEI ${escapeHtml(line.imei)}</small>` : ""}</td>
          <td style="text-align:right">${formatMoney((Number(line.price) || 0) * (Number(line.qty) || 0))}</td>
        </tr>`,
    )
    .join("");

  const receiptCode = sale.receiptCode || "";
  const barcodeBlock = receiptCode
    ? `<div class="barcode">${code128Svg(receiptCode, { moduleWidth: 1.8, height: 40 })}<div class="barcode-text">${escapeHtml(receiptCode)}</div></div>`
    : "";

  const taxAmount = Number(details.taxAmount) || 0;
  const taxBlock = taxAmount > 0 || Number(details.subtotal) > 0
    ? `
    <div class="line line-subtotal"><span>Subtotal</span><span>${formatMoney(Number(details.subtotal) || 0)}</span></div>
    <div class="line line-tax"><span>Tax${details.taxRate ? ` (${details.taxRate}%)` : ""}</span><span>${formatMoney(taxAmount)}</span></div>`
    : "";

  const splitPayments = (details.payments || []).filter((entry) => entry?.method);
  const paidBlock = splitPayments.length > 1
    ? splitPayments
        .map((entry) => `<div class="line"><span>Paid by ${escapeHtml(entry.method)}</span><span>${formatMoney(Number(entry.amount) || 0)}</span></div>`)
        .join("")
    : `<div class="paid">Paid by ${escapeHtml(sale.paymentMethod || "-")}</div>`;

  const css = THERMAL_CHECKOUT_CSS;
  const customerBlock = receiptCustomerHtml(
    details.customerName,
    sale.customerPhone,
    details.customerMobile,
    details.customerAddress,
  );
  const body = `
    ${receiptHeaderHtml(location, details.storeAddress)}
    <div class="divider"></div>
    <div class="meta">${escapeHtml(soldAt.toLocaleString())} &middot; Cashier: ${escapeHtml(staffInitials(sale.servedBy) || "-")}</div>
    ${customerBlock}
    <div class="divider"></div>
    <table>${rows}</table>
    <div class="divider"></div>
    ${taxBlock}
    <div class="total total-grand"><span>Grand total</span><span>${formatMoney(total)}</span></div>
    ${paidBlock}
    ${barcodeBlock}
    <div class="divider"></div>
    ${receiptFooterHtml(details.storeHours)}`;

  openThermalReceipt("Receipt", css, body);
}

// Prints a phone-order receipt: items, totals, and a clear delivery block (the
// delivery address, kept separate from the customer's on-file address).
function printPhoneOrderReceipt(order) {
  const lines = order.lineItems || [];
  const total = Number(order.orderTotal) || 0;
  const createdAt = (toJsDate(order.createdAt) || new Date()).toLocaleString();
  const location = order.location || "";

  const rows = lines
    .map((line) => `
      <tr>
        <td>${line.qty}x ${escapeHtml(line.name)}${line.imei ? `<br/><small>IMEI ${escapeHtml(line.imei)}</small>` : ""}</td>
        <td style="text-align:right">${formatMoney((Number(line.price) || 0) * (Number(line.qty) || 0))}</td>
      </tr>`)
    .join("");

  const receiptCode = order.receiptCode || "";
  const barcodeBlock = receiptCode
    ? `<div class="barcode">${code128Svg(receiptCode, { moduleWidth: 1.8, height: 40 })}<div class="barcode-text">${escapeHtml(receiptCode)}</div></div>`
    : "";

  const taxAmount = Number(order.taxAmount) || 0;
  const taxBlock = taxAmount > 0 || Number(order.subtotal) > 0
    ? `
    <div class="line line-subtotal"><span>Subtotal</span><span>${formatMoney(Number(order.subtotal) || 0)}</span></div>
    <div class="line line-tax"><span>Tax${order.taxRate ? ` (${order.taxRate}%)` : ""}</span><span>${formatMoney(taxAmount)}</span></div>`
    : "";

  const css = `${THERMAL_CHECKOUT_CSS}
    .deliver { font-size: 17px; font-weight: 600; margin-top: 2mm; line-height: 1.35; }
    .deliver strong { display: block; font-size: 16px; font-weight: 800; margin-bottom: 1mm; }`;
  const customerBlock = receiptCustomerHtml(order.customerName, order.customerPhone, "", "");
  const deliverTo = order.deliveryAddress || order.address || "-";
  const onFile = (order.address || "").trim();
  // Show the on-file customer address too when the delivery address differs.
  const onFileLine = onFile && onFile !== (order.deliveryAddress || "").trim()
    ? `<div class="deliver"><strong>Customer address:</strong>${escapeHtml(onFile)}</div>`
    : "";
  const deliverBlock = `${onFileLine}<div class="deliver"><strong>Deliver to:</strong>${escapeHtml(deliverTo)}</div>`;
  const body = `
    ${receiptHeaderHtml(location, order.storeAddress)}
    <div class="divider"></div>
    <div class="meta">${escapeHtml(createdAt)} &middot; Phone order</div>
    ${customerBlock}
    ${deliverBlock}
    <div class="meta">Handler: ${escapeHtml(staffInitials(order.assignedTo) || "-")}</div>
    <div class="divider"></div>
    <table>${rows}</table>
    <div class="divider"></div>
    ${taxBlock}
    <div class="total total-grand"><span>Grand total</span><span>${formatMoney(total)}</span></div>
    <div class="paid">${escapeHtml(order.paymentStatus || "")}${order.paymentMethod ? ` · ${escapeHtml(order.paymentMethod)}` : ""}</div>
    ${barcodeBlock}
    <div class="divider"></div>
    ${receiptFooterHtml(order.storeHours)}`;

  openThermalReceipt(`Order ${receiptCode || ""}`, css, body);
}

// Prints a repair drop-off ticket with the generated ticket number.
// Prints a compact label to stick on the received phone: ticket number, who it
// belongs to, the device, and what's wrong with it. Companion to the full
// customer ticket below.
function printRepairPhoneLabel(report) {
  const details = report.details || {};
  const customer = [details.customerName, report.customerPhone].filter(Boolean).join(" · ");

  const css = `
    .eyebrow { text-align: center; font-size: 13px; font-weight: 700; text-transform: uppercase; letter-spacing: 1px; }
    .ticket { text-align: center; font-size: 30px; font-weight: 800; margin: 2mm 0; letter-spacing: 1px; }
    .who { text-align: center; font-size: 16px; font-weight: 700; }
    .row { font-size: 15px; font-weight: 600; margin: 1mm 0; }
    .row strong { display: inline-block; min-width: 14mm; font-weight: 800; }
    .issue { font-size: 17px; font-weight: 800; margin-top: 2mm; }
    .pin { font-size: 20px; font-weight: 800; margin-top: 2mm; letter-spacing: 1px; }`;
  const body = `
    <div class="eyebrow">Repair — stick on phone</div>
    <div class="ticket">${escapeHtml(details.ticketNumber || "")}</div>
    ${customer ? `<div class="who">${escapeHtml(customer)}</div>` : ""}
    <div class="divider"></div>
    ${details.model ? `<div class="row"><strong>Model</strong> ${escapeHtml(details.model)}</div>` : ""}
    ${details.imei ? `<div class="row"><strong>IMEI</strong> ${escapeHtml(details.imei)}</div>` : ""}
    ${details.damage ? `<div class="issue">Issue: ${escapeHtml(details.damage)}</div>` : ""}
    ${details.devicePin ? `<div class="pin">PIN: ${escapeHtml(details.devicePin)}</div>` : ""}`;

  openThermalReceipt(`Repair label ${details.ticketNumber || ""}`, css, body);
}

function printRepairTicket(report) {
  const details = report.details || {};
  const createdAt = (toJsDate(report.createdAt) || new Date()).toLocaleString();
  const location = report.location || details.location || "";

  const estimatedPrice = details.estimatedPrice || report.paymentAmount;
  const rowsSource = [
    ["Phone", report.customerPhone],
    ["Model", details.model],
    ["IMEI", details.imei],
    ["Issue", details.damage],
    // Extra jobs agreed after intake print under the original issue.
    ...(details.additionalFixes || [])
      .filter((fix) => fix?.description || fix?.price)
      .map((fix) => [
        "Also fixing",
        `${fix.description || "Fix"}${fix.price ? ` - ${formatMoney(Number(fix.price) || 0)}` : ""}`,
      ]),
    ["Estimated price", estimatedPrice ? formatMoney(Number(estimatedPrice) || 0) : ""],
    ["Final price", details.finalPrice ? formatMoney(Number(details.finalPrice) || 0) : ""],
    ["SIM in phone", details.hadSim ? "Yes" : ""],
    ["SD card in phone", details.hadSdCard ? "Yes" : ""],
    ["Loaner phone given", details.borrowedTempPhone ? "Yes" : ""],
    ["Paid", details.paymentStatus],
    ["Expected ready", details.dueDate],
    ["Notify by", details.notificationPreference],
    ["Served by", staffInitials(report.servedBy)],
  ];
  const rows = rowsSource
    .filter(([, value]) => value)
    .map(([label, value]) => `<tr><td>${escapeHtml(label)}</td><td style="text-align:right">${escapeHtml(String(value))}</td></tr>`)
    .join("");

  const css = `
    .eyebrow { text-align: center; font-size: 14px; font-weight: 700; text-transform: uppercase; letter-spacing: 1px; }
    .ticket { text-align: center; font-size: 28px; font-weight: 800; margin: 2mm 0; letter-spacing: 1px; }
    .notes { font-size: 14px; font-weight: 600; margin-top: 3mm; line-height: 1.35; }`;
  const body = `
    ${receiptHeaderHtml(location, details.storeAddress)}
    <div class="divider"></div>
    <div class="eyebrow">Repair ticket</div>
    <div class="ticket">${escapeHtml(details.ticketNumber || "")}</div>
    <div class="meta">${escapeHtml(createdAt)}</div>
    ${receiptCustomerHtml(details.customerName, report.customerPhone, details.customerMobile, details.customerAddress)}
    <div class="divider"></div>
    <table>${rows}</table>
    ${report.notes ? `<div class="notes">Notes: ${escapeHtml(report.notes)}</div>` : ""}
    <div class="divider"></div>
    <div class="thanks">Keep this ticket for pickup.</div>
    ${receiptFooterHtml(details.storeHours)}`;

  openThermalReceipt(`Repair ticket ${details.ticketNumber || ""}`, css, body);
}

// Customer rental receipt: device + SIM, numbers, dates, total, return date and
// the overdue late fee. Printed right after the rental is saved/paid.
function printRentalReceipt(report) {
  const details = report.details || {};
  const createdAt = (toJsDate(report.createdAt) || new Date()).toLocaleString();
  const location = report.location || details.location || "";
  const lateFee = Number(details.lateFeeWeekly) || 0;
  const total = Number(details.totalPrice) || Number(report.paymentAmount) || 0;

  const rowsSource = [
    ["Rental ID", details.rentalId],
    ["Region", details.rentalRegion],
    ["Service", details.serviceType],
    ["Device", details.rentalType],
    ["Model", details.model],
    ["IMEI", details.imei],
    ["SIM", details.simNumber],
    ["Phone number", details.cli],
    ["US number", details.usDdi && String(details.usDdi).toLowerCase() !== "no" ? details.usDdi : ""],
    ["Start", details.startDate],
    ["End", details.endDate],
    ["Return by", details.returnDueDate || details.endDate],
    ["Rental days", details.totalDays],
    ["Rate", details.dailyRate ? `${formatMoney(Number(details.dailyRate))}/day` : details.pricingLabel],
    ["Late fee", lateFee > 0 ? `${formatMoney(lateFee)}/wk (${formatMoney(lateFee / 7)}/day overdue)` : ""],
    ["Served by", staffInitials(report.servedBy)],
  ];
  const rows = rowsSource
    .filter(([, value]) => value)
    .map(([label, value]) => `<tr><td>${escapeHtml(label)}</td><td style="text-align:right">${escapeHtml(String(value))}</td></tr>`)
    .join("");

  const css = `
    .eyebrow { text-align: center; font-size: 14px; font-weight: 700; text-transform: uppercase; letter-spacing: 1px; }
    .total { display: flex; justify-content: space-between; font-weight: 800; font-size: 22px; margin-top: 2mm; }
    .paid { text-align: center; font-size: 15px; font-weight: 700; margin-top: 2mm; }
    .notes { font-size: 14px; font-weight: 600; margin-top: 3mm; line-height: 1.35; }`;
  const body = `
    ${receiptHeaderHtml(location, details.storeAddress)}
    <div class="divider"></div>
    <div class="eyebrow">Phone rental</div>
    <div class="meta">${escapeHtml(createdAt)}</div>
    ${receiptCustomerHtml(details.customerName, report.customerPhone, details.customerMobile, details.customerAddress)}
    <div class="divider"></div>
    <table>${rows}</table>
    <div class="divider"></div>
    <div class="total"><span>Total</span><span>${formatMoney(total)}</span></div>
    <div class="paid">${escapeHtml(report.paymentMethod || "")}${details.maskedCardNumber ? ` · ${escapeHtml(details.maskedCardNumber)}` : ""}</div>
    ${report.notes ? `<div class="notes">Notes: ${escapeHtml(report.notes)}</div>` : ""}
    <div class="divider"></div>
    <div class="thanks">Please return by ${escapeHtml(details.returnDueDate || details.endDate || "the due date")}.</div>
    ${receiptFooterHtml(details.storeHours)}`;

  openThermalReceipt(`Rental ${details.rentalId || report.id}`, css, body);
}

// Texts a receipt through Telebroad (same SMS line the repair notifications use).
async function sendReceiptSms(to, body) {
  const result = await callFunction("sendSaleReceiptSms", { to, body });
  if (!result?.sent) throw new Error(result?.detail || "The text could not be sent.");
  return result;
}

// Shown after a sale and again from any sale report. Nothing prints on its own —
// the cashier picks print, email or text.
function SaleReceiptDialog({ sale, onClose, reprint = false }) {
  const details = sale.details || {};
  const salePayments = (details.payments || []).filter((entry) => entry?.method);
  const lines = details.lineItems || [];
  const total = Number(sale.paymentAmount) || 0;
  const soldAt = toJsDate(sale.createdAt) || new Date();

  const [mode, setMode] = useState("");
  const [emailTo, setEmailTo] = useState(details.customerEmail || "");
  const [textTo, setTextTo] = useState(sale.customerPhone || "");
  const [sending, setSending] = useState(false);
  const [status, setStatus] = useState("");

  function printReceipt() {
    printSaleReceipt(sale);
    setStatus("Sent to the printer.");
  }

  // Opens Gmail's web compose in a new tab, pre-addressed and pre-filled, and
  // the cashier presses Send. A mailto: link was silently doing nothing on the
  // kiosk, which has no mail app for Windows to hand the link to.
  function emailReceipt() {
    const to = emailTo.trim();
    if (!to.includes("@")) {
      setStatus("Enter the customer's email address.");
      return;
    }
    const subject = `Diamant Telecom receipt ${sale.receiptCode || ""}`.trim();
    const body = buildReceiptText(sale);
    const compose = `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(to)}&su=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
    // Passing "noopener" in the feature string makes window.open return null even
    // on success, so the old check always took the failure branch and then threw
    // the register at a mailto: the kiosk can't handle — navigating the POS away
    // mid-sale. Open plainly (null now really does mean blocked) and sever the
    // opener reference by hand.
    const tab = window.open(compose, "_blank");
    if (tab) {
      try {
        tab.opener = null;
      } catch {
        /* cross-origin once Gmail loads; the reference is harmless either way */
      }
      setStatus(`Gmail opened for ${to} — press Send there.`);
      return;
    }
    // Genuinely blocked. Never navigate this tab: the receipt is the only copy of
    // a sale that just took money. Put it on the clipboard instead.
    copyReceipt("Pop-up blocked, so the receipt is copied — paste it into an email.");
  }

  // Backstop for when Gmail is unreachable: the whole receipt on the clipboard.
  async function copyReceipt(message) {
    try {
      await navigator.clipboard.writeText(buildReceiptText(sale));
      setStatus(message || "Receipt copied — paste it into an email.");
    } catch {
      setStatus("Couldn't copy the receipt. Print it instead.");
    }
  }

  // Plain text only — the receipt number and figures, never a picture.
  async function textReceipt() {
    const to = textTo.trim();
    if (localPhoneDigits(to).length < 10) {
      setStatus("Enter a 10-digit mobile number.");
      return;
    }
    setSending(true);
    setStatus("Sending...");
    try {
      await sendReceiptSms(to, buildReceiptText(sale));
      setStatus(`Receipt texted to ${to}.`);
    } catch (error) {
      setStatus(error.message || "The text could not be sent.");
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="dialog-backdrop" role="presentation">
      <div className="dialog-card receipt-card" role="dialog" aria-modal="true">
        <div className="dialog-head dialog-head-bare">
          <DialogCloseButton onClose={onClose} label="Close receipt" />
        </div>
        <img className="receipt-logo" src="/logo.webp" alt="Diamant Telecom" />
        <div className="receipt-success">
          <span className="receipt-check" aria-hidden="true">&#10003;</span>
          <div>
            <h3>{reprint ? `Receipt ${sale.receiptCode || ""}` : "Sale complete"}</h3>
            <p className="muted">{formatMoney(total)} paid by {sale.paymentMethod}</p>
            {salePayments.length > 1 ? (
              <p className="muted">
                {salePayments
                  .map((entry) => `${entry.method} ${formatMoney(Number(entry.amount) || 0)}`)
                  .join(" · ")}
              </p>
            ) : null}
          </div>
        </div>

        <div className="receipt-meta">
          <span><strong>Store:</strong> {details.location || "-"}</span>
          <span><strong>Cashier:</strong> {staffInitials(sale.servedBy) || "-"}</span>
          <span><strong>Time:</strong> {formatShortDate(sale.createdAt)}</span>
          {sale.customerPhone ? <span><strong>Customer:</strong> {sale.customerPhone}</span> : null}
        </div>

        <div className="receipt-lines">
          {lines.map((line, index) => (
            <div className="receipt-line" key={`${line.productId}-${index}`}>
              <div>
                <strong>{line.qty}x {line.name}</strong>
                {line.imei ? <small className="muted">IMEI {line.imei}</small> : null}
              </div>
              <span>{formatMoney((Number(line.price) || 0) * (Number(line.qty) || 0))}</span>
            </div>
          ))}
        </div>

        <div className="receipt-total">
          <span>Total</span>
          <strong>{formatMoney(total)}</strong>
        </div>

        <div className="receipt-delivery">
          <p className="eyebrow">Send this receipt</p>
          <div className="receipt-delivery-buttons">
            <button className="secondary-button" type="button" onClick={printReceipt}>Print</button>
            <button
              className={`secondary-button${mode === "email" ? " is-active" : ""}`}
              type="button"
              onClick={() => { setMode(mode === "email" ? "" : "email"); setStatus(""); }}
            >
              Email
            </button>
            <button
              className={`secondary-button${mode === "text" ? " is-active" : ""}`}
              type="button"
              onClick={() => { setMode(mode === "text" ? "" : "text"); setStatus(""); }}
            >
              Text
            </button>
          </div>

          {mode === "email" ? (
            <div className="receipt-delivery-row">
              <input
                type="email"
                value={emailTo}
                autoFocus
                placeholder="customer@example.com"
                onChange={(event) => setEmailTo(event.target.value)}
              />
              <button className="secondary-button" type="button" onClick={emailReceipt}>Open Gmail</button>
              <button className="secondary-button" type="button" onClick={() => copyReceipt()}>Copy receipt</button>
            </div>
          ) : null}

          {mode === "text" ? (
            <div className="receipt-delivery-row">
              <input
                inputMode="tel"
                value={textTo}
                autoFocus
                placeholder="Mobile number"
                onChange={(event) => setTextTo(event.target.value)}
              />
              <button className="secondary-button" type="button" onClick={textReceipt} disabled={sending}>
                {sending ? "Sending..." : "Send text"}
              </button>
            </div>
          ) : null}

          {status ? <p className="muted receipt-delivery-status">{status}</p> : null}
        </div>

        <div className="pos-form-actions">
          <button className="primary-button" type="button" onClick={onClose} autoFocus>
            {reprint ? "Close" : "New sale"}
          </button>
        </div>
      </div>
    </div>
  );
}

function ImeiLotCapture({ imeis, target, onChangeImeis, blocked = [] }) {
  const [entry, setEntry] = useState("");
  const [error, setError] = useState("");
  const [scanMode, setScanMode] = useState(true);
  const inputRef = useRef(null);

  const targetNum = Number(target) || 0;
  const reachedTarget = targetNum > 0 && imeis.length >= targetNum;

  function addImei() {
    const value = entry.replace(/\D/g, "");
    setEntry("");
    if (!value) return;
    if (blocked.includes(value)) {
      setError(`IMEI ${value} is already in this product's stock.`);
      inputRef.current?.focus();
      return;
    }
    if (imeis.includes(value)) {
      setError(`IMEI ${value} was already scanned in this lot.`);
      inputRef.current?.focus();
      return;
    }
    if (reachedTarget) {
      setError(`You already scanned ${targetNum} IMEIs. Increase the quantity to add more.`);
      inputRef.current?.focus();
      return;
    }
    onChangeImeis([...imeis, value]);
    setError("");
    inputRef.current?.focus();
  }

  function handleEntryKeyDown(event) {
    if (event.key === "Enter") {
      event.preventDefault();
      addImei();
    }
  }

  function removeImei(value) {
    onChangeImeis(imeis.filter((imei) => imei !== value));
  }

  return (
    <div className="field full imei-lot">
      <span>
        Scan an IMEI for each unit
        {targetNum > 0 ? ` (${targetNum} needed to match stock quantity)` : ""}
      </span>
      <div className="segmented-control scan-mode" role="tablist" aria-label="IMEI entry mode">
        <button type="button" className={scanMode ? "selected" : ""} onClick={() => { setScanMode(true); inputRef.current?.focus(); }}>Scan</button>
        <button type="button" className={!scanMode ? "selected" : ""} onClick={() => { setScanMode(false); inputRef.current?.focus(); }}>Manual</button>
      </div>
      <div className="imei-lot-scan">
        <label className="field">
          <span>{scanMode ? "Scan an IMEI — it adds automatically" : "Type an IMEI, then press Enter"}</span>
          <input
            ref={inputRef}
            value={entry}
            onChange={(event) => setEntry(event.target.value)}
            onKeyDown={handleEntryKeyDown}
            placeholder={scanMode ? "Scan IMEI" : "Type IMEI, then Enter"}
            inputMode="numeric"
            autoComplete="off"
            spellCheck={false}
            disabled={reachedTarget}
          />
        </label>
        {!scanMode ? (
          <button
            className="secondary-button align-end"
            type="button"
            onClick={addImei}
            disabled={reachedTarget}
          >
            Add IMEI
          </button>
        ) : null}
      </div>
      <p className="imei-lot-progress">
        {imeis.length} scanned{targetNum > 0 ? ` / ${targetNum}` : ""}
        {reachedTarget ? " — complete" : ""}
      </p>
      {targetNum > 0 ? (
        <div className="imei-progress-bar" role="progressbar" aria-valuenow={imeis.length} aria-valuemin={0} aria-valuemax={targetNum}>
          <div
            className="imei-progress-fill"
            style={{ width: `${Math.min(100, (imeis.length / targetNum) * 100)}%` }}
          />
        </div>
      ) : null}
      {error ? <p className="pos-warning">{error}</p> : null}
      {imeis.length ? (
        <div className="imei-chip-list">
          {imeis.map((imei, index) => (
            <span className="imei-chip" key={imei}>
              <strong>{index + 1}.</strong> {imei}
              <button type="button" onClick={() => removeImei(imei)} aria-label={`Remove ${imei}`}>
                ×
              </button>
            </span>
          ))}
        </div>
      ) : (
        <p className="imei-lot-empty">Scan the first IMEI above to start this lot.</p>
      )}
    </div>
  );
}

function RestockDialog({ product, storeLocations, onClose, onAddStock }) {
  const requiresImei = Boolean(product.requiresImei);
  const needsBarcode = !product.barcode;
  const [quantity, setQuantity] = useState("0");
  const [imeis, setImeis] = useState([]);
  const [location, setLocation] = useState(product.location || "");
  const [barcode, setBarcode] = useState("");
  const stores = storeLocations || [];
  const currentStock = requiresImei ? product.imeis?.length || 0 : Number(product.quantity) || 0;

  function submit(event) {
    event.preventDefault();
    if (needsBarcode && !barcode.trim()) {
      window.alert("Add a barcode for this item before adding stock.");
      return;
    }
    if (!location) {
      window.alert("Choose which store this stock is going to.");
      return;
    }
    const target = Number(quantity) || 0;
    if (!target) {
      window.alert("Enter how many units to add.");
      return;
    }
    if (requiresImei && imeis.length !== target) {
      window.alert(`You are adding ${target} units but scanned ${imeis.length} IMEIs. Scan exactly ${target}.`);
      return;
    }
    onAddStock({ addQuantity: target, newImeis: imeis, location, barcode: barcode.trim() });
    onClose();
  }

  return (
    <div className="dialog-backdrop" role="presentation">
      <div className="dialog-card dialog-card-wide" role="dialog" aria-modal="true">
        <div className="dialog-head">
          <div>
            <p className="eyebrow">Add stock</p>
            <h3>{product.name}</h3>
            <p className="muted">In stock now: {currentStock}{requiresImei ? " IMEIs" : ""}</p>
          </div>
          <DialogCloseButton onClose={onClose} label="Close add stock" />
        </div>
        <form className="form-grid dialog-form" onSubmit={submit}>
          {needsBarcode ? (
            <label className="field full">
              <span>Barcode (required — this item has none)</span>
              <input
                value={barcode}
                onChange={(event) => setBarcode(event.target.value)}
                placeholder="Scan or type the item's barcode"
                autoComplete="off"
                spellCheck={false}
                autoFocus
              />
              <small className="muted">Add a barcode so this item can be scanned at POS and on orders.</small>
            </label>
          ) : null}
          <label className="field">
            <span>Add stock to store</span>
            {/* Stock always belongs to one store — there is no "all stores" option. */}
            <select value={location} onChange={(event) => setLocation(event.target.value)} required>
              <option value="" disabled>Select a store…</option>
              {stores.map((store) => (
                <option key={store}>{store}</option>
              ))}
            </select>
            {!product.location ? (
              <small className="muted">
                This item is currently stocked for all stores. Picking a store moves its existing {currentStock}{" "}
                unit{currentStock === 1 ? "" : "s"} to that store as well.
              </small>
            ) : null}
          </label>
          <label className="field">
            <span>Quantity to add</span>
            <input
              type="number"
              min="0"
              value={quantity}
              onChange={(event) => setQuantity(event.target.value)}
              autoFocus={!needsBarcode}
            />
          </label>
          {requiresImei ? (
            <ImeiLotCapture
              imeis={imeis}
              target={quantity}
              onChangeImeis={setImeis}
              blocked={product.imeis || []}
            />
          ) : null}
          <div className="pos-form-actions">
            <button className="primary-button" type="submit">Add to stock</button>
            <button className="secondary-button" type="button" onClick={onClose}>Cancel</button>
          </div>
        </form>
      </div>
    </div>
  );
}

// Store names are compared loosely (trimmed, case-folded) so a product row saved
// as "monsey " still counts toward the "Monsey" store instead of looking like
// stock at some unknown location.
function normalizeStoreKey(value) {
  return String(value || "").trim().toLowerCase();
}

function InventoryPage({
  products,
  storeLocations,
  sessionRole,
  onSaveProduct,
  onRemoveProduct,
  rentalPhones = [],
  onSaveRentalPhone,
  onReleaseRentalPhone,
  onRemoveRentalPhone,
}) {
  const isAdmin = sessionRole === "admin";
  const canDelete = isAdmin;
  const emptyForm = {
    id: "",
    sku: "",
    barcode: "",
    name: "",
    price: "",
    cost: "",
    category: productCategories[0],
    requiresImei: false,
    // No default store: picking one is deliberate, so stock can't quietly land at
    // whichever store happens to sort first. The last pick is carried over after a
    // save, so a run of adds at one store only asks once.
    location: "",
    quantity: "0",
    imeis: [],
  };
  const [form, setForm] = useState(emptyForm);
  const [search, setSearch] = useState("");
  const [restock, setRestock] = useState(null);
  const [selectedKey, setSelectedKey] = useState("");

  function updateField(name, value) {
    setForm((current) => ({ ...current, [name]: value }));
  }

  function addStock(product, { addQuantity, newImeis, location, barcode }) {
    const nextLocation = location === undefined ? product.location : location;
    // If the item had no barcode, the restock dialog collected one — save it too.
    const barcodePatch = barcode && !product.barcode ? { barcode: String(barcode).trim() } : {};
    if (product.requiresImei) {
      onSaveProduct({ ...product, location: nextLocation, ...barcodePatch, imeis: [...(product.imeis || []), ...newImeis] });
    } else {
      onSaveProduct({ ...product, location: nextLocation, ...barcodePatch, quantity: (Number(product.quantity) || 0) + addQuantity });
    }
  }

  function submit(event) {
    event.preventDefault();
    if (!form.sku.trim() || !form.name.trim()) {
      window.alert("SKU and name are required.");
      return;
    }
    if (!form.location) {
      window.alert("Pick the store this stock belongs to.");
      return;
    }
    if (form.requiresImei) {
      const target = Number(form.quantity) || 0;
      if (!target) {
        window.alert("Set a stock quantity, then scan that many IMEIs.");
        return;
      }
      if (form.imeis.length !== target) {
        window.alert(`Stock quantity is ${target} but you scanned ${form.imeis.length} IMEIs. Scan exactly ${target}.`);
        return;
      }
    }
    onSaveProduct(form);
    setForm({ ...emptyForm, location: form.location });
  }

  // Editing opens its own dialog (see the render below) instead of quietly
  // repurposing the "Add product" form at the top of the page — which meant
  // scrolling away from the item you clicked and left it unclear whether you
  // were adding or editing.
  function editProduct(product) {
    setForm({
      ...emptyForm,
      ...product,
      price: String(product.price ?? ""),
      cost: String(product.cost ?? ""),
      quantity: String(product.quantity ?? 0),
      imeis: product.imeis || [],
    });
    setSelectedKey("");
  }

  // Group per-store product rows up by item so we can show, in one popup, how
  // many of each item are in stock at every store along with its variants.
  //
  // Each group ends up with one `buckets` list that is the single source for the
  // popup: every current store (so a store with none of the item still shows a 0)
  // plus a bucket for anything the rows point at that isn't a current store — the
  // unassigned "All stores" rows, and stock stranded under a renamed or deleted
  // location. `total` is the sum of that same list, so the columns and the Total
  // are arithmetically incapable of disagreeing.
  const groups = useMemo(() => {
    const stores = [...new Set(storeLocations)];
    const storeSet = new Set(stores);
    // Store names match loosely, so a row saved as "monsey " lands in the
    // "Monsey" column instead of silently becoming its own orphan bucket.
    const canonicalByKey = new Map(stores.map((name) => [normalizeStoreKey(name), name]));

    const map = new Map();
    for (const product of products) {
      const key = String(product.sku || product.name || product.id).trim().toLowerCase();
      const stock = product.requiresImei ? product.imeis?.length || 0 : Number(product.quantity) || 0;
      const rawLocation = String(product.location || "").trim();
      const loc = rawLocation ? canonicalByKey.get(normalizeStoreKey(rawLocation)) ?? rawLocation : "";
      const group = map.get(key) || {
        key,
        name: product.name,
        sku: product.sku,
        category: product.category,
        requiresImei: Boolean(product.requiresImei),
        byStore: {},
        variants: [],
      };
      group.byStore[loc] = (group.byStore[loc] || 0) + stock;
      group.variants.push(product);
      if (!group.name && product.name) group.name = product.name;
      if (!group.sku && product.sku) group.sku = product.sku;
      if (!group.category && product.category) group.category = product.category;
      if (product.requiresImei) group.requiresImei = true;
      map.set(key, group);
    }

    for (const group of map.values()) {
      group.buckets = [
        ...stores.map((name) => ({ name, label: name, stock: group.byStore[name] || 0, orphan: false })),
        // Everything the rows point at that has no column above: "" (unassigned)
        // first, then any stranded location, so nothing can go uncounted.
        ...Object.keys(group.byStore)
          .filter((name) => !storeSet.has(name))
          .sort()
          .map((name) => ({
            name,
            label: name || "All stores",
            stock: group.byStore[name],
            orphan: Boolean(name),
          })),
      ];
      group.total = group.buckets.reduce((sum, bucket) => sum + bucket.stock, 0);
    }

    return Array.from(map.values()).sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")));
  }, [products, storeLocations]);

  const filteredGroups = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return [];
    return groups.filter((group) => {
      const haystack = [group.name, group.sku, group.category, ...group.variants.map((variant) => variant.barcode)]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return haystack.includes(query);
    });
  }, [groups, search]);

  const selectedGroup = selectedKey ? groups.find((group) => group.key === selectedKey) : null;

  // One definition of the product form, shown inline when adding and inside a
  // dialog when editing.
  const productForm = (
    <form className="form-grid inventory-form" onSubmit={submit} onKeyDown={preventEnterSubmit}>
      <p className="form-section-title">Product details</p>
      <label className="field">
        <span>SKU</span>
        <input
          value={form.sku}
          onChange={(event) => updateField("sku", event.target.value)}
          placeholder="Internal code"
          autoComplete="off"
          spellCheck={false}
          required
        />
      </label>
      <label className="field">
        <span>Barcode</span>
        <input
          value={form.barcode}
          onChange={(event) => updateField("barcode", event.target.value)}
          placeholder="Scan UPC / EAN (optional)"
          autoComplete="off"
          spellCheck={false}
        />
      </label>
      <label className="field">
        <span>Name</span>
        <input value={form.name} onChange={(event) => updateField("name", event.target.value)} required />
      </label>
      <label className="field">
        <span>Price</span>
        <input
          inputMode="decimal"
          value={form.price}
          onChange={(event) => updateField("price", event.target.value)}
          placeholder="0.00"
        />
      </label>
      {isAdmin ? (
        <label className="field">
          <span>Cost of goods</span>
          <input
            inputMode="decimal"
            value={form.cost}
            onChange={(event) => updateField("cost", event.target.value)}
            placeholder="0.00"
          />
        </label>
      ) : null}
      <label className="field">
        <span>Category</span>
        <select value={form.category} onChange={(event) => updateField("category", event.target.value)}>
          {productCategories.map((category) => (
            <option key={category}>{category}</option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>Store</span>
        {/* Stock always belongs to one store — there is no "all stores" option. */}
        <select value={form.location} onChange={(event) => updateField("location", event.target.value)} required>
          <option value="" disabled>Select a store…</option>
          {storeLocations.map((location) => (
            <option key={location}>{location}</option>
          ))}
        </select>
      </label>
      <p className="form-section-title">Stock</p>
      <label className="field">
        <span>Stock quantity</span>
        <input
          type="number"
          min="0"
          value={form.quantity}
          onChange={(event) => updateField("quantity", event.target.value)}
        />
      </label>
      <label className="field checkbox-field">
        <input
          type="checkbox"
          checked={form.requiresImei}
          onChange={(event) => updateField("requiresImei", event.target.checked)}
        />
        <span>Require IMEI scan at checkout (phones)</span>
      </label>
      {form.requiresImei ? (
        <ImeiLotCapture
          imeis={form.imeis}
          target={form.quantity}
          onChangeImeis={(next) => updateField("imeis", next)}
        />
      ) : null}
      <div className="pos-form-actions form-actions-row">
        <button className="primary-button" type="submit">{form.id ? "Save changes" : "Add product"}</button>
        {form.id ? (
          <button className="secondary-button" type="button" onClick={() => setForm(emptyForm)}>
            Cancel
          </button>
        ) : null}
      </div>
    </form>
  );

  return (
    <>
      {form.id ? null : (
        <section className="workspace">
          <div className="workspace-header">
            <div>
              <p className="eyebrow">Inventory</p>
              <h2>Add product</h2>
            </div>
          </div>
          {productForm}
        </section>
      )}

      {form.id ? (
        // No click-outside-to-close here: this form can hold a whole scanned IMEI
        // lot, and a stray click on the backdrop would throw it away. The form's
        // own Cancel button is the way out.
        <div className="dialog-backdrop" role="presentation">
          <div className="dialog-card inventory-edit-card" role="dialog" aria-modal="true">
            <div className="dialog-head">
              <div>
                <h2>Edit product</h2>
                <p className="muted">{form.name || form.sku}</p>
              </div>
              <DialogCloseButton onClose={() => setForm(emptyForm)} label="Close edit product" />
            </div>
            {productForm}
          </div>
        </div>
      ) : null}

      <section className="history">
        <div className="history-header">
          <div>
            <p className="eyebrow">Inventory</p>
            <h2>Search inventory</h2>
          </div>
          <input
            className="pos-search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search item, SKU, barcode"
          />
        </div>
        <p className="muted">Search the catalog, then open an item to see its stock per store.</p>
        {search.trim() ? (
          <div className="table-wrap catalog-table">
            <table>
              <thead>
                <tr>
                  <th>Item</th>
                  <th>SKU</th>
                  <th>Category</th>
                  <th>Total stock</th>
                  {isAdmin ? <th>Cost</th> : null}
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {filteredGroups.length ? (
                  filteredGroups.map((item) => (
                    <tr key={item.key}>
                      <td><strong>{item.name}</strong></td>
                      <td>{item.sku || "-"}</td>
                      <td>{item.category || "-"}</td>
                      <td><strong>{item.total}</strong></td>
                      {isAdmin ? (
                        <td>{formatMoney(Number(item.variants[0]?.cost) || 0)}</td>
                      ) : null}
                      <td className="pos-row-actions">
                        <button
                          className="secondary-button compact-button"
                          type="button"
                          onClick={() => setSelectedKey(item.key)}
                        >
                          View
                        </button>
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={isAdmin ? 6 : 5} className="empty-state">No matching items.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="empty-state">Start typing to search inventory.</p>
        )}
      </section>

      <RentalPhoneFleet
        phones={rentalPhones}
        isAdmin={isAdmin}
        onSavePhone={onSaveRentalPhone}
        onReleasePhone={onReleaseRentalPhone}
        onRemovePhone={onRemoveRentalPhone}
      />

      {selectedGroup ? (
        <ItemDetailsDialog
          group={selectedGroup}
          sessionRole={sessionRole}
          onClose={() => setSelectedKey("")}
          onRestock={(product) => {
            setSelectedKey("");
            setRestock(product);
          }}
          onEdit={editProduct}
          onDelete={canDelete ? onRemoveProduct : null}
        />
      ) : null}

      {restock ? (
        <RestockDialog
          product={restock}
          storeLocations={storeLocations}
          onClose={() => setRestock(null)}
          onAddStock={(payload) => addStock(restock, payload)}
        />
      ) : null}
    </>
  );
}

// The rental handset fleet: scan phones in one at a time to register them, then
// see at a glance which are on the shelf and which are out with a customer.
// Deliberately separate from `products` — these are lent, never sold.
function RentalPhoneFleet({ phones = [], isAdmin, onSavePhone, onReleasePhone, onRemovePhone }) {
  const [imei, setImei] = useState("");
  const [name, setName] = useState("");
  const [search, setSearch] = useState("");
  const [message, setMessage] = useState("");
  const imeiRef = useRef(null);

  const outCount = phones.filter((phone) => phone.status === RENTAL_PHONE_WITH_CUSTOMER).length;

  const visible = useMemo(() => {
    const query = search.trim().toLowerCase();
    const sorted = [...phones].sort((left, right) => String(left.name || "").localeCompare(String(right.name || "")));
    if (!query) return sorted;
    return sorted.filter((phone) =>
      [phone.name, phone.imei, phone.customerPhone].filter(Boolean).join(" ").toLowerCase().includes(query));
  }, [phones, search]);

  function addPhone(event) {
    event.preventDefault();
    const cleanImei = digitsOnly(imei);
    if (!cleanImei) { setMessage("Scan or type an IMEI."); return; }
    if (!name.trim()) { setMessage("Give the phone a name."); return; }
    if (phones.some((phone) => digitsOnly(phone.imei) === cleanImei)) {
      setMessage(`IMEI ${cleanImei} is already in the fleet.`);
      return;
    }
    onSavePhone?.({ name: name.trim(), imei: cleanImei });
    setMessage(`Added ${name.trim()} · ${cleanImei}.`);
    setImei("");
    // Keep the name so a run of identical handsets can be scanned back to back.
    imeiRef.current?.focus();
  }

  return (
    <section className="history">
      <div className="history-header">
        <div>
          <p className="eyebrow">Rental fleet</p>
          <h2>Phones &amp; IMEIs</h2>
        </div>
        <div className="summary-strip">
          <span className="metric">Total <strong>{phones.length}</strong></span>
          <span className="metric">In store <strong>{phones.length - outCount}</strong></span>
          <span className="metric">With customers <strong>{outCount}</strong></span>
        </div>
      </div>
      <p className="muted">
        Scan every phone you lend out so the shop always knows where each handset is. Phones added here are the ones
        offered when a rental issues a device.
      </p>

      <form className="form-grid inventory-form" onSubmit={addPhone} onKeyDown={preventEnterSubmit}>
        <label className="field">
          <span>IMEI</span>
          <input
            ref={imeiRef}
            value={imei}
            onChange={(event) => { setImei(event.target.value); setMessage(""); }}
            inputMode="numeric"
            autoComplete="off"
            spellCheck={false}
            placeholder="Scan the IMEI"
          />
        </label>
        <label className="field">
          <span>Phone name</span>
          <input
            value={name}
            onChange={(event) => { setName(event.target.value); setMessage(""); }}
            placeholder="e.g. Nokia 105 — blue"
          />
        </label>
        <div className="pos-form-actions form-actions-row">
          <button className="primary-button" type="submit">Add phone</button>
          {message ? <span className="muted">{message}</span> : null}
        </div>
      </form>

      <input
        className="pos-search"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        placeholder="Search by name, IMEI, or customer"
      />

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Phone</th>
              <th>IMEI</th>
              <th>Status</th>
              <th>With</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {visible.length ? visible.map((phone) => {
              const out = phone.status === RENTAL_PHONE_WITH_CUSTOMER;
              return (
                <tr key={phone.id}>
                  <td><strong>{phone.name}</strong></td>
                  <td>{phone.imei}</td>
                  <td>
                    <span className={`status-pill ${out ? "" : "returned"}`}>
                      {out ? RENTAL_PHONE_WITH_CUSTOMER : RENTAL_PHONE_IN_STORE}
                    </span>
                  </td>
                  <td>{out ? phone.customerPhone || "Customer" : "-"}</td>
                  <td className="pos-row-actions">
                    {out ? (
                      <button
                        className="secondary-button compact-button"
                        type="button"
                        onClick={() => onReleasePhone?.(phone.id)}
                      >
                        Mark back in store
                      </button>
                    ) : null}
                    {isAdmin ? (
                      <button
                        className="secondary-button compact-button"
                        type="button"
                        onClick={() => {
                          if (window.confirm(`Remove ${phone.name} (${phone.imei}) from the fleet?`)) onRemovePhone?.(phone.id);
                        }}
                      >
                        Remove
                      </button>
                    ) : null}
                  </td>
                </tr>
              );
            }) : (
              <tr>
                <td colSpan="5" className="empty-state">
                  {phones.length ? "No phones match that search." : "No phones in the fleet yet — scan one above."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// Popup showing one item's stock per store plus each per-store variant, with
// restock / edit / delete actions. Replaces the always-on inventory tables.
function ItemDetailsDialog({ group, sessionRole, onClose, onRestock, onEdit, onDelete }) {
  const isAdmin = sessionRole === "admin";
  const subtitle = [group.sku ? `SKU ${group.sku}` : "", group.category || "", group.requiresImei ? "IMEI tracked" : ""]
    .filter(Boolean)
    .join(" · ");
  // Stock sitting under a location that is no longer a store — a rename or a
  // delete left it behind. It counts toward the total, so call it out with the
  // name it's stranded under rather than letting it hide.
  const orphanBuckets = group.buckets.filter((bucket) => bucket.orphan && bucket.stock > 0);

  return (
    <div className="dialog-backdrop" role="presentation" onClick={onClose}>
      <div
        className="dialog-card dialog-card-wide"
        role="dialog"
        aria-modal="true"
        aria-labelledby="item-dialog-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="dialog-head">
          <div>
            <p className="eyebrow">Inventory</p>
            <h2 id="item-dialog-title">{group.name}</h2>
            {subtitle ? <p className="muted">{subtitle}</p> : null}
          </div>
          <DialogCloseButton onClose={onClose} label="Close item details" />
        </div>

        <div className="table-wrap catalog-table">
          <table>
            <thead>
              <tr>
                {group.buckets.map((bucket) => (
                  <th key={bucket.name} className={bucket.orphan ? "stock-orphan" : ""}>
                    {bucket.label}{bucket.orphan ? " ⚠" : ""}
                  </th>
                ))}
                <th>Total</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                {group.buckets.map((bucket) => (
                  <td key={bucket.name} className={bucket.orphan ? "stock-orphan" : ""}>{bucket.stock}</td>
                ))}
                <td><strong>{group.total}</strong></td>
              </tr>
            </tbody>
          </table>
        </div>

        {orphanBuckets.length ? (
          <p className="stock-orphan-note">
            ⚠ {orphanBuckets.map((bucket) => `"${bucket.label}"`).join(", ")}
            {orphanBuckets.length === 1 ? " is not a current store" : " are not current stores"} — this stock is
            counted in the total but belongs to a renamed or deleted location. Use Edit or Restock on the matching
            row below to move it to a real store.
          </p>
        ) : null}

        <div className="request-list">
          {group.variants.map((product) => {
            const stock = product.requiresImei ? product.imeis?.length || 0 : Number(product.quantity) || 0;
            return (
              <div className="request-row store-row" key={product.id}>
                <div>
                  <strong>{product.location || "All stores"}</strong>
                  <p className="muted">
                    {formatMoney(Number(product.price) || 0)}
                    {isAdmin ? ` · Cost ${formatMoney(Number(product.cost) || 0)}` : ""}
                    {" · "}{stock} in stock{product.requiresImei ? " · IMEI" : ""}
                  </p>
                </div>
                <div className="store-row-actions">
                  <button className="secondary-button compact-button" type="button" onClick={() => onRestock(product)}>
                    Restock
                  </button>
                  <button className="secondary-button compact-button" type="button" onClick={() => onEdit(product)}>
                    Edit
                  </button>
                  {onDelete ? (
                    <button className="secondary-button compact-button" type="button" onClick={() => onDelete(product.id)}>
                      Delete
                    </button>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>

        <div className="form-actions">
          <button className="secondary-button" type="button" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}

function AdminPage({
  employees,
  reports,
  notifications,
  resetRequests,
  orderHandlers,
  storeLocations,
  employeeLocations,
  storeDevices,
  storeTax,
  onMarkResetHandled,
  onResetPassword,
  onAddOrderHandler,
  onRemoveOrderHandler,
  onAddStoreLocation,
  onRemoveStoreLocation,
  onUpdateStoreInfo,
  onSetStoreDevice,
  onSetStoreTaxRate,
  onSetEmployeeLocation,
  onRemoveEmployee,
  onSyncName,
  onUnsyncName,
}) {
  const emptyStore = { name: "", street: "", city: "", state: "", zip: "", hours: "" };
  const [handlerForm, setHandlerForm] = useState({ name: "", phone: "", location: "" });
  const [newStore, setNewStore] = useState(emptyStore);
  const [editingStore, setEditingStore] = useState(null);
  const storeFormRef = useRef(null);

  function taxFor(name) {
    return (storeTax || []).find((entry) => entry?.name === name) || null;
  }

  function deviceFor(name) {
    return (storeDevices || []).find((entry) => entry?.name === name)?.deviceId || "";
  }

  function locationFor(name) {
    return (employeeLocations || []).find((entry) => entry?.name === name)?.location || "";
  }

  function editStore(location) {
    const tax = taxFor(location) || {};
    setNewStore({
      name: location,
      street: tax.street || "",
      city: tax.city || "",
      state: tax.state || "",
      zip: tax.zip || "",
      hours: tax.hours || "",
    });
    setEditingStore(location);
    requestAnimationFrame(() => {
      const node = storeFormRef.current;
      if (!node) return;
      node.scrollIntoView({ behavior: "smooth", block: "center" });
      const firstInput = node.querySelector("input:not([readonly])");
      if (firstInput) firstInput.focus();
    });
  }

  function cancelEditStore() {
    setNewStore(emptyStore);
    setEditingStore(null);
  }
  const activity = useMemo(() => {
    return employees.map((employee) => {
      const employeeReports = reports
        .filter((report) => report.servedBy === employee)
        .sort((left, right) => (toJsDate(right.createdAt)?.getTime() || 0) - (toJsDate(left.createdAt)?.getTime() || 0));
      const totals = employeeReports.reduce(
        (acc, report) => {
          acc.amount += Number.parseFloat(report.paymentAmount || "0") || 0;
          acc[report.type] += 1;
          return acc;
        },
        { amount: 0, call: 0, sale: 0, repair: 0, sim: 0, rental: 0, phoneOrder: 0, return: 0 },
      );
      const lastReport = employeeReports[0];
      return { employee, count: employeeReports.length, totals, lastReport };
    });
  }, [employees, reports]);

  // The audit trail shows only today's activity by default so it stays short.
  const todayStart = startOfDay(new Date()).getTime();
  const sortedReports = [...reports]
    .filter((report) => {
      const when = toJsDate(report.createdAt)?.getTime();
      return when != null && when >= todayStart;
    })
    .sort(
      (left, right) => (toJsDate(right.createdAt)?.getTime() || 0) - (toJsDate(left.createdAt)?.getTime() || 0),
    );

  function updateHandlerField(name, value) {
    setHandlerForm((current) => ({ ...current, [name]: value }));
  }

  function submitHandler(event) {
    event.preventDefault();
    onAddOrderHandler(handlerForm);
    setHandlerForm({ name: "", phone: "", location: "" });
  }

  return (
    <>
      <section className="workspace admin-hero">
        <div>
          <p className="eyebrow">Admin</p>
          <h2>Employee activity</h2>
        </div>
        <div className="summary-strip">
          <span className="metric">Employees <strong>{employees.length}</strong></span>
          <span className="metric">Total reports <strong>{reports.length}</strong></span>
          <span className="metric">Reset requests <strong>{resetRequests.filter((item) => item.status !== "Handled").length}</strong></span>
          <span className="metric">Queued notices <strong>{notifications.length}</strong></span>
        </div>
      </section>

      <section className="history">
        <div className="admin-grid">
          {activity.map((item) => (
            <article className="employee-card" key={item.employee}>
              <div className="employee-card-head">
                <div>
                  <p className="eyebrow">Employee</p>
                  <h3>{item.employee}</h3>
                </div>
                <button className="secondary-button" type="button" onClick={() => onResetPassword(item.employee)}>
                  Reset password
                </button>
              </div>
              <div className="employee-stats">
                <span>Reports <strong>{item.count}</strong></span>
                <span>Payments <strong>{formatMoney(item.totals.amount)}</strong></span>
                <span>Calls <strong>{item.totals.call}</strong></span>
                <span>Sales <strong>{item.totals.sale}</strong></span>
                <span>Repairs <strong>{item.totals.repair}</strong></span>
                <span>SIM <strong>{item.totals.sim}</strong></span>
                <span>Rentals <strong>{item.totals.rental}</strong></span>
                <span>Orders <strong>{item.totals.phoneOrder}</strong></span>
              </div>
              <p className="muted">
                Last activity: {item.lastReport ? `${reportTypes[item.lastReport.type].label} on ${formatShortDate(item.lastReport.createdAt)}` : "No activity yet"}
              </p>
            </article>
          ))}
        </div>
      </section>

      <section className="history">
        <div className="history-header">
          <div>
            <p className="eyebrow">Team</p>
            <h2>Manage employee accounts</h2>
          </div>
        </div>
        <p className="muted">Create sign-in accounts, set each person's store, and control admin access.</p>
        <EmployeeManager
          storeLocations={storeLocations}
          employeeLocations={employeeLocations}
          onSyncName={onSyncName}
          onUnsyncName={onUnsyncName}
          onSetLocation={onSetEmployeeLocation}
        />
      </section>

      <section className="history">
        <div className="history-header">
          <div>
            <p className="eyebrow">Staff</p>
            <h2>Assign employees to a store</h2>
          </div>
        </div>
        <div className="request-list">
          {employees.length ? employees.map((employee) => (
            <div className="request-row" key={employee}>
              <div>
                <strong>{employee}</strong>
                <p className="muted">POS sales are recorded at this store</p>
              </div>
              <select
                className="status-select"
                value={locationFor(employee)}
                onChange={(event) => onSetEmployeeLocation(employee, event.target.value)}
              >
                <option value="">Default ({storeLocations[0] || "none"})</option>
                {storeLocations.map((location) => (
                  <option key={location}>{location}</option>
                ))}
              </select>
              <button
                className="secondary-button compact-button"
                type="button"
                onClick={() => {
                  if (window.confirm(`Remove ${employee} from the staff list? This does not delete their sign-in account.`)) {
                    onRemoveEmployee(employee);
                  }
                }}
              >
                Remove
              </button>
            </div>
          )) : (
            <p className="empty-state">No employees on the staff list yet.</p>
          )}
        </div>
      </section>

      <section className="history">
        <div className="history-header">
          <div>
            <p className="eyebrow">Stores</p>
            <h2>{editingStore ? `Edit ${editingStore}` : "Locations"}</h2>
          </div>
        </div>
        <form
          ref={storeFormRef}
          className="form-grid inventory-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (editingStore) {
              onUpdateStoreInfo(editingStore, {
                street: newStore.street.trim(),
                city: newStore.city.trim(),
                state: newStore.state.trim(),
                zip: newStore.zip.trim(),
                hours: newStore.hours.trim(),
              });
            } else {
              onAddStoreLocation(newStore);
            }
            setNewStore(emptyStore);
            setEditingStore(null);
          }}
        >
          <label className="field">
            <span>Store name</span>
            <input
              value={newStore.name}
              onChange={(event) => setNewStore((s) => ({ ...s, name: event.target.value }))}
              readOnly={Boolean(editingStore)}
              title={editingStore ? "Store name can't be changed here" : undefined}
              required
            />
          </label>
          <label className="field">
            <span>Street</span>
            <input value={newStore.street} onChange={(event) => setNewStore((s) => ({ ...s, street: event.target.value }))} />
          </label>
          <label className="field">
            <span>City</span>
            <input value={newStore.city} onChange={(event) => setNewStore((s) => ({ ...s, city: event.target.value }))} />
          </label>
          <label className="field">
            <span>State</span>
            <input value={newStore.state} onChange={(event) => setNewStore((s) => ({ ...s, state: event.target.value }))} placeholder="NY" />
          </label>
          <label className="field">
            <span>ZIP (for tax rate)</span>
            <input value={newStore.zip} onChange={(event) => setNewStore((s) => ({ ...s, zip: event.target.value }))} inputMode="numeric" />
          </label>
          <label className="field full">
            <span>Hours (shown on receipt)</span>
            <input value={newStore.hours} onChange={(event) => setNewStore((s) => ({ ...s, hours: event.target.value }))} placeholder="Sun 12PM-6:30PM · Mon-Thu 10:30AM-6:30PM" />
          </label>
          <div className="align-end inline-actions">
            <button className="primary-button" type="submit">{editingStore ? "Save changes" : "Add store"}</button>
            {editingStore ? (
              <button className="secondary-button" type="button" onClick={cancelEditStore}>Cancel</button>
            ) : null}
          </div>
        </form>
        <p className="muted">Address &amp; hours print on the receipt. Enter each store's sales-tax rate below.</p>
        <div className="request-list">
          {storeLocations.map((location) => {
            const tax = taxFor(location);
            const address = tax ? [tax.street, tax.city, tax.state, tax.zip].filter(Boolean).join(", ") : "";
            return (
              <div className="request-row store-row" key={location}>
                <div>
                  <strong>{location}</strong>
                  <p className="muted">{address || "No address on file"}</p>
                </div>
                <label className="field tax-rate-field">
                  <span>Tax rate %</span>
                  <input
                    key={`tax-${location}-${tax?.rate ?? ""}`}
                    type="number"
                    step="0.001"
                    min="0"
                    defaultValue={tax?.rate ?? 0}
                    onBlur={(event) => onSetStoreTaxRate(location, event.target.value)}
                  />
                </label>
                <label className="field">
                  <span>Hours</span>
                  <input
                    key={`hours-${location}-${tax?.hours ?? ""}`}
                    defaultValue={tax?.hours || ""}
                    placeholder="Sun 12PM-6:30PM · Mon-Thu …"
                    onBlur={(event) => onUpdateStoreInfo(location, { hours: event.target.value })}
                  />
                </label>
                <div className="store-row-actions">
                  <button className="secondary-button compact-button" type="button" onClick={() => editStore(location)}>
                    Edit
                  </button>
                  <button className="secondary-button compact-button" type="button" onClick={() => onRemoveStoreLocation(location)}>
                    Remove
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <section className="history">
        <div className="history-header">
          <div>
            <p className="eyebrow">Orders</p>
            <h2>Phone order handlers</h2>
          </div>
        </div>
        <form className="handler-form" onSubmit={submitHandler}>
          <label className="field">
            <span>Name</span>
            <input value={handlerForm.name} onChange={(event) => updateHandlerField("name", event.target.value)} required />
          </label>
          <label className="field">
            <span>SMS phone</span>
            <input inputMode="tel" value={handlerForm.phone} onChange={(event) => updateHandlerField("phone", event.target.value)} />
          </label>
          <label className="field">
            <span>Store</span>
            <select value={handlerForm.location} onChange={(event) => updateHandlerField("location", event.target.value)} required>
              <option value="">Select store</option>
              {(storeLocations || []).map((location) => (
                <option key={location}>{location}</option>
              ))}
            </select>
          </label>
          <button className="primary-button align-end" type="submit">Add handler</button>
        </form>
        <div className="request-list">
          {orderHandlers.length ? orderHandlers.map((handler) => (
            <div className="request-row" key={handler.id}>
              <div>
                <strong>{handler.name}</strong>
                <p className="muted">{handler.location} - {handler.phone || "No SMS phone"}</p>
              </div>
              <button className="secondary-button" type="button" onClick={() => onRemoveOrderHandler(handler.id)}>
                Remove
              </button>
            </div>
          )) : (
            <p className="empty-state">No phone order handlers yet.</p>
          )}
        </div>
      </section>

      <section className="history">
        <div className="history-header">
          <div>
            <p className="eyebrow">Audit trail</p>
            <h2>Everything employees did</h2>
          </div>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Employee</th>
                <th>Action</th>
                <th>Customer</th>
                <th>Details</th>
                <th>Paid</th>
                <th>Method</th>
              </tr>
            </thead>
            <tbody>
              {sortedReports.length ? (
                sortedReports.map((report) => <AuditRow key={report.id} report={report} />)
              ) : (
                <tr>
                  <td colSpan="7" className="empty-state">No employee activity today.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="history">
        <div className="history-header">
          <div>
            <p className="eyebrow">Access</p>
            <h2>Password reset requests</h2>
          </div>
        </div>
        <div className="request-list">
          {resetRequests.length ? (
            resetRequests.map((request) => (
              <div className="request-row" key={request.id}>
                <div>
                  <strong>{request.employee}</strong>
                  <p className="muted">{formatShortDate(request.createdAt)} - {request.status}</p>
                </div>
                {request.status !== "Handled" ? (
                  <button className="secondary-button" type="button" onClick={() => onMarkResetHandled(request.id)}>
                    Mark handled
                  </button>
                ) : null}
              </div>
            ))
          ) : (
            <p className="empty-state">No reset requests yet.</p>
          )}
        </div>
      </section>
    </>
  );
}

// A row in the admin "Everything employees did" audit trail. Collapsed by
// default to a one-line teaser; click to expand the full details.
function AuditRow({ report }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <tr className="report-row" onClick={() => setOpen((value) => !value)}>
        <td>{formatShortDate(report.createdAt)}</td>
        <td>{report.servedBy || "-"}</td>
        <td><span className={`badge ${report.type}`}>{reportTypes[report.type].label}</span></td>
        <td>{report.customerPhone || "-"}</td>
        <td>
          <button
            type="button"
            className="row-toggle"
            aria-expanded={open}
            onClick={(event) => { event.stopPropagation(); setOpen((value) => !value); }}
          >
            {open ? "▾" : "▸"}
          </button>
          {open ? null : <ReportDetails report={report} compact />}
        </td>
        <td>{formatPayment(report.paymentAmount)}</td>
        <td>{report.paymentMethod || "-"}</td>
      </tr>
      {open ? (
        <tr className="report-detail-row">
          <td colSpan="7"><ReportDetails report={report} /></td>
        </tr>
      ) : null}
    </>
  );
}

function ReportRow({ report, onStatusChange, onUpdateReport, onDeleteReport, onReturn, activeEmployee, hasActions }) {
  const [open, setOpen] = useState(false);
  const [showReceipt, setShowReceipt] = useState(false);
  const saleLineItems = report.details?.lineItems || [];
  // Any sale with line items can have its receipt reprinted, emailed or texted.
  const canReprint = (report.type === "sale" || report.type === "phoneOrder") && saleLineItems.length > 0;
  const returnableType = report.type === "sale" || report.type === "phoneOrder";
  const fullyReturned = report.details?.returnStatus === "Fully returned";
  const canReturn = Boolean(onReturn) && returnableType && saleLineItems.length > 0 && !fullyReturned;
  const columnCount = hasActions ? 9 : 8;
  // Stop clicks on interactive controls (status, buttons) from toggling the row.
  const stop = (event) => event.stopPropagation();
  return (
    <>
      <tr className="report-row" onClick={() => setOpen((value) => !value)}>
        <td>{formatShortDate(report.createdAt)}</td>
        <td><span className={`badge ${report.type}`}>{reportTypes[report.type].label}</span></td>
        <td>{report.customerPhone || "-"}</td>
        <td>
          <button type="button" className="row-toggle" aria-expanded={open} onClick={(event) => { stop(event); setOpen((value) => !value); }}>
            {open ? "▾" : "▸"}
          </button>
          {open ? null : <ReportDetails report={report} compact />}
        </td>
        <td>{formatPayment(report.paymentAmount)}</td>
        <td>{report.paymentMethod || "-"}</td>
        <td>{report.servedBy || "-"}</td>
        <td onClick={stop}>
          {report.type === "repair" ? (
            <select
              className="status-select"
              value={report.details?.status || repairStatuses[0]}
              onChange={(event) => onStatusChange(report.id, event.target.value)}
            >
              {repairStatuses.map((status) => (
                <option key={status}>{status}</option>
              ))}
            </select>
          ) : report.details?.returnStatus ? (
            <span className="status-pill returned">{report.details.returnStatus}</span>
          ) : (
            <span className="muted">-</span>
          )}
        </td>
        {hasActions ? (
          <td className="pos-row-actions" onClick={stop}>
            {canReprint ? (
              <button
                className="secondary-button compact-button"
                type="button"
                onClick={() => setShowReceipt(true)}
              >
                Receipt
              </button>
            ) : null}
            {canReturn ? (
              <button
                className="secondary-button compact-button"
                type="button"
                onClick={() => onReturn(report)}
              >
                Return
              </button>
            ) : null}
            {onDeleteReport ? (
              <button
                className="secondary-button compact-button"
                type="button"
                onClick={() => onDeleteReport(report.id)}
              >
                Delete
              </button>
            ) : null}
            {showReceipt ? (
              <SaleReceiptDialog sale={report} reprint onClose={() => setShowReceipt(false)} />
            ) : null}
          </td>
        ) : null}
      </tr>
      {open ? (
        <tr className="report-detail-row">
          <td colSpan={columnCount}>
            <ReportDetails report={report} />
            {report.type === "rental" && onUpdateReport ? (
              <RentalReportActions report={report} onUpdate={onUpdateReport} activeEmployee={activeEmployee} />
            ) : null}
          </td>
        </tr>
      ) : null}
    </>
  );
}

// Post-sale RCUK actions on a saved rental: fetch the assigned numbers if they
// weren't ready at creation, and cancel the rental (frees the SIM immediately).
function RentalReportActions({ report, onUpdate, activeEmployee }) {
  const details = report.details || {};
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [editing, setEditing] = useState(false);
  const rentalId = details.rentalId;
  const cancelled = details.rentalStatus === "Cancelled";
  const returned = Boolean(details.returnedAt);
  const hasNumbers = Boolean(details.cli);

  // Record the phone coming back. This is what stops the past-due notice and
  // freezes the late fee — after this the amount owed no longer grows, so the
  // figure stored here is the one to collect.
  function markReturned() {
    const { daysLate, amount } = calculateRentalLateFee(report);
    const feeLine = amount > 0
      ? `\n\nLate fee owed: ${formatMoney(amount)} (${daysLate} day${daysLate === 1 ? "" : "s"} late). This is not charged automatically — collect it before closing out.`
      : "";
    if (!window.confirm(`Mark this rental returned?${feeLine}`)) return;

    onUpdate(report.id, {
      details: {
        rentalStatus: "Returned",
        returnedAt: new Date().toISOString(),
        returnedBy: activeEmployee || "",
        lateFeeDaysAtReturn: daysLate,
        lateFeeAtReturn: amount ? amount.toFixed(2) : "0.00",
      },
    });
    setMessage(amount > 0
      ? `Marked returned. Late fee owed: ${formatMoney(amount)} — collect it separately.`
      : "Marked returned. No late fee owed.");
  }

  async function getNumbers() {
    if (!FUNCTIONS_BASE_URL) { setMessage("Functions URL not configured."); return; }
    if (!rentalId) { setMessage("This rental has no RCUK rental ID."); return; }
    setBusy("numbers");
    setMessage("Fetching numbers from RCUK…");
    try {
      const response = await fetch(`${FUNCTIONS_BASE_URL}/rcukGetRental`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rental_id: rentalId }),
      });
      const data = await response.json();
      if (!response.ok || !data.ok || !data.cli) {
        setMessage(data.message || "Numbers are not ready yet. Try again shortly.");
        return;
      }
      onUpdate(report.id, { details: { cli: data.cli, usDdi: data.usDdi || "", rcukStatus: data.status || "" } });
      setMessage(`Numbers updated: ${data.cli}`);
    } catch (error) {
      setMessage(error.message || "Could not reach RCUK.");
    } finally {
      setBusy("");
    }
  }

  async function cancelRental() {
    if (!FUNCTIONS_BASE_URL) { setMessage("Functions URL not configured."); return; }
    if (!rentalId) { setMessage("This rental has no RCUK rental ID."); return; }
    const reason = window.prompt("Reason for cancelling this rental?", "Cancelled in store");
    if (reason === null) return;
    if (!window.confirm("Cancel this rental with RCUK now? The SIM will be freed immediately.")) return;
    setBusy("cancel");
    setMessage("Cancelling rental with RCUK…");
    try {
      const response = await fetch(`${FUNCTIONS_BASE_URL}/rcukCancelRental`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rental_id: rentalId,
          reason,
          cancel_type: "immediate",
          uk_days: details.ukDays || 0,
          eu_days: details.euDays || 0,
          wts_days: details.wtsDays || 0,
        }),
      });
      const data = await response.json();
      if (!response.ok || !data.ok) {
        setMessage(data.message || "RCUK could not cancel the rental.");
        return;
      }
      onUpdate(report.id, { details: { rentalStatus: "Cancelled", cancelledAt: new Date().toISOString(), cancelReason: reason } });
      setMessage("Rental cancelled.");
    } catch (error) {
      setMessage(error.message || "Could not reach RCUK.");
    } finally {
      setBusy("");
    }
  }

  return (
    <div className="rental-actions">
      <button className="secondary-button compact-button" type="button" onClick={() => setEditing(true)}>
        Edit rental
      </button>
      {cancelled ? (
        <span className="status-pill returned">Cancelled</span>
      ) : returned ? (
        <span className="status-pill returned">
          Returned {formatShortDate(details.returnedAt)}
          {details.returnedBy ? ` by ${details.returnedBy}` : ""}
        </span>
      ) : (
        <>
          {!hasNumbers ? (
            <button className="secondary-button compact-button" type="button" disabled={busy === "numbers"} onClick={getNumbers}>
              {busy === "numbers" ? "Getting numbers…" : "Get numbers"}
            </button>
          ) : null}
          <button className="primary-button compact-button" type="button" onClick={markReturned}>
            Mark returned
          </button>
          <button className="secondary-button compact-button" type="button" disabled={busy === "cancel"} onClick={cancelRental}>
            {busy === "cancel" ? "Cancelling…" : "Cancel rental"}
          </button>
        </>
      )}
      {message ? <span className="muted">{message}</span> : null}
      {editing ? (
        <RentalEditDialog
          report={report}
          onSave={(patch) => {
            onUpdate(report.id, patch);
            setEditing(false);
            setMessage("Rental updated.");
          }}
          onClose={() => setEditing(false)}
        />
      ) : null}
    </div>
  );
}

function RentalEditDialog({ report, onSave, onClose }) {
  const details = report.details || {};
  // A rental with an RCUK rental_id is live on RCUK; editing it pushes the change
  // to RCUK's system (after a confirm). Without one, it's a local-only record.
  const rentalId = details.rentalId;
  const isRcuk = Boolean(rentalId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [form, setForm] = useState({
    customerPhone: report.customerPhone || "",
    paymentAmount: report.paymentAmount || "",
    paymentMethod: report.paymentMethod || "",
    serviceType: details.serviceType || "Voice",
    startDate: details.startDate || "",
    endDate: details.endDate || "",
    ukDays: details.ukDays ?? "",
    euDays: details.euDays ?? "",
    wtsDays: details.wtsDays ?? "",
    addSms: details.addSms === "Yes",
    usaNumber: details.usaNumber === "Yes",
    simNumber: details.simNumber || "",
    model: details.model || "",
    imei: details.imei || "",
    notes: report.notes || "",
  });
  const set = (name, value) => setForm((current) => ({ ...current, [name]: value }));

  function localPatch() {
    return {
      customerPhone: form.customerPhone.trim(),
      paymentAmount: String(form.paymentAmount ?? "").trim(),
      paymentMethod: form.paymentMethod,
      notes: form.notes.trim(),
      details: {
        serviceType: form.serviceType,
        startDate: form.startDate,
        endDate: form.endDate,
        ukDays: Number(form.ukDays) || 0,
        euDays: Number(form.euDays) || 0,
        wtsDays: Number(form.wtsDays) || 0,
        addSms: form.addSms ? "Yes" : "No",
        usaNumber: form.usaNumber ? "Yes" : "No",
        simNumber: form.simNumber.trim(),
        model: form.model.trim(),
        imei: form.imei.trim(),
        // The edited amount IS the rental total — without this the Paid column and
        // the "Total" in the report details drift apart after an edit.
        totalPrice: String(form.paymentAmount ?? "").trim(),
        // Keep the original formula price so an edited total still shows what the
        // rental would have cost. Older rentals seed it from their current total.
        calculatedPrice: details.calculatedPrice || details.totalPrice || "",
      },
    };
  }

  async function submit(event) {
    event.preventDefault();
    event.stopPropagation();

    if (isRcuk) {
      if (!window.confirm("Are you sure you want to edit this rental in the RCUK LIVE system?")) return;
      if (!FUNCTIONS_BASE_URL) { setError("Functions URL not configured."); return; }
      setBusy(true);
      setError("");
      try {
        const response = await fetch(`${FUNCTIONS_BASE_URL}/rcukUpdateRental`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            rental_id: rentalId,
            sim_number: form.simNumber.trim(),
            service_type: form.serviceType,
            start_date: form.startDate,
            end_date: form.endDate,
            uk_days: Number(form.ukDays) || 0,
            eu_days: Number(form.euDays) || 0,
            wts_days: Number(form.wtsDays) || 0,
            add_sms: form.addSms ? "yes" : "no",
            usa_number: form.usaNumber ? "yes" : "no",
            customer_phone: form.customerPhone.trim(),
            notes: form.notes.trim(),
          }),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || !data.ok) {
          setError(data.message || "RCUK could not update the rental.");
          setBusy(false);
          return;
        }
      } catch (err) {
        setError(err.message || "Could not reach RCUK.");
        setBusy(false);
        return;
      }
      setBusy(false);
    }

    // Persist our local copy once RCUK has accepted (or for local-only rentals).
    onSave(localPatch());
  }

  return createPortal(
    <div className="dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <div className="dialog-card dialog-card-wide" role="dialog" aria-modal="true" onMouseDown={(event) => event.stopPropagation()}>
        <div className="dialog-head">
          <div>
            <h2>Edit rental{rentalId ? ` #${rentalId}` : ""}</h2>
            <p className={isRcuk ? "summary-error" : "muted"}>
              {isRcuk
                ? "⚠ This rental is live on RCUK. Saving updates the real rental on RCUK's system — you'll be asked to confirm."
                : "This rental has no RCUK ID, so changes are saved locally only."}
            </p>
          </div>
          <DialogCloseButton onClose={onClose} label="Close edit rental" />
        </div>
        <form className="form-grid" onSubmit={submit}>
          <label className="field"><span>Customer phone</span><input value={form.customerPhone} inputMode="tel" onChange={(event) => set("customerPhone", event.target.value)} autoFocus /></label>
          <label className="field"><span>Payment amount</span><input value={form.paymentAmount} inputMode="decimal" placeholder="0.00" onChange={(event) => set("paymentAmount", event.target.value)} /></label>
          <label className="field">
            <span>Payment method</span>
            <select value={form.paymentMethod} onChange={(event) => set("paymentMethod", event.target.value)}>
              <option value="" disabled>Select one</option>
              {paymentMethods.map((method) => <option key={method}>{method}</option>)}
            </select>
          </label>
          <label className="field">
            <span>Service{isRcuk ? " (RCUK)" : ""}</span>
            <select value={form.serviceType} onChange={(event) => set("serviceType", event.target.value)}>
              {["Voice", "Data", "Voice & Data"].map((option) => <option key={option}>{option}</option>)}
            </select>
          </label>
          <label className="field"><span>Start date{isRcuk ? " (RCUK)" : ""}</span><input type="date" value={form.startDate} onChange={(event) => set("startDate", event.target.value)} /></label>
          <label className="field"><span>End date{isRcuk ? " (RCUK)" : ""}</span><input type="date" value={form.endDate} onChange={(event) => set("endDate", event.target.value)} /></label>
          <label className="field"><span>UK days{isRcuk ? " (RCUK)" : ""}</span><input value={form.ukDays} inputMode="numeric" onChange={(event) => set("ukDays", event.target.value)} /></label>
          <label className="field"><span>EU days{isRcuk ? " (RCUK)" : ""}</span><input value={form.euDays} inputMode="numeric" onChange={(event) => set("euDays", event.target.value)} /></label>
          <label className="field"><span>WTS days{isRcuk ? " (RCUK)" : ""}</span><input value={form.wtsDays} inputMode="numeric" onChange={(event) => set("wtsDays", event.target.value)} /></label>
          <label className="field"><span>SIM number{isRcuk ? " (RCUK)" : ""}</span><input value={form.simNumber} inputMode="numeric" onChange={(event) => set("simNumber", event.target.value)} /></label>
          <label className="field"><span>Phone model</span><input value={form.model} onChange={(event) => set("model", event.target.value)} /></label>
          <label className="field"><span>IMEI</span><input value={form.imei} inputMode="numeric" onChange={(event) => set("imei", event.target.value)} /></label>
          <label className="field checkbox-field">
            <input type="checkbox" checked={form.addSms} onChange={(event) => set("addSms", event.target.checked)} />
            <span>Add SMS{isRcuk ? " (RCUK)" : ""}</span>
          </label>
          <label className="field checkbox-field">
            <input type="checkbox" checked={form.usaNumber} onChange={(event) => set("usaNumber", event.target.checked)} />
            <span>USA number{isRcuk ? " (RCUK)" : ""}</span>
          </label>
          <label className="field full"><span>Notes</span><textarea rows={2} value={form.notes} onChange={(event) => set("notes", event.target.value)} /></label>
          {error ? <p className="summary-error full">{error}</p> : null}
          <div className="pos-form-actions form-actions-row">
            <button className="primary-button" type="submit" disabled={busy}>
              {busy ? "Updating RCUK…" : isRcuk ? "Update on RCUK & save" : "Save changes"}
            </button>
            <button className="secondary-button" type="button" onClick={onClose} disabled={busy}>Cancel</button>
          </div>
        </form>
      </div>
    </div>,
    document.body,
  );
}

// Every IMEI captured on a report — all phone lines (deduped), falling back to
// the single stored imei. Lets sale/phone-order reports show the device IDs even
// when more than one phone was on the ticket.
function collectReportImeis(details) {
  const fromLines = (details.lineItems || []).map((line) => line.imei).filter(Boolean);
  if (fromLines.length) return [...new Set(fromLines)].join(", ");
  return details.imei || "";
}

function ReportDetails({ report, compact }) {
  const details = report.details || {};
  const imeis = collectReportImeis(details);
  const lines = {
    sale: [
      ["Request", details.request],
      ["Product", details.productType],
      ["Store", details.location],
      ["Items", details.itemsText],
      ["Model", details.model],
      ["IMEI", imeis],
      ["Subtotal", Number(details.taxAmount) > 0 && details.subtotal ? formatMoney(Number(details.subtotal)) : ""],
      ["Tax", Number(details.taxAmount) > 0 ? `${formatMoney(Number(details.taxAmount))}${details.taxRate ? ` (${details.taxRate}%)` : ""}` : ""],
      ["Out of state", details.outOfState === "Yes" ? "Yes" : ""],
      ["Card txn", details.solaRefNum || details.stripePaymentIntentId || details.solaTransactionId],
      ["Returned", details.returnStatus],
    ],
    call: [
      ["Caller", details.callerName],
      ["Reason", details.reason],
      ["Outcome", details.outcome],
      ["Follow-up", details.followUpDate],
    ],
    repair: [
      ["Ticket", details.ticketNumber],
      ["Model", details.model],
      ["Damage", details.damage],
      ["Also fixed", (details.additionalFixes || [])
        .filter((fix) => fix?.description || fix?.price)
        .map((fix) => `${fix.description || "Fix"}${fix.price ? ` (${formatMoney(Number(fix.price) || 0)})` : ""}`)
        .join(", ")],
      ["Phone PIN", details.devicePin],
      ["SIM in phone", details.hadSim ? "Yes" : ""],
      ["SD card in phone", details.hadSdCard ? "Yes" : ""],
      ["Loaner phone given", details.borrowedTempPhone ? "Yes" : ""],
      ["Paid", details.paymentStatus],
      ["Ready", details.dueDate],
    ],
    sim: [
      ["Carrier", details.carrier],
      ["SIM number", details.simNumber || details.simPhone],
      ["Plan", details.plan],
    ],
    rental: [
      ["Rental ID", details.rentalId],
      ["Status", details.rentalStatus],
      ["Region", details.rentalRegion],
      ["Service", details.serviceType],
      ["Rental", details.rentalType],
      ["Model", details.model],
      ["IMEI", details.imei],
      ["SIM number", details.simNumber || details.simPhone],
      ["Start", details.startDate],
      ["End", details.endDate],
      ["Return time", details.returnTime],
      ["Return due", details.returnDueDate],
      ["Returned", details.returnedAt
        ? `${formatShortDate(details.returnedAt)}${details.returnedBy ? ` by ${details.returnedBy}` : ""}`
        : ""],
      // Frozen at the moment it was marked returned, so it stops growing and the
      // amount to collect is unambiguous.
      ["Late fee owed", Number(details.lateFeeAtReturn) > 0
        ? `${formatMoney(Number(details.lateFeeAtReturn))} (${details.lateFeeDaysAtReturn} day${Number(details.lateFeeDaysAtReturn) === 1 ? "" : "s"} late)`
        : ""],
      ["Reminder", details.returnReminderPreference],
      ["Late fee", Number(details.lateFeeWeekly) > 0
        ? `${formatMoney(Number(details.lateFeeWeekly))}/wk (${formatMoney(Number(details.lateFeeWeekly) / 7)}/day overdue)`
        : ""],
      ["Total days", details.totalDays],
      ["UK/EU/WTS", `${details.ukDays || 0}/${details.euDays || 0}/${details.wtsDays || 0}`],
      ["SMS", details.addSms],
      ["USA number", details.usaNumber],
      ["CLI", details.cli],
      ["US DDI", details.usDdi],
      ["Sola", details.solaTransactionId],
      ["Total", details.totalPrice
        ? `${formatMoney(Number(details.totalPrice))}${
            Number(details.calculatedPrice) > 0 && Number(details.calculatedPrice) !== Number(details.totalPrice)
              ? ` (calculated ${formatMoney(Number(details.calculatedPrice))})`
              : ""
          }`
        : ""],
    ],
    phoneOrder: [
      ["Status", details.status],
      ["Location", details.location],
      ["Assigned", details.assignedTo],
      ["Customer", details.customerName],
      ["Order", details.model],
      ["IMEI", imeis],
      ["Address", details.address],
      ["Contact", details.contactDetails],
      ["Payment", details.paymentStatus],
      ["Tax", Number(details.taxAmount) > 0 ? `${formatMoney(Number(details.taxAmount))}${details.taxRate ? ` (${details.taxRate}%)` : ""}` : ""],
      ["Delivered", details.deliveredAt ? formatShortDate(details.deliveredAt) : ""],
      ["Returned", details.returnStatus],
    ],
    return: [
      ["Items", details.itemsText],
      ["IMEI", imeis],
      ["Refund method", details.refundMethod],
      ["Card refund", details.solaRefundRef],
      ["Original sale", details.originalReportId],
      ["Subtotal", Number(details.refundTax) > 0 && details.refundSubtotal ? formatMoney(Number(details.refundSubtotal)) : ""],
      ["Sales tax", Number(details.refundTax) > 0 ? `${formatMoney(Number(details.refundTax))}${details.taxRate ? ` (${details.taxRate}%)` : ""}` : ""],
      ["Refunded", details.refundTotal ? formatMoney(Number(details.refundTotal)) : ""],
    ],
  }[report.type];

  const recordingUrl = report.type === "call"
    ? (details.recordingUrl || callRecordingUrl(details.telebroadCallId, details.telebroadUniqueId))
    : "";

  const filled = lines.filter(([, value]) => value);
  // Collapsed rows stay as small as possible: a single-field, one-line teaser.
  const shown = compact ? filled.slice(0, 1) : filled;

  return (
    <div className={compact ? "details details-compact" : "details"}>
      {shown.length ? (
        shown.map(([label, value]) => (
          <span key={label}><strong>{label}:</strong> {value}</span>
        ))
      ) : (
        <span>-</span>
      )}
      {!compact && recordingUrl ? (
        <a className="secondary-button compact-button" href={recordingUrl} target="_blank" rel="noopener noreferrer">
          ▶ Call recording
        </a>
      ) : null}
      {!compact && report.notes ? <span className="muted">{report.notes}</span> : null}
    </div>
  );
}

// Builds a URL that serves the Telebroad call recording for a call report.
function callRecordingUrl(callId, uniqueId) {
  if (!FUNCTIONS_BASE_URL || !callId || !uniqueId) return "";
  return `${FUNCTIONS_BASE_URL}/telebroadCallRecording?callid=${encodeURIComponent(callId)}&uniqueid=${encodeURIComponent(uniqueId)}`;
}

function ReturnDialog({ report, onClose, onSubmit }) {
  const details = report.details || {};
  const lineItems = details.lineItems || [];
  const returnedByIndex = details.returnedByIndex || {};
  const originalRefNum = details.solaRefNum || "";

  const [lines, setLines] = useState(() =>
    lineItems.map((item, index) => {
      const soldQty = item.requiresImei ? 1 : Number(item.qty) || 1;
      const alreadyReturned = Number(returnedByIndex[index]) || 0;
      return {
        index,
        productId: item.productId,
        sku: item.sku,
        name: item.name,
        price: Number(item.price) || 0,
        requiresImei: Boolean(item.requiresImei),
        soldImei: item.imei || "",
        remaining: Math.max(0, soldQty - alreadyReturned),
        returnQty: 0,
        scanImei: "",
      };
    }),
  );
  const [refundMethod, setRefundMethod] = useState(report.paymentMethod || "Cash");
  const [notes, setNotes] = useState("");
  const [refundState, setRefundState] = useState({ status: "idle", message: "", ref: "" });

  function setLine(index, patch) {
    setLines((current) => current.map((line) => (line.index === index ? { ...line, ...patch } : line)));
  }

  function selectAll() {
    setLines((current) => current.map((line) => ({ ...line, returnQty: line.remaining })));
  }

  const refundSubtotal = lines.reduce((sum, line) => sum + line.price * line.returnQty, 0);
  // Refund the sales tax the customer originally paid: apply the sale's tax rate
  // to the returned subtotal. Skip it when the sale charged no tax (out of state
  // or no store rate), so tax-free sales still refund exactly what was paid.
  const saleTaxRate = Number(details.taxRate) || 0;
  const taxApplies = Number(details.taxAmount) > 0 && saleTaxRate > 0;
  const refundTax = taxApplies ? refundSubtotal * (saleTaxRate / 100) : 0;
  const refundTotal = refundSubtotal + refundTax;
  const anySelected = lines.some((line) => line.returnQty > 0);
  const imeiNeedsScan = lines.some(
    (line) => line.requiresImei && line.returnQty > 0 && line.scanImei !== line.soldImei,
  );
  const requiresSolaRefund = isCardPayment(refundMethod) && Boolean(originalRefNum);
  const canSubmit = anySelected && refundTotal > 0 && !imeiNeedsScan && refundState.status !== "refunding";

  async function handleConfirm() {
    if (!canSubmit) return;

    let solaRef = refundState.ref;
    if (requiresSolaRefund && refundState.status !== "refunded") {
      try {
        setRefundState({ status: "refunding", message: "Refunding card...", ref: "" });
        const result = await refundToCard({ amount: Number(refundTotal.toFixed(2)), refNum: originalRefNum });
        solaRef = result.refNum;
        setRefundState({ status: "refunded", message: "Card refunded.", ref: solaRef });
      } catch (error) {
        setRefundState({
          status: "error",
          message: `${error.message || "Card refund failed."} Switch the refund method to record it manually.`,
          ref: "",
        });
        return;
      }
    }

    const returnLines = lines
      .filter((line) => line.returnQty > 0)
      .map((line) => ({
        productId: line.productId,
        sku: line.sku,
        name: line.name,
        price: line.price,
        returnQty: line.returnQty,
        requiresImei: line.requiresImei,
        imei: line.requiresImei ? line.scanImei : "",
        lineIndex: line.index,
      }));

    await Promise.resolve(onSubmit(report, {
      returnLines,
      refundMethod,
      solaRefundRef: solaRef,
      notes,
      refundSubtotal,
      refundTax,
      refundTotal,
      taxRate: taxApplies ? saleTaxRate : 0,
    }));
    onClose();
  }

  return (
    <div className="dialog-backdrop" role="presentation">
      <div className="dialog-card dialog-card-wide" role="dialog" aria-modal="true">
        <div className="dialog-head">
          <div>
            <p className="eyebrow">Return / refund</p>
            <h3>Return items from this sale</h3>
            <p className="muted">
              {formatShortDate(report.createdAt)} · {report.customerPhone || "no phone"} · paid {formatPayment(report.paymentAmount)} ({report.paymentMethod || "-"})
            </p>
          </div>
          <DialogCloseButton onClose={onClose} label="Close return" />
        </div>

        <div className="return-lines">
          {lines.map((line) => (
            <div className="return-line" key={line.index}>
              <div className="return-line-info">
                <strong>{line.name}</strong>
                <span className="muted">{line.sku} · {formatMoney(line.price)}</span>
                {line.remaining === 0 ? <span className="muted">Already returned</span> : null}
              </div>
              {line.requiresImei ? (
                <div className="return-line-controls">
                  <label className="field checkbox-field">
                    <input
                      type="checkbox"
                      disabled={line.remaining === 0}
                      checked={line.returnQty > 0}
                      onChange={(event) => setLine(line.index, { returnQty: event.target.checked ? 1 : 0, scanImei: "" })}
                    />
                    <span>Return this unit</span>
                  </label>
                  {line.returnQty > 0 ? (
                    <label className="field">
                      <span>Scan IMEI to restock (sold: {line.soldImei || "n/a"})</span>
                      <input
                        value={line.scanImei}
                        onChange={(event) => setLine(line.index, { scanImei: event.target.value.replace(/\D/g, "") })}
                        placeholder="Scan the returned phone's IMEI"
                        inputMode="numeric"
                        autoComplete="off"
                        spellCheck={false}
                      />
                      {line.scanImei && line.scanImei !== line.soldImei ? (
                        <span className="summary-error">IMEI does not match the one sold on this line.</span>
                      ) : null}
                    </label>
                  ) : null}
                </div>
              ) : (
                <label className="field return-qty-field">
                  <span>Return qty (max {line.remaining})</span>
                  <input
                    type="number"
                    min="0"
                    max={line.remaining}
                    value={line.returnQty}
                    disabled={line.remaining === 0}
                    onChange={(event) => {
                      const next = Math.max(0, Math.min(line.remaining, Number(event.target.value) || 0));
                      setLine(line.index, { returnQty: next });
                    }}
                  />
                </label>
              )}
            </div>
          ))}
        </div>

        <div className="form-grid">
          <label className="field">
            <span>Refund method</span>
            <select value={refundMethod} onChange={(event) => setRefundMethod(event.target.value)}>
              {paymentMethods.map((method) => <option key={method}>{method}</option>)}
            </select>
          </label>
          <label className="field full">
            <span>Notes</span>
            <textarea rows="2" value={notes} onChange={(event) => setNotes(event.target.value)} />
          </label>
        </div>

        {requiresSolaRefund ? (
          <p className="muted">This card sale will be refunded to the original card via Sola (ref {originalRefNum}).</p>
        ) : null}
        {refundState.message ? (
          <p className={refundState.status === "error" ? "summary-error" : "muted"}>{refundState.message}</p>
        ) : null}

        {taxApplies ? (
          <div className="return-lines">
            <div className="pos-totals-row"><span>Subtotal</span><span>{formatMoney(refundSubtotal)}</span></div>
            <div className="pos-totals-row"><span>Sales tax ({saleTaxRate}%)</span><span>{formatMoney(refundTax)}</span></div>
          </div>
        ) : null}
        <div className="return-summary">
          <span>Refund total</span>
          <strong>{formatMoney(refundTotal)}</strong>
        </div>

        <div className="pos-form-actions">
          <button className="primary-button" type="button" disabled={!canSubmit} onClick={handleConfirm}>
            {requiresSolaRefund
              ? `Refund ${formatMoney(refundTotal)} to card & restock`
              : `Refund ${formatMoney(refundTotal)} & restock`}
          </button>
          <button className="secondary-button" type="button" onClick={selectAll}>Return everything</button>
          <button className="secondary-button" type="button" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

function friendlyCallError(error) {
  return error?.message || "Action failed. Make sure you are signed in as an admin and Functions are deployed.";
}

// Phone input with a CRM type-ahead. As digits are typed, matching customers
// appear; picking one fills the customer's other details via onSelectCustomer.
function CustomerPhoneInput({ value, onChange, onSelectCustomer, onResolveCustomer, onSaveCustomerName, onSaveCustomer, placeholder, required, name, autoFocus }) {
  const [open, setOpen] = useState(false);
  const [detailsPrompt, setDetailsPrompt] = useState(null);
  // Query on demand instead of scanning a preloaded list: a debounced prefix
  // query fills the dropdown, and an exact query (7+ digits) drives the summary
  // and reports the resolved customer to the parent form for save-time snapshots.
  const [matches, setMatches] = useState([]);
  const [exactMatch, setExactMatch] = useState(null);
  // The leading US "1" is pre-filled and ignored. localDigits is the 10-digit
  // local number (area code included); searching starts after 5 of those digits.
  const localDigits = localPhoneDigits(value);
  const resolveRef = useRef(onResolveCustomer);
  resolveRef.current = onResolveCustomer;

  useEffect(() => {
    let cancelled = false;
    if (localDigits.length < 5) {
      setMatches([]);
      setExactMatch(null);
      resolveRef.current?.(null);
      return undefined;
    }
    const timer = window.setTimeout(async () => {
      try {
        const found = await searchCustomersByPhonePrefix(localDigits, 8);
        if (cancelled) return;
        setMatches(found);
        const exact = localDigits.length >= 7
          ? found.find((c) => c.phoneDigits === localDigits || c.mobileDigits === localDigits)
            || (await findCustomerByPhone(localDigits))
          : null;
        if (cancelled) return;
        setExactMatch(exact || null);
        resolveRef.current?.(exact || null);
      } catch {
        if (!cancelled) { setMatches([]); setExactMatch(null); }
      }
    }, 250);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [localDigits]);

  // Once a full-looking number is typed and nothing matches, offer to add it as
  // a new customer and attach it to the operation in progress.
  const canAddNew = Boolean(onSaveCustomer) && localDigits.length >= 7 && matches.length === 0;

  function ensureCountryCode() {
    setOpen(true);
    if (!digitsOnly(value)) onChange("1");
  }

  function startAddNew() {
    setOpen(false);
    setDetailsPrompt({ id: "", phone: value, name: "", mobile: "", address: "" });
  }

  function pickCustomer(customer) {
    setOpen(false);
    // Missing a name or address? Open the full details dialog to fill both.
    if (onSaveCustomer && (!customer.name || !customer.address)) {
      setDetailsPrompt(customer);
      return;
    }
    // Fallback when only the name-saver is available: quick name prompt.
    if (!customer.name && onSaveCustomerName) {
      const entered = window.prompt(`Add a name for ${customer.phone || "this number"}:`, "");
      if (entered && entered.trim()) {
        onSaveCustomerName(customer, entered.trim());
        onSelectCustomer?.({ ...customer, name: entered.trim() });
        return;
      }
    }
    onSelectCustomer?.(customer);
  }

  async function saveDetails(values) {
    const customer = detailsPrompt;
    // Let a failure reach the dialog so it can show it, rather than escaping
    // unhandled and leaving the dialog open with no explanation.
    await onSaveCustomer?.({
      // Carry over the fields this dialog doesn't edit (contact details, notes);
      // without them the save would blank those on the stored record.
      ...customer,
      id: customer.id || "",
      phone: customer.phone || value,
      name: values.name.trim(),
      mobile: values.mobile.trim(),
      address: values.address.trim(),
      email: (values.email ?? customer.email ?? "").trim(),
    });
    setDetailsPrompt(null);
    // Hand back the same shape a CRM query returns — including the derived digit
    // fields and the title-cased name that saveCustomer stores — so the caller can
    // match this record to the number on screen and print the name on the receipt.
    const savedPhone = customer.phone || value;
    const savedMobile = values.mobile.trim() || customer.mobile || "";
    onSelectCustomer?.({
      ...customer,
      phone: savedPhone,
      phoneDigits: localPhoneDigits(savedPhone),
      name: titleCaseName(values.name.trim()) || customer.name || "",
      mobile: savedMobile,
      mobileDigits: localPhoneDigits(savedMobile),
      address: values.address.trim() || customer.address || "",
      email: (values.email ?? customer.email ?? "").trim(),
    });
  }

  return (
    <div className="phone-autocomplete">
      <input
        name={name}
        value={value}
        inputMode="tel"
        autoComplete="off"
        required={required}
        autoFocus={autoFocus}
        placeholder={placeholder}
        onChange={(event) => {
          onChange(event.target.value);
          setOpen(true);
        }}
        onFocus={ensureCountryCode}
        onBlur={() => window.setTimeout(() => setOpen(false), 150)}
      />
      {open && (matches.length || canAddNew) ? (
        <div className="phone-autocomplete-menu">
          {matches.map((customer) => (
            <button
              type="button"
              className="phone-autocomplete-item"
              key={customer.id}
              onMouseDown={(event) => {
                event.preventDefault();
                pickCustomer(customer);
              }}
            >
              <strong>{customer.name || "(no name)"}</strong>
              <span>{customer.phone}</span>
              {customer.address ? <small>{customer.address}</small> : null}
            </button>
          ))}
          {canAddNew ? (
            <button
              type="button"
              className="phone-autocomplete-add"
              onMouseDown={(event) => {
                event.preventDefault();
                startAddNew();
              }}
            >
              ＋ Add new customer
            </button>
          ) : null}
        </div>
      ) : null}
      {exactMatch && (exactMatch.name || exactMatch.address || exactMatch.mobile) ? (
        <div className="phone-customer-summary">
          <span className="phone-customer-name">{exactMatch.name || "(no name)"}</span>
          {exactMatch.address ? <span>{exactMatch.address}</span> : null}
          {exactMatch.mobile ? <span>Mobile: {exactMatch.mobile}</span> : null}
        </div>
      ) : null}
      {detailsPrompt ? (
        <CustomerInfoDialog
          phone={detailsPrompt.phone || value}
          customer={detailsPrompt}
          onSave={saveDetails}
          onSkip={() => { const customer = detailsPrompt; setDetailsPrompt(null); onSelectCustomer?.(customer); }}
          onClose={() => setDetailsPrompt(null)}
        />
      ) : null}
    </div>
  );
}

function CustomersPage({ sessionRole, onSave, onRemove, onSync }) {
  const emptyCustomer = { id: "", name: "", phone: "", mobile: "", address: "", email: "", contactDetails: "", notes: "" };
  const [form, setForm] = useState(emptyCustomer);
  const [search, setSearch] = useState("");
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const isAdmin = sessionRole === "admin";
  const PAGE = 25;

  function update(field, value) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  // One page from Firestore (search by phone digits or name prefix); never loads
  // the whole CRM. Debounced on the search box; "Load more" pages with startAfter.
  async function runSearch(term) {
    setLoading(true);
    try {
      const page = await listCustomersPage({ pageSize: PAGE, search: term });
      setRows(page);
      setHasMore(page.length === PAGE);
    } catch {
      setRows([]);
      setHasMore(false);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    const timer = window.setTimeout(() => runSearch(search), 300);
    return () => window.clearTimeout(timer);
  }, [search]);

  async function loadMore() {
    if (!rows.length) return;
    setLoading(true);
    try {
      const page = await listCustomersPage({ pageSize: PAGE, search, afterId: rows[rows.length - 1].id });
      setRows((current) => [...current, ...page]);
      setHasMore(page.length === PAGE);
    } finally {
      setLoading(false);
    }
  }

  function reload() {
    runSearch(search);
  }

  async function submit(event) {
    event.preventDefault();
    if (!form.phone.trim() && !form.name.trim()) return;
    await onSave(form);
    setForm(emptyCustomer);
    reload();
  }

  function editCustomer(customer) {
    setForm({ ...emptyCustomer, ...customer });
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function handleRemove(id) {
    await onRemove(id);
    reload();
  }

  return (
    <>
      <section className="workspace">
        <div className="workspace-header">
          <div>
            <p className="eyebrow">CRM</p>
            <h2>{form.id ? "Edit customer" : "Add customer"}</h2>
          </div>
        </div>
        <form className="form-grid inventory-form" onSubmit={submit}>
          <label className="field"><span>Name</span><input value={form.name} onChange={(event) => update("name", event.target.value)} /></label>
          <label className="field"><span>Phone</span><input inputMode="tel" value={form.phone} onChange={(event) => update("phone", event.target.value)} /></label>
          <label className="field"><span>Mobile</span><input inputMode="tel" value={form.mobile} onChange={(event) => update("mobile", event.target.value)} /></label>
          <label className="field"><span>Email</span><input type="email" value={form.email} onChange={(event) => update("email", event.target.value)} /></label>
          <label className="field"><span>Address</span><input value={form.address} onChange={(event) => update("address", event.target.value)} /></label>
          <label className="field"><span>Contact details</span><input value={form.contactDetails} onChange={(event) => update("contactDetails", event.target.value)} placeholder="Email, WhatsApp, alt phone" /></label>
          <label className="field full"><span>Notes</span><textarea rows="2" value={form.notes} onChange={(event) => update("notes", event.target.value)} /></label>
          <div className="pos-form-actions form-actions-row">
            <button className="primary-button" type="submit">{form.id ? "Save changes" : "Add customer"}</button>
            {form.id ? <button className="secondary-button" type="button" onClick={() => setForm(emptyCustomer)}>Cancel</button> : null}
          </div>
        </form>
      </section>

      <section className="history">
        <div className="history-header">
          <div>
            <p className="eyebrow">Customers</p>
            <h2>Search the CRM</h2>
          </div>
          <div className="history-actions">
            <input className="pos-search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search by phone or name" />
            {isAdmin ? <button className="secondary-button" type="button" onClick={onSync}>Sync from reports</button> : null}
          </div>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>Name</th><th>Phone</th><th>Address</th><th>Email</th><th>Notes</th><th></th></tr>
            </thead>
            <tbody>
              {rows.length ? (
                rows.map((customer) => (
                  <tr key={customer.id}>
                    <td><strong>{customer.name || "-"}</strong></td>
                    <td>{customer.phone || "-"}</td>
                    <td>{customer.address || "-"}</td>
                    <td>{customer.email || "-"}</td>
                    <td className="muted">{customer.notes || ""}</td>
                    <td className="pos-row-actions">
                      <button className="secondary-button compact-button" type="button" onClick={() => editCustomer(customer)}>Edit</button>
                      {isAdmin ? <button className="secondary-button compact-button" type="button" onClick={() => handleRemove(customer.id)}>Delete</button> : null}
                    </td>
                  </tr>
                ))
              ) : (
                <tr><td colSpan="6" className="empty-state">{loading ? "Loading…" : search ? "No matches." : "Type a phone number or name to search."}</td></tr>
              )}
            </tbody>
          </table>
        </div>
        {hasMore ? (
          <div className="see-more-row">
            <span className="muted">Showing {rows.length}</span>
            <button className="secondary-button" type="button" onClick={loadMore} disabled={loading}>
              {loading ? "Loading…" : `Load more (${PAGE})`}
            </button>
          </div>
        ) : null}
      </section>
    </>
  );
}

function EmployeeManager({ onSyncName, onUnsyncName, storeLocations, employeeLocations, onSetLocation }) {
  const stores = storeLocations || [];
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [form, setForm] = useState({ email: "", displayName: "", password: "", location: stores[0] || "", isAdmin: false });

  function locationForName(name) {
    return (employeeLocations || []).find((entry) => entry?.name === name)?.location || "";
  }

  async function refresh() {
    setLoading(true);
    try {
      const list = await callFunction("listEmployees");
      setUsers(Array.isArray(list) ? list : []);
      setError("");
    } catch (caught) {
      setError(friendlyCallError(caught));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  function updateForm(name, value) {
    setForm((current) => ({ ...current, [name]: value }));
  }

  async function createUser(event) {
    event.preventDefault();
    if (!form.email.trim() || !form.password || !form.displayName.trim() || !form.location) return;
    setBusy(true);
    setError("");
    try {
      const created = await callFunction("createEmployee", {
        email: form.email.trim(),
        password: form.password,
        displayName: form.displayName.trim(),
        isAdmin: form.isAdmin,
      });
      const name = created?.displayName || form.displayName.trim();
      if (name) {
        onSyncName(name);
        onSetLocation(name, form.location);
      }
      setForm({ email: "", displayName: "", password: "", location: stores[0] || "", isAdmin: false });
      await refresh();
    } catch (caught) {
      setError(friendlyCallError(caught));
    } finally {
      setBusy(false);
    }
  }

  async function toggleAdmin(user) {
    setBusy(true);
    setError("");
    try {
      await callFunction("setEmployeeAdmin", { uid: user.uid, isAdmin: !user.admin });
      await refresh();
    } catch (caught) {
      setError(friendlyCallError(caught));
    } finally {
      setBusy(false);
    }
  }

  async function removeUser(user) {
    if (!window.confirm(`Delete ${user.displayName || user.email}? They will no longer be able to sign in.`)) return;
    setBusy(true);
    setError("");
    try {
      await callFunction("deleteEmployee", { uid: user.uid });
      if (user.displayName) onUnsyncName(user.displayName);
      await refresh();
    } catch (caught) {
      setError(friendlyCallError(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
        <form className="form-grid dialog-form" onSubmit={createUser}>
          <label className="field">
            <span>Name</span>
            <input value={form.displayName} onChange={(event) => updateForm("displayName", event.target.value)} placeholder="Employee name" required />
          </label>
          <label className="field">
            <span>Email</span>
            <input type="email" value={form.email} onChange={(event) => updateForm("email", event.target.value)} placeholder="employee@diamanttelecom.com" required />
          </label>
          <label className="field">
            <span>Temporary password</span>
            <input type="text" value={form.password} onChange={(event) => updateForm("password", event.target.value)} placeholder="At least 6 characters" required />
          </label>
          <label className="field">
            <span>Location</span>
            <select value={form.location} onChange={(event) => updateForm("location", event.target.value)} required>
              <option value="">Select store</option>
              {stores.map((location) => <option key={location}>{location}</option>)}
            </select>
          </label>
          <label className="field checkbox-field">
            <input type="checkbox" checked={form.isAdmin} onChange={(event) => updateForm("isAdmin", event.target.checked)} />
            <span>Admin access</span>
          </label>
          <button className="primary-button align-end" type="submit" disabled={busy}>
            {busy ? "Working…" : "Add employee"}
          </button>
        </form>

        {error ? <p className="summary-error">{error}</p> : null}

        <div className="employee-list">
          {loading ? (
            <p className="muted">Loading accounts…</p>
          ) : users.length ? (
            users.map((user) => (
              <div className="employee-row" key={user.uid}>
                <div>
                  <strong>{user.displayName || user.email}</strong>
                  <p className="muted">{user.email}{user.admin ? " · Admin" : ""}</p>
                </div>
                <div className="employee-row-actions">
                  {user.displayName ? (
                    <select
                      className="status-select"
                      value={locationForName(user.displayName)}
                      onChange={(event) => onSetLocation(user.displayName, event.target.value)}
                      title="Store location"
                    >
                      <option value="">No location</option>
                      {stores.map((location) => <option key={location}>{location}</option>)}
                    </select>
                  ) : null}
                  <button className="secondary-button compact-button" type="button" disabled={busy} onClick={() => toggleAdmin(user)}>
                    {user.admin ? "Make employee" : "Make admin"}
                  </button>
                  <button className="secondary-button compact-button" type="button" disabled={busy} onClick={() => removeUser(user)}>
                    Remove
                  </button>
                </div>
              </div>
            ))
          ) : (
            <p className="muted">No accounts yet. Add your first employee above.</p>
          )}
        </div>

    </>
  );
}

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error, info) {
    console.error("App crashed:", error, info);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="app-error">
          <h1>Something went wrong</h1>
          <p>Please reload the page. Your saved data is safe.</p>
          <button className="primary-button" type="button" onClick={() => window.location.reload()}>
            Reload
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
