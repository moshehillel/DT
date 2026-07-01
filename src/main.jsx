import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { createPortal } from "react-dom";
import {
  ACTIVE_EMPLOYEE_KEY,
  COMPANY,
  CUSTOMERS_KEY,
  defaultManualReportType,
  defaultOrderHandlers,
  FUNCTIONS_BASE_URL,
  lookupRepairPrice,
  manualReportTypeKeys,
  ORDER_HANDLERS_KEY,
  paymentMethods,
  PENDING_REPORTS_KEY,
  PHONE_ORDERS_KEY,
  productCategories,
  PRODUCTS_KEY,
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
  ensureFirebaseAuth,
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
  formatShortDate,
  generateRepairTicketNumber,
  getMinimumRentalDays,
  isRentalFormComplete,
  isSolaPaidStatus,
  normalizeRcukSimNumber,
  numberValue,
  parsePriceAdjust,
  playScanBeep,
  playScanError,
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

function Workspace({ currentUser, isAdmin }) {
  const employeeName = currentUser?.displayName || currentUser?.email || "";
  const sessionRole = isAdmin ? "admin" : "employee";
  const [activeType, setActiveType] = useState(defaultManualReportType);
  const [staff, setStaff] = useCloudDocumentState("staff", STAFF_KEY, [], { merge: unionByName });
  const [reports, setReports] = useCloudCollectionState("reports", STORAGE_KEY, []);
  const [pendingReports, setPendingReports] = useCloudCollectionState("pendingReports", PENDING_REPORTS_KEY, []);
  const [phoneOrders, setPhoneOrders] = useCloudCollectionState("phoneOrders", PHONE_ORDERS_KEY, []);
  const [orderHandlers, setOrderHandlers] = useCloudCollectionState("orderHandlers", ORDER_HANDLERS_KEY, defaultOrderHandlers);
  const [notifications, setNotifications] = useCloudCollectionState("notificationLogs", "diamant-telecom-notifications-v1", []);
  const [resetRequests, setResetRequests] = useCloudCollectionState("passwordResetRequests", RESET_REQUESTS_KEY, []);
  const [products, setProducts] = useCloudCollectionState("products", PRODUCTS_KEY, []);
  const [stores, setStores] = useCloudDocumentState("stores", STORES_KEY, []);
  const [customers, setCustomers] = useCloudCollectionState("customers", CUSTOMERS_KEY, []);

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
  const [formNonce, setFormNonce] = useState(0);
  const [returnTarget, setReturnTarget] = useState(null);

  // Keep the signed-in employee in the staff list so admins can see and
  // attribute to them. Adds a bare entry (no store yet) the first time they sign
  // in; the union merge keeps it from ever being dropped by another device.
  useEffect(() => {
    if (employeeName && !employees.includes(employeeName)) {
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
    if (!isAdmin) {
      setActiveEmployee(employeeName);
      return;
    }
    if (activeEmployee && !employees.includes(activeEmployee)) {
      setActiveEmployee(employees[0] || employeeName || "");
    }
  }, [activeEmployee, employees, employeeName, isAdmin]);

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
        (filters.paymentMethod === "all" || report.paymentMethod === filters.paymentMethod) &&
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
  const appNotifications = useMemo(() => {
    return buildAppNotifications(reports);
  }, [reports]);

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
  function upsertCustomer(info) {
    const phone = String(info?.phone || "").trim();
    const digits = localPhoneDigits(phone);
    if (!digits) return;
    setCustomers((current) => {
      const index = current.findIndex((entry) => entry.phoneDigits === digits);
      const now = new Date().toISOString();
      if (index === -1) {
        return [
          {
            id: crypto.randomUUID(),
            name: String(info.name || "").trim(),
            phone,
            phoneDigits: digits,
            address: String(info.address || "").trim(),
            email: String(info.email || "").trim(),
            contactDetails: String(info.contactDetails || "").trim(),
            notes: "",
            createdAt: now,
            updatedAt: now,
          },
          ...current,
        ];
      }
      const existing = current[index];
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
        return current;
      }
      merged.updatedAt = now;
      const next = [...current];
      next[index] = merged;
      return next;
    });
  }

  // Manual create/edit from the CRM page.
  function saveCustomer(customer) {
    const phone = String(customer.phone || "").trim();
    const digits = localPhoneDigits(phone);
    const now = new Date().toISOString();
    const mobile = String(customer.mobile || "").trim();
    const normalized = {
      phone,
      phoneDigits: digits,
      mobile,
      mobileDigits: localPhoneDigits(mobile),
      name: titleCaseName(customer.name),
      address: String(customer.address || "").trim(),
      email: String(customer.email || "").trim(),
      contactDetails: String(customer.contactDetails || "").trim(),
      notes: String(customer.notes || "").trim(),
      updatedAt: now,
    };
    setCustomers((current) => {
      if (customer.id && current.some((entry) => entry.id === customer.id)) {
        return current.map((entry) => (entry.id === customer.id ? { ...entry, ...normalized } : entry));
      }
      const index = digits ? current.findIndex((entry) => entry.phoneDigits === digits) : -1;
      if (index !== -1) {
        const next = [...current];
        next[index] = { ...next[index], ...normalized };
        return next;
      }
      return [{ ...normalized, id: customer.id || crypto.randomUUID(), createdAt: now }, ...current];
    });
  }

  function removeCustomer(customerId) {
    if (sessionRole !== "admin") {
      window.alert("Only admin can delete customers.");
      return;
    }
    const customer = customers.find((entry) => entry.id === customerId);
    const label = customer?.name || customer?.phone || "this customer";
    if (!window.confirm(`Delete ${label}? This cannot be undone.`)) return;
    setCustomers((current) => current.filter((entry) => entry.id !== customerId));
  }

  // Fill in a name for a customer that has none yet (prompted at point of sale).
  function saveCustomerName(customer, name) {
    const cleanName = titleCaseName(name);
    if (!cleanName || !customer) return;
    setCustomers((current) =>
      current.map((entry) =>
        entry.id === customer.id || (customer.phoneDigits && entry.phoneDigits === customer.phoneDigits)
          ? { ...entry, name: entry.name || cleanName, updatedAt: new Date().toISOString() }
          : entry,
      ),
    );
  }

  // Backfill the CRM with any customer phone seen in reports but not yet saved.
  function syncCustomersFromReports() {
    const existing = new Set(customers.map((entry) => entry.phoneDigits));
    const seen = new Set();
    const additions = [];
    const now = new Date().toISOString();
    reports.forEach((report) => {
      const digits = report.customerPhoneDigits || digitsOnly(report.customerPhone);
      if (!digits || existing.has(digits) || seen.has(digits)) return;
      seen.add(digits);
      const details = report.details || {};
      additions.push({
        id: crypto.randomUUID(),
        name: titleCaseName(details.customerName || details.callerName),
        phone: String(report.customerPhone || "").trim(),
        phoneDigits: digits,
        address: String(details.address || "").trim(),
        email: "",
        contactDetails: String(details.contactDetails || "").trim(),
        notes: "",
        createdAt: now,
        updatedAt: now,
      });
    });
    if (!additions.length) {
      window.alert("All customers from reports are already in the CRM.");
      return;
    }
    setCustomers((current) => [...additions, ...current]);
    window.alert(`Added ${additions.length} customer${additions.length === 1 ? "" : "s"} from reports.`);
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
              .map((value) => String(value || "").replace(/\D/g, "").slice(0, 15))
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
    upsertCustomer({ phone: sale.customerPhone });
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

  async function completePhoneOrder(orderId) {
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
      paymentMethod: order.paymentMethod,
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
        paymentStatus: order.paymentStatus,
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
    setReports((current) =>
      current.map((report) =>
        report.id === reportId
          ? { ...report, ...top, details: { ...report.details, ...detailsPatch } }
          : report,
      ),
    );
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
      window.alert("Only admin can delete reports.");
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

    const refundTotal = returnLines.reduce(
      (sum, line) => sum + (Number(line.price) || 0) * (Number(line.returnQty) || 0),
      0,
    );
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

      <main className="main">
        {cloudOnline === false ? (
          <div className="cloud-offline-banner" role="alert">
            ⚠️ Can't reach the cloud — changes you make now are <strong>not being saved</strong> and won't sync to other devices. Check the internet/filter and reload before editing.
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

        <NotificationCenter notifications={appNotifications} />

        {activeView === "pendingReports" ? (
          <PendingReportsPage
            pendingReports={pendingReports}
            activeEmployee={activeEmployee}
            customers={customers}
            onSaveCustomerName={saveCustomerName}
            onSaveCustomer={saveCustomer}
            onClaim={claimPendingReport}
            onSave={savePendingReport}
          />
        ) : activeView === "openRepairs" ? (
          <OpenRepairsPage
            reports={filteredReports}
            onStatusChange={updateRepairStatus}
            onSetReady={markRepairReady}
            onMarkPaid={markRepairPaid}
            onEditRepair={updateRepair}
          />
        ) : activeView === "customers" ? (
          <CustomersPage
            customers={customers}
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
              customers={customers}
              onSaveCustomerName={saveCustomerName}
              onSaveCustomer={saveCustomer}
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
              customers={customers}
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
              customers={customers}
              activeStoreInfo={activeStoreInfo}
              onSaveCustomerName={saveCustomerName}
              onSaveCustomer={saveCustomer}
              onSave={saveReport}
            />
          )
        ) : activeView === "reportsLog" ? (
          <ReportHistory
            employees={visibleEmployees}
            storeLocations={storeLocations}
            reports={filteredReports}
            filters={filters}
            onFiltersChange={setFilters}
            onClearFilters={() => setFilters(createEmptyFilters())}
            onStatusChange={updateRepairStatus}
            onExport={() => exportCsv(filteredReports)}
            onExportAll={() => exportCsv(visibleReports)}
            onClearReports={sessionRole === "admin" ? clearReports : null}
            onDeleteReport={sessionRole === "admin" ? deleteReport : null}
            onReturn={setReturnTarget}
            onScanReturn={returnByCode}
            notifications={visibleNotifications}
          />
        ) : activeView === "pos" ? (
          <PosPage
            key={`pos-${formNonce}`}
            products={products}
            activeEmployee={activeEmployee}
            activeLocation={activeLocation}
            activeDeviceId={activeDeviceId}
            activeTaxRate={activeTaxRate}
            activeStoreInfo={activeStoreInfo}
            customers={customers}
            onSaveCustomerName={saveCustomerName}
            onSaveCustomer={saveCustomer}
            onCompleteSale={savePosSale}
          />
        ) : activeView === "inventory" ? (
          <InventoryPage
            products={products}
            storeLocations={storeLocations}
            sessionRole={sessionRole}
            onSaveProduct={saveProduct}
            onRemoveProduct={removeProduct}
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

        <PoweredByFooter />
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

        {sessionRole === "admin" ? (
          <>
            <button
              className={`tab ${activeView === "admin" ? "active" : ""}`}
              type="button"
              onClick={() => onViewChange("admin")}
            >
              <span className="tab-mark">A</span>
              <span>
                <strong>Admin</strong>
                <small>Activity, audit & access</small>
              </span>
            </button>
          </>
        ) : null}
      </nav>

      <div className="sidebar-account">
        <label className="field">
          <span>{sessionRole === "admin" ? "Active employee" : "Signed in employee"}</span>
          {sessionRole === "admin" ? (
            <select value={activeEmployee} onChange={(event) => onEmployeeChange(event.target.value)}>
              {employees.map((employee) => (
                <option key={employee}>{employee}</option>
              ))}
            </select>
          ) : (
            <input value={activeEmployee} disabled readOnly />
          )}
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

function ReportForm({ activeType, activeEmployee, activeLocation, reports, customers, activeStoreInfo, onSaveCustomerName, onSaveCustomer, onSave }) {
  const [now, setNow] = useState(new Date());
  const [customerPhone, setCustomerPhone] = useState("");
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
      details.ticketNumber = generateRepairTicketNumber(reports);
      details.ticketDigits = digitsOnly(details.ticketNumber);
      // The intake amount is the quote; the real price is set when the repair is
      // marked Ready. Record it explicitly as the estimated price.
      details.estimatedPrice = String(formData.get("paymentAmount") || "").trim();
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
    const matchedCustomer = phoneDigits
      ? (customers || []).find((entry) => entry.phoneDigits === phoneDigits || entry.mobileDigits === phoneDigits)
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

      <form className="report-form" onSubmit={handleSubmit}>
        <div className="form-grid">
          <label className="field">
            <span>Customer / caller number</span>
            <CustomerPhoneInput
              name="customerPhone"
              value={customerPhone}
              onChange={setCustomerPhone}
              customers={customers}
              onSaveCustomerName={onSaveCustomerName}
              onSaveCustomer={onSaveCustomer}
              onSelectCustomer={(customer) => setCustomerPhone(customer.phone)}
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

          <label className="field">
            <span>Served by</span>
            <input value={activeEmployee} disabled readOnly />
          </label>
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

function NotificationCenter({ notifications }) {
  if (!notifications.length) return null;

  return (
    <section className="notification-center">
      <div>
        <p className="eyebrow">Notifications</p>
        <h2>Needs attention</h2>
      </div>
      <div className="notification-list">
        {notifications.map((notification) => (
          <article className={`app-notification ${notification.severity}`} key={notification.id}>
            <strong>{notification.title}</strong>
            <p>{notification.message}</p>
          </article>
        ))}
      </div>
    </section>
  );
}

function RentalReportForm({ activeEmployee, customers, onSaveCustomerName, onSaveCustomer, onSave }) {
  const [now, setNow] = useState(new Date());
  const [form, setForm] = useState({
    rentalRegion: "RCUK",
    serviceType: "Voice",
    startDate: "",
    endDate: "",
    ukDays: "",
    euDays: "",
    wtsDays: "",
    addSms: false,
    usaNumber: false,
    deviceKind: "SIM only",
    model: "",
    imei: "",
    simNumber: "",
    returnDays: "",
    paymentMethod: "",
    returnReminderPreference: "Text message",
    lateFeeWeekly: "",
    customerPhone: "",
    notes: "",
  });
  const [submitState, setSubmitState] = useState({
    status: "idle",
    message: "",
    rentalId: "",
    cli: "",
    usDdi: "",
    getNumbersAttempted: false,
    raw: null,
  });
  const [simCheckState, setSimCheckState] = useState({
    status: "idle",
    message: "",
    checkedSimNumber: "",
    raw: null,
  });
  const [solaState, setSolaState] = useState({
    status: "idle",
    message: "",
    paymentToken: "",
    transactionId: "",
    paymentUrl: "",
    raw: null,
  });
  const solaTokenRef = useRef("");

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 30000);
    return () => window.clearInterval(timer);
  }, []);

  const totalDays = calculateInclusiveDays(form.startDate, form.endDate);
  const zoneDays = numberValue(form.ukDays) + numberValue(form.euDays) + numberValue(form.wtsDays);
  const rentalPricing = calculateRentalPrice(form, totalDays);
  const dailyRate = rentalPricing.dailyRate;
  const totalPrice = rentalPricing.totalPrice;
  const isRcukRental = form.rentalRegion === "RCUK";
  const isSimpleRental = !isRcukRental;
  const normalizedSimNumber = normalizeRcukSimNumber(form.simNumber);
  const zoneDaysValid = totalDays > 0 && zoneDays === totalDays;
  const needsUsNumber = form.usaNumber;
  const rentalSubmitted = submitState.status === "submitted" || submitState.status === "numbers-ready";
  const minimumDaysValid = getMinimumRentalDays(form.rentalRegion) <= totalDays;
  const requiresSolaCharge = ["CC", "Card"].includes(form.paymentMethod);
  const solaChargeComplete = !requiresSolaCharge || solaState.status === "paid";
  const canSubmitRental = isRentalFormComplete(form)
    && zoneDaysValid
    && minimumDaysValid
    && totalPrice > 0
    && normalizedSimNumber
    && isRcukRental;
  const canSave = isSimpleRental
    ? isRentalFormComplete(form) && minimumDaysValid && totalPrice > 0 && solaChargeComplete
    : rentalSubmitted && submitState.getNumbersAttempted && solaChargeComplete;

  function updateField(name, value) {
    setForm((current) => ({ ...current, [name]: value }));
    if (["paymentMethod", "customerPhone", "startDate", "endDate", "serviceType", "addSms", "rentalRegion"].includes(name)) {
      setSolaState({
        status: "idle",
        message: "",
        paymentToken: "",
        transactionId: "",
        paymentUrl: "",
        raw: null,
      });
    }
    setSubmitState((current) => (
      current.status === "idle" ? current : { ...current, message: "Rental changed. Submit to RCUK again before saving.", status: "idle", rentalId: "", cli: "", usDdi: "", getNumbersAttempted: false, raw: null }
    ));
    if (name === "simNumber") {
      setSimCheckState({
        status: "idle",
        message: "",
        checkedSimNumber: "",
        raw: null,
      });
    }
  }

  function updateSolaToken(value) {
    solaTokenRef.current = value;
    setSolaState((current) => ({
      ...current,
      paymentToken: value,
      status: current.status === "paid" ? "idle" : current.status,
      transactionId: current.status === "paid" ? "" : current.transactionId,
      message: value.trim() ? "Sola token ready to charge." : "",
    }));
  }

  function buildRentalPayload() {
    return {
      rental_region: form.rentalRegion,
      service_type: form.serviceType,
      total_days: totalDays,
      uk_days: numberValue(form.ukDays),
      eu_days: numberValue(form.euDays),
      wts_days: numberValue(form.wtsDays),
      add_sms: form.addSms ? "yes" : "no",
      usa_number: form.usaNumber ? "yes" : "no",
      device_kind: form.deviceKind,
      model: form.model,
      imei: form.imei,
      sim_number: normalizedSimNumber,
      start_date: form.startDate,
      end_date: form.endDate,
      return_days: form.returnDays,
      customer_phone: form.customerPhone,
      payment_method: form.paymentMethod,
      return_reminder_preference: form.returnReminderPreference,
      total_price: totalPrice,
      notes: form.notes,
    };
  }

  async function chargeWithSola() {
    if (!requiresSolaCharge || !totalPrice) return;

    if (!FUNCTIONS_BASE_URL) {
      setSolaState((current) => ({
        ...current,
        status: "error",
        message: "Set VITE_FUNCTIONS_BASE_URL to your Firebase Functions URL before charging with Sola.",
      }));
      return;
    }

    setSolaState((current) => ({ ...current, status: "charging", message: "Opening Sola charge..." }));
    const paymentToken = solaTokenRef.current.trim();

    try {
      const response = await fetch(`${FUNCTIONS_BASE_URL}/solaCreateCharge`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          amount: totalPrice,
          currency: "USD",
          customerPhone: form.customerPhone,
          rentalId: submitState.rentalId,
          paymentToken,
          description: `${form.rentalRegion} ${form.deviceKind} rental`,
        }),
      });
      const data = await response.json();
      const status = isSolaPaidStatus(data.status) ? "paid" : "pending";

      if (!response.ok || !data.ok) {
        setSolaState({
          status: "error",
          message: data.message || "Sola charge could not be started.",
          paymentToken,
          transactionId: data.transactionId || "",
          paymentUrl: data.paymentUrl || "",
          raw: data.raw || data,
        });
        return;
      }

      if (data.paymentUrl) {
        window.open(data.paymentUrl, "_blank", "noopener,noreferrer");
      }

      setSolaState({
        status,
        message: status === "paid"
          ? "Sola payment approved."
          : "Sola payment started, but approval was not returned yet.",
        paymentToken,
        transactionId: data.transactionId || data.paymentId || "",
        paymentUrl: data.paymentUrl || "",
        raw: data.raw || data,
      });
    } catch (error) {
      setSolaState({
        status: "error",
        message: error.message || "Could not connect to Sola.",
        paymentToken,
        transactionId: "",
        paymentUrl: "",
        raw: null,
      });
    }
  }

  async function submitRentalToRcuk() {
    if (!isRcukRental) return;

    if (!FUNCTIONS_BASE_URL) {
      setSubmitState((current) => ({
        ...current,
        status: "error",
        message: "Set VITE_FUNCTIONS_BASE_URL to your Firebase Functions URL before submitting rentals.",
      }));
      return;
    }

    if (!zoneDaysValid) {
      setSubmitState((current) => ({
        ...current,
        status: "error",
        message: "UK + EU + WTS days must equal total rental days.",
      }));
      return;
    }

    setSubmitState((current) => ({ ...current, status: "submitting", message: "Submitting rental to RCUK..." }));

    try {
      const response = await fetch(`${FUNCTIONS_BASE_URL}/rcukAddRental`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildRentalPayload()),
      });
      const data = await response.json();

      if (!response.ok || !data.ok) {
        setSubmitState({
          status: "error",
          message: data.message || "RCUK rejected the rental.",
          rentalId: "",
          cli: "",
          usDdi: "",
          raw: data.raw || data,
          getNumbersAttempted: false,
        });
        return;
      }

      setSubmitState({
        status: "submitted",
        message: data.rentalId
          ? "Rental submitted. Click Get numbers until CLI / US DDI are returned."
          : "Rental submitted, but no rental ID was returned. Check RCUK response.",
        rentalId: data.rentalId || "",
        cli: "",
        usDdi: "",
        getNumbersAttempted: false,
        raw: data.raw || data,
      });
    } catch (error) {
      setSubmitState({
        status: "error",
        message: error.message || "Could not submit rental.",
        rentalId: "",
        cli: "",
        usDdi: "",
        getNumbersAttempted: false,
        raw: null,
      });
    }
  }

  async function checkSimWithRcuk() {
    if (!isRcukRental || !normalizedSimNumber) return;

    if (!FUNCTIONS_BASE_URL) {
      setSimCheckState({
        status: "error",
        message: "Set VITE_FUNCTIONS_BASE_URL to your Firebase Functions URL before checking SIMs.",
        checkedSimNumber: "",
        raw: null,
      });
      return;
    }

    setSimCheckState({
      status: "checking",
      message: "Checking SIM with RCUK...",
      checkedSimNumber: normalizedSimNumber,
      raw: null,
    });

    try {
      const response = await fetch(`${FUNCTIONS_BASE_URL}/rcukCheckSim`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sim_number: normalizedSimNumber }),
      });
      const data = await response.json();

      if (!response.ok || !data.ok) {
        setSimCheckState({
          status: "error",
          message: data.message || "RCUK rejected the SIM check.",
          checkedSimNumber: data.simNumber || normalizedSimNumber,
          raw: data.raw || data,
        });
        return;
      }

      setSimCheckState({
        status: "checked",
        message: data.message || "SIM check complete.",
        checkedSimNumber: data.simNumber || normalizedSimNumber,
        raw: data.raw || data,
      });
    } catch (error) {
      setSimCheckState({
        status: "error",
        message: error.message || "Could not check SIM.",
        checkedSimNumber: normalizedSimNumber,
        raw: null,
      });
    }
  }

  async function getRentalNumbers() {
    if (!FUNCTIONS_BASE_URL || !submitState.rentalId) return;

    setSubmitState((current) => ({ ...current, status: "getting-numbers", message: "Checking numbers..." }));

    try {
      const response = await fetch(`${FUNCTIONS_BASE_URL}/rcukGetRental`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rental_id: submitState.rentalId }),
      });
      const data = await response.json();

      if (!response.ok || !data.ok) {
        setSubmitState((current) => ({
          ...current,
          status: "submitted",
          message: data.message || "Numbers are not ready yet. You can save the report or try Get numbers again.",
          getNumbersAttempted: true,
          raw: data.raw || data,
        }));
        return;
      }

      const cli = data.cli || "";
      const usDdi = data.usDdi || "";
      const ready = Boolean(cli) && (!needsUsNumber || (usDdi && usDdi.toLowerCase() !== "yes"));

      setSubmitState((current) => ({
        ...current,
        status: ready ? "numbers-ready" : "submitted",
        message: ready ? "Numbers returned. You can save the rental report." : "Numbers still pending. You can save the report or try Get numbers again.",
        cli,
        usDdi,
        getNumbersAttempted: true,
        raw: data.raw || data,
      }));
    } catch (error) {
      setSubmitState((current) => ({
        ...current,
        status: "submitted",
        message: error.message || "Could not get rental numbers. You can still save the report.",
        getNumbersAttempted: true,
      }));
    }
  }

  function saveRentalReport() {
    if (!canSave) return;

    onSave({
      id: crypto.randomUUID(),
      type: "rental",
      createdAt: new Date().toISOString(),
      servedBy: activeEmployee,
      customerPhone: form.customerPhone.trim(),
      customerPhoneDigits: digitsOnly(form.customerPhone),
      paymentAmount: String(totalPrice),
      paymentMethod: form.paymentMethod,
      notes: form.notes.trim(),
      details: {
        rentalId: submitState.rentalId,
        rentalRegion: form.rentalRegion,
        serviceType: form.serviceType,
        rentalType: form.deviceKind,
        model: form.model,
        imei: form.imei,
        simNumber: isRcukRental ? normalizedSimNumber : form.simNumber.trim(),
        startDate: form.startDate,
        endDate: form.endDate,
        returnTime: `${form.returnDays || 0} days`,
        returnDueDate: calculateReturnDueDate(form.endDate, form.returnDays),
        returnReminderPreference: form.returnReminderPreference,
        lateFeeWeekly: Number.parseFloat(form.lateFeeWeekly) || 0,
        totalDays,
        ukDays: numberValue(form.ukDays),
        euDays: numberValue(form.euDays),
        wtsDays: numberValue(form.wtsDays),
        addSms: form.addSms ? "Yes" : "No",
        usaNumber: form.usaNumber ? "Yes" : "No",
        cli: submitState.cli,
        usDdi: submitState.usDdi,
        dailyRate,
        totalPrice,
        pricingLabel: rentalPricing.label,
        solaStatus: requiresSolaCharge ? solaState.status : "",
        solaTransactionId: requiresSolaCharge ? solaState.transactionId : "",
      },
    });
  }

  return (
    <section className="workspace">
      <div className="workspace-header">
        <div>
          <p className="eyebrow">New customer report</p>
          <h2>Phone rental report</h2>
        </div>
        <div className="clock-pill">{formatDateTime(now)}</div>
      </div>

      <div className="rental-layout">
        <div className="report-form">
          <div className="form-grid">
            <label className="field">
              <span>Rental region</span>
              <select value={form.rentalRegion} onChange={(event) => updateField("rentalRegion", event.target.value)}>
                <option>RCUK</option>
                <option>Canada</option>
                <option>Israel</option>
                <option>Local</option>
              </select>
            </label>
            <label className="field">
              <span>Service</span>
              <select value={form.serviceType} onChange={(event) => updateField("serviceType", event.target.value)} disabled={isSimpleRental}>
                <option>Voice</option>
                <option>Voice and data</option>
                <option>Data only</option>
              </select>
            </label>
            <label className="field">
              <span>Start date</span>
              <input type="date" value={form.startDate} onChange={(event) => updateField("startDate", event.target.value)} />
            </label>
            <label className="field">
              <span>End date</span>
              <input type="date" value={form.endDate} onChange={(event) => updateField("endDate", event.target.value)} />
            </label>
            <label className="field">
              <span>Total days</span>
              <input value={totalDays || ""} readOnly disabled />
            </label>
          </div>

          {isRcukRental ? (
            <>
              <div className="form-grid">
                <label className="field">
                  <span>UK days</span>
                  <input inputMode="numeric" value={form.ukDays} onChange={(event) => updateField("ukDays", event.target.value)} />
                </label>
                <label className="field">
                  <span>EU days</span>
                  <input inputMode="numeric" value={form.euDays} onChange={(event) => updateField("euDays", event.target.value)} />
                </label>
                <label className="field">
                  <span>WTS days</span>
                  <input inputMode="numeric" value={form.wtsDays} onChange={(event) => updateField("wtsDays", event.target.value)} />
                </label>
                <label className="field">
                  <span>Zone day total</span>
                  <input value={zoneDays || ""} readOnly disabled />
                </label>
              </div>

              <div className="toggle-row">
                <label><input type="checkbox" checked={form.addSms} onChange={(event) => updateField("addSms", event.target.checked)} /> Add SMS</label>
                <label><input type="checkbox" checked={form.usaNumber} onChange={(event) => updateField("usaNumber", event.target.checked)} /> USA number</label>
              </div>
            </>
          ) : null}

          <div className="form-grid">
            <label className="field">
              <span>Device kind</span>
              <select value={form.deviceKind} onChange={(event) => updateField("deviceKind", event.target.value)}>
                <option>SIM only</option>
                <option>Basic phone</option>
                <option>Upgraded phone</option>
              </select>
            </label>
            <label className="field">
              <span>Phone model</span>
              <input value={form.model} onChange={(event) => updateField("model", event.target.value)} placeholder="Optional for SIM only" />
            </label>
            <label className="field">
              <span>IMEI / device ID</span>
              <input value={form.imei} onChange={(event) => updateField("imei", event.target.value)} inputMode="numeric" autoComplete="off" spellCheck={false} placeholder="Scan or type 15-digit IMEI" />
            </label>
            <label className="field">
              <div className="field-label-row">
                <span>SIM number</span>
                {isRcukRental ? (
                  <button
                    className="sim-check-btn"
                    type="button"
                    onClick={checkSimWithRcuk}
                    disabled={!normalizedSimNumber || simCheckState.status === "checking"}
                  >
                    {simCheckState.status === "checking" ? "Checking…" : "Check SIM"}
                  </button>
                ) : null}
              </div>
              <input
                inputMode="numeric"
                value={isRcukRental ? normalizedSimNumber : form.simNumber}
                onChange={(event) => updateField("simNumber", event.target.value)}
              />
            </label>
          </div>

          <div className="form-grid">
            <label className="field">
              <span>Customer phone</span>
              <CustomerPhoneInput
                value={form.customerPhone}
                onChange={(value) => updateField("customerPhone", value)}
                customers={customers}
                onSaveCustomerName={onSaveCustomerName}
                onSaveCustomer={onSaveCustomer}
                onSelectCustomer={(customer) => updateField("customerPhone", customer.phone)}
                required
              />
            </label>
            <label className="field">
              <span>Days until return</span>
              <input inputMode="numeric" value={form.returnDays} onChange={(event) => updateField("returnDays", event.target.value)} />
            </label>
            <label className="field">
              <span>Payment method</span>
              <select value={form.paymentMethod} onChange={(event) => updateField("paymentMethod", event.target.value)}>
                <option value="" disabled>Select one</option>
                {paymentMethods.map((method) => <option key={method}>{method}</option>)}
              </select>
            </label>
            <label className="field">
              <span>Return reminder</span>
              <select value={form.returnReminderPreference} onChange={(event) => updateField("returnReminderPreference", event.target.value)}>
                <option>Text message</option>
                <option>Phone call</option>
                <option>Both</option>
              </select>
            </label>
            <label className="field">
              <span>Late fee per week (if overdue)</span>
              <input
                inputMode="decimal"
                value={form.lateFeeWeekly}
                onChange={(event) => updateField("lateFeeWeekly", event.target.value)}
                placeholder="0.00"
              />
              {(Number.parseFloat(form.lateFeeWeekly) || 0) > 0 ? (
                <small className="muted">{formatMoney((Number.parseFloat(form.lateFeeWeekly) || 0) / 7)}/day after the return date</small>
              ) : null}
            </label>
            <label className="field">
              <span>Served by</span>
              <input value={activeEmployee} disabled readOnly />
            </label>
          </div>

          {requiresSolaCharge ? (
            <div className="payment-panel">
              <div>
                <p className="eyebrow">Card payment</p>
                <h3>Sola charge</h3>
              </div>
              <label className="field">
                <span>Sola token / SUT</span>
                <input value={solaState.paymentToken} onChange={(event) => updateSolaToken(event.target.value)} />
              </label>
              <button className="secondary-button" type="button" onClick={chargeWithSola} disabled={!totalPrice || !solaState.paymentToken || solaState.status === "charging"}>
                Charge with Sola
              </button>
              <p className={solaState.status === "error" ? "summary-error" : "muted"}>{solaState.message}</p>
            </div>
          ) : null}

          <label className="field full">
            <span>Notes</span>
            <textarea value={form.notes} onChange={(event) => updateField("notes", event.target.value)} rows="4" />
          </label>

          <div className="form-actions">
            {isRcukRental ? (
              <>
                <button className="primary-button" type="button" onClick={submitRentalToRcuk} disabled={!canSubmitRental || submitState.status === "submitting"}>
                  Submit rental
                </button>
                <button className="secondary-button" type="button" onClick={getRentalNumbers} disabled={!submitState.rentalId || submitState.status === "getting-numbers"}>
                  Get numbers
                </button>
              </>
            ) : null}
            <button className="primary-button" type="button" onClick={saveRentalReport} disabled={!canSave}>
              Save rental report
            </button>
          </div>
        </div>

        <aside className="rental-summary">
          <p className="eyebrow">Rental total</p>
          <h3>{formatMoney(totalPrice)}</h3>
          <div className="summary-line"><span>Daily rate</span><strong>{formatMoney(dailyRate)}</strong></div>
          <div className="summary-line"><span>Pricing</span><strong>{rentalPricing.label}</strong></div>
          <div className="summary-line"><span>Total days</span><strong>{totalDays || 0}</strong></div>
          {isRcukRental ? (
            <div className={zoneDaysValid ? "summary-ok" : "summary-error"}>
              UK + EU + WTS: {zoneDays || 0} / {totalDays || 0}
            </div>
          ) : null}
          {!minimumDaysValid && totalDays > 0 ? (
            <div className="summary-error">Minimum rental is {getMinimumRentalDays(form.rentalRegion)} days.</div>
          ) : null}
          {(isRcukRental ? !canSubmitRental : !canSave) ? (
            <div className="summary-error">{isRcukRental ? "Complete all rental fields before submitting." : "Complete all rental fields before saving."}</div>
          ) : null}
          {requiresSolaCharge && !solaChargeComplete ? (
            <div className="summary-error">Sola payment approval is required before saving a CC rental.</div>
          ) : null}
          {isRcukRental ? (
            <div className="rental-result">
              <span>Rental ID</span>
              <input value={submitState.rentalId} readOnly />
              <span>CLI</span>
              <input value={submitState.cli} readOnly />
              <span>US DDI</span>
              <input value={submitState.usDdi} readOnly />
              <span>Get numbers tried</span>
              <input value={submitState.getNumbersAttempted ? "Yes" : "No"} readOnly />
              <span>SIM check</span>
              <input value={simCheckState.checkedSimNumber || ""} readOnly />
              {simCheckState.message ? (
                <p className={simCheckState.status === "error" ? "summary-error" : "muted"}>{simCheckState.message}</p>
              ) : null}
              <p className={submitState.status === "error" ? "summary-error" : "muted"}>{submitState.message}</p>
            </div>
          ) : null}
        </aside>
      </div>
    </section>
  );
}

function ReportHistory({
  employees,
  storeLocations,
  reports,
  filters,
  onFiltersChange,
  onClearFilters,
  onStatusChange,
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
              reports.map((report) => (
                <ReportRow
                  report={report}
                  key={report.id}
                  onStatusChange={onStatusChange}
                  onDeleteReport={onDeleteReport}
                  onReturn={onReturn}
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

function OpenRepairsPage({ reports, onStatusChange, onSetReady, onMarkPaid, onEditRepair }) {
  const [paying, setPaying] = useState({ id: "", status: "", message: "" });
  // When set, the final-price dialog is open for this repair before it goes Ready.
  const [finalPrompt, setFinalPrompt] = useState(null);
  // When set, the edit dialog is open for this repair.
  const [editing, setEditing] = useState(null);
  const openRepairs = reports.filter((report) =>
    report.type === "repair" && !["Completed", "Cancelled"].includes(report.details?.status),
  );

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

  // Mark a repair paid. For card payments, run the charge on the local terminal
  // first and only mark paid once the card is approved. The "paid" SMS to the
  // customer is sent by the notifyRepairPaid Cloud Function on the status change.
  async function handleMarkPaid(repair) {
    if (repair.details?.paymentStatus === "Paid") return;
    const needsTerminal = ["CC", "Card"].includes(repair.paymentMethod);

    if (!needsTerminal) {
      onMarkPaid(repair.id);
      setPaying({ id: "", status: "", message: "" });
      return;
    }

    const amount = Number.parseFloat(repair.paymentAmount);
    if (!Number.isFinite(amount) || amount <= 0) {
      window.alert("Set a payment amount on this repair before charging the card.");
      return;
    }

    try {
      setPaying({ id: repair.id, status: "charging", message: "Follow the terminal: tap, insert, or swipe the card." });
      const result = await chargeOnLocalTerminal({
        amount: amount.toFixed(2),
        externalRequestId: `repair-${repair.id}`.slice(0, 32),
        onStatus: (text) => setPaying((current) => ({ ...current, message: text })),
      });
      onMarkPaid(repair.id, {
        paymentRefNum: result.refNum || "",
        cardType: result.cardType || "",
        maskedCardNumber: result.maskedCardNumber || "",
      });
      setPaying({ id: "", status: "", message: "" });
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
                const needsTerminal = ["CC", "Card"].includes(repair.paymentMethod);
                return (
                  <tr key={repair.id}>
                    <td><strong>{repair.details?.ticketNumber || "-"}</strong></td>
                    <td>{formatShortDate(repair.createdAt)}</td>
                    <td>{repair.location || repair.details?.location || "-"}</td>
                    <td>{repair.customerPhone || "-"}</td>
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
                            className="secondary-button compact-button"
                            type="button"
                            disabled={isCharging}
                            onClick={() => handleMarkPaid(repair)}
                          >
                            {isCharging ? "Charging…" : needsTerminal ? "Charge card & mark paid" : "Mark paid"}
                          </button>
                        </div>
                      )}
                      {paying.id === repair.id && paying.message ? (
                        <p className={paying.status === "error" ? "summary-error" : "muted"}>{paying.message}</p>
                      ) : null}
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
                <td colSpan="10" className="empty-state">No open repairs.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

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

function EditRepairDialog({ repair, onSave, onClose }) {
  const details = repair.details || {};
  const [form, setForm] = useState({
    model: details.model || "",
    damage: details.damage || "",
    imei: details.imei || "",
    estimatedPrice: details.estimatedPrice || repair.paymentAmount || "",
    finalPrice: details.finalPrice || "",
    dueDate: details.dueDate || "",
    notificationPreference: details.notificationPreference || "Text message",
    paymentMethod: repair.paymentMethod || "",
    customerPhone: repair.customerPhone || "",
    notes: repair.notes || "",
  });

  const set = (name, value) => setForm((current) => ({ ...current, [name]: value }));

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
        estimatedPrice: String(form.estimatedPrice ?? "").trim(),
        finalPrice: String(form.finalPrice ?? "").trim(),
        dueDate: form.dueDate,
        notificationPreference: form.notificationPreference,
      },
    });
  }

  return createPortal(
    <div className="dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <div className="dialog-card dialog-card-wide" role="dialog" aria-modal="true" onMouseDown={(event) => event.stopPropagation()}>
        <h2>Edit repair {details.ticketNumber ? `#${details.ticketNumber}` : ""}</h2>
        <form className="form-grid" onSubmit={submit}>
          <label className="field"><span>Phone model</span><input value={form.model} onChange={(event) => set("model", event.target.value)} autoFocus /></label>
          <label className="field"><span>What is damaged?</span><input value={form.damage} onChange={(event) => set("damage", event.target.value)} /></label>
          <label className="field"><span>Phone IMEI</span><input value={form.imei} inputMode="numeric" onChange={(event) => set("imei", event.target.value)} /></label>
          <label className="field"><span>Customer phone</span><input value={form.customerPhone} inputMode="tel" onChange={(event) => set("customerPhone", event.target.value)} /></label>
          <label className="field"><span>Estimated price</span><input value={form.estimatedPrice} inputMode="decimal" placeholder="0.00" onChange={(event) => set("estimatedPrice", event.target.value)} /></label>
          <label className="field"><span>Final price</span><input value={form.finalPrice} inputMode="decimal" placeholder="0.00" onChange={(event) => set("finalPrice", event.target.value)} /></label>
          <label className="field"><span>Expected ready date</span><input type="date" value={form.dueDate} onChange={(event) => set("dueDate", event.target.value)} /></label>
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
          <label className="field full"><span>Notes</span><textarea rows={2} value={form.notes} onChange={(event) => set("notes", event.target.value)} /></label>
          <div className="pos-form-actions form-actions-row">
            <button className="primary-button" type="submit">Save changes</button>
            <button className="secondary-button" type="button" onClick={onClose}>Cancel</button>
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
        <h2>Final price</h2>
        <p className="muted">
          Enter the final price for repair {prompt.ticket ? `#${prompt.ticket}` : ""} before marking it Ready.
          This becomes the amount the customer owes.
        </p>
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

function PendingReportsPage({ pendingReports, activeEmployee, customers, onSaveCustomerName, onSaveCustomer, onClaim, onSave }) {
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
              customers={customers}
              onSaveCustomerName={onSaveCustomerName}
              onSaveCustomer={onSaveCustomer}
              onClaim={onClaim}
              onSave={onSave}
            />
          ))
        ) : (
          <p className="empty-state">No pending reports.</p>
        )}
      </div>
    </section>
  );
}

function PendingReportCard({ pendingReport, activeEmployee, customers, onSaveCustomerName, onSaveCustomer, onClaim, onSave }) {
  const imported = pendingReport.imported || {};
  const isCallReport = pendingReport.type === "call" || pendingReport.source === "telebroad";
  const isShopifySale = pendingReport.source === "shopify_pos";
  const importedAgentName = (
    imported.employeeName
    || pendingReport.details?.handledBy
    || ""
  ).trim();
  const readyToComplete = isShopifySale || Boolean(importedAgentName);
  const claimedBySomeoneElse = !readyToComplete && pendingReport.claimedBy && pendingReport.claimedBy !== activeEmployee;
  const isClaimedByMe = readyToComplete || pendingReport.claimedBy === activeEmployee;
  const imeiInputRef = useRef(null);
  // If the caller's number is already in the CRM, pull their saved name and
  // address so the employee only has to add the call reason.
  const crmMatch = useMemo(() => {
    const digits = localPhoneDigits(
      pendingReport.customerPhone || imported.customerPhone || imported.callerIdExternal || "",
    );
    if (!digits) return null;
    return (customers || []).find(
      (entry) => entry.phoneDigits === digits || entry.mobileDigits === digits,
    ) || null;
  }, [customers, pendingReport.customerPhone, imported.customerPhone, imported.callerIdExternal]);
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

  const sourceLabel = isCallReport
    ? "Telebroad call"
    : isShopifySale
      ? "Shopify POS"
      : "Pending";
  const cardTitle = pendingReport.title
    || imported.shopifyOrderName
    || (isCallReport ? "Pending call report" : "Pending sale");

  return (
    <article className={`pending-card ${isClaimedByMe ? "claimed" : ""}`}>
      <div className="pending-card-head">
        <div>
          <p className="eyebrow">{sourceLabel}</p>
          <h3>{cardTitle}</h3>
        </div>
        <span className={`badge ${isCallReport ? "call" : "sale"}`}>{pendingReport.type || "sale"}</span>
      </div>

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
            {callRecordingUrl(imported.callId, imported.uniqueId) ? (
              <a className="secondary-button compact-button" href={callRecordingUrl(imported.callId, imported.uniqueId)} target="_blank" rel="noopener noreferrer">
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
              customers={customers}
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
                  placeholder="Scan or type 15-digit IMEI"
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
    </article>
  );
}

function PhoneOrderPage({ activeEmployee, sessionRole, activeLocation, storeLocations, phoneOrders, orderHandlers, storeTax, storeDevices, products, customers, onSaveCustomerName, onSaveCustomer, onCreate, onMarkReady, onAssignDriver, onCancel, onDelivered }) {
  const [outOfState, setOutOfState] = useState(false);
  const [form, setForm] = useState({
    location: activeLocation || (storeLocations || [])[0] || "",
    customerName: "",
    customerPhone: "",
    contactDetails: "",
    customerAddress: "",
    deliveryAddress: "",
    paymentStatus: "Paid",
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
    && Boolean(form.paymentMethod)
    && cart.length > 0;

  function updateField(name, value) {
    setForm((current) => ({ ...current, [name]: value }));
  }

  function handleCreateOrder() {
    if (!canCreate) return;
    const matched = (customers || []).find(
      (entry) => entry.phoneDigits === localPhoneDigits(form.customerPhone) || entry.mobileDigits === localPhoneDigits(form.customerPhone),
    ) || null;
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
      notes: "",
    }));
    setMessage(`Order created and sent to ${order.location || "the store"}.`);
  }

  function handleCustomerPromptSave(values) {
    if (!customerPrompt) return;
    onSaveCustomer?.({
      id: customerPrompt.customer?.id || "",
      phone: customerPrompt.phone,
      name: values.name.trim(),
      mobile: values.mobile.trim(),
      address: values.address.trim(),
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
              customers={customers}
              onSaveCustomerName={onSaveCustomerName}
              onSaveCustomer={onSaveCustomer}
              onSelectCustomer={fillFromCustomer}
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

          {form.paymentStatus === "Paid" && ["CC", "Card"].includes(form.paymentMethod) ? (
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
          <button className="primary-button pos-complete-button" type="button" disabled={!canCreate} onClick={handleCreateOrder}>
            {cart.length ? `Create order · ${formatMoney(orderTotal)}` : "Scan items to start"}
          </button>
        </div>
      </div>

      {customerPrompt ? (
        <CustomerInfoDialog
          phone={customerPrompt.phone}
          customer={customerPrompt.customer}
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

function StoreOrderCard({ order, products, onMarkReady, onCancel }) {
  const imeiLines = (order.lineItems || []).filter((line) => line.requiresImei);
  const [imeis, setImeis] = useState(() => imeiLines.map((line) => line.imei || ""));
  const [cardEntryMode, setCardEntryMode] = useState("terminal");
  const [card, setCard] = useState({ status: "idle", message: "", refNum: "" });

  const requiresCardCharge = order.paymentStatus === "Paid" && ["CC", "Card"].includes(order.paymentMethod);
  const cardCharged = !requiresCardCharge || card.status === "paid";

  function imeiStatus(index) {
    const value = imeis[index];
    if (!value) return "missing";
    if (imeis.filter((other) => other === value).length > 1) return "duplicate";
    const stock = products.find((product) => product.id === imeiLines[index].productId)?.imeis || [];
    if (stock.length > 0 && !stock.includes(value)) return "notstock";
    return "ok";
  }
  const imeisOk = imeiLines.every((_, index) => imeiStatus(index) === "ok");
  const canReady = imeisOk && cardCharged;

  async function chargeCard() {
    const amount = Number(order.orderTotal) || 0;
    if (!requiresCardCharge || !amount) return;
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
      cardStatus: requiresCardCharge ? "paid" : "",
      solaRefNum: requiresCardCharge ? card.refNum : "",
      paymentStatus: requiresCardCharge ? "Paid" : order.paymentStatus,
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

      {requiresCardCharge ? (
        <div className="payment-panel payment-panel-stack">
          <div>
            <p className="eyebrow">Card payment</p>
            <h3>Charge {formatPayment(order.orderTotal)} on the terminal</h3>
          </div>
          <div className="segmented-control" role="tablist" aria-label="Card entry mode">
            <button type="button" className={cardEntryMode === "terminal" ? "selected" : ""} onClick={() => setCardEntryMode("terminal")} disabled={card.status === "charging" || card.status === "paid"}>Tap / dip / swipe</button>
            <button type="button" className={cardEntryMode === "manual" ? "selected" : ""} onClick={() => setCardEntryMode("manual")} disabled={card.status === "charging" || card.status === "paid"}>Manual entry</button>
          </div>
          <button className="secondary-button" type="button" onClick={chargeCard} disabled={card.status === "charging" || card.status === "paid"}>
            {card.status === "paid" ? "Card charged" : card.status === "charging" ? "Waiting for card..." : cardEntryMode === "manual" ? "Charge card (manual entry)" : "Charge card (tap / dip / swipe)"}
          </button>
          {card.message ? <p className={card.status === "error" ? "summary-error" : "muted"}>{card.message}</p> : null}
        </div>
      ) : null}

      {!imeisOk ? <p className="muted pos-warning">Scan a valid in-stock IMEI for every phone.</p> : null}
      {imeisOk && !cardCharged ? <p className="muted pos-warning">Charge the card before marking ready.</p> : null}
      <div className="order-card-actions">
        <button className="primary-button" type="button" disabled={!canReady} onClick={markReady}>
          Mark ready
        </button>
        <button className="secondary-button" type="button" onClick={() => confirmCancelOrder(order, onCancel)}>
          Cancel order
        </button>
      </div>
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
            <article className="pending-card" key={order.id}>
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
              <div className="order-card-actions">
                <button className="primary-button" type="button" disabled={!canDeliver} onClick={() => onDelivered(order.id)}>
                  Mark delivered
                </button>
                <button className="secondary-button" type="button" disabled={!canDeliver} onClick={() => confirmCancelOrder(order, onCancel)}>
                  Cancel order
                </button>
              </div>
            </article>
          );
        }) : (
          <p className="empty-state">No open deliveries.</p>
        )}
      </div>
    </div>
  );
}

function PosPage({ products, activeEmployee, activeLocation, activeDeviceId, activeTaxRate, activeStoreInfo, customers, onSaveCustomerName, onSaveCustomer, onCompleteSale }) {
  const [cart, setCart] = useState([]);
  const [scan, setScan] = useState("");
  const [scanMode, setScanMode] = useState(true);
  const [productSearch, setProductSearch] = useState("");
  const [customerPhone, setCustomerPhone] = useState("");
  const [paymentMethod, setPaymentMethod] = useState("");
  const [outOfState, setOutOfState] = useState(false);
  const [notes, setNotes] = useState("");
  const [message, setMessage] = useState("");
  const [completedSale, setCompletedSale] = useState(null);
  const [customerPrompt, setCustomerPrompt] = useState(null);
  const [cardEntryMode, setCardEntryMode] = useState("terminal");
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

  // Quick-add only surfaces matches once a couple of characters are typed,
  // instead of listing the entire catalog up front.
  const quickAddProducts = useMemo(() => {
    const clean = productSearch.trim().toLowerCase();
    if (clean.length < 2) return [];
    return availableProducts.filter((product) =>
      [product.name, product.sku, product.barcode, product.category]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(clean),
    );
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

  function addProductToCart(product) {
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
        return [...current, makeLine(product)];
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
    const digits = String(imei || "").replace(/\D/g, "").slice(0, 15);
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

  const subtotal = cart.reduce((sum, line) => sum + effectiveLinePrice(line) * line.qty, 0);
  const taxRate = Number(activeTaxRate) || 0;
  const taxApplies = !outOfState && taxRate > 0;
  const taxAmount = taxApplies ? subtotal * (taxRate / 100) : 0;
  const total = subtotal + taxAmount;
  const itemCount = cart.reduce((sum, line) => sum + line.qty, 0);
  const requiresCardCharge = ["CC", "Card"].includes(paymentMethod);
  const cardChargeComplete = !requiresCardCharge || card.status === "paid";
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
  const canCheckout = cart.length > 0 && !imeiIssue && cardChargeComplete && Boolean(paymentMethod);

  useEffect(() => {
    setCard((current) =>
      current.status === "idle" ? current : { status: "idle", message: "", refNum: "" },
    );
  }, [total, paymentMethod]);

  async function chargeCard() {
    if (!requiresCardCharge || !total) return;
    try {
      setCard({ status: "charging", message: "Sending sale to the terminal...", refNum: "" });
      const result = await chargeOnLocalTerminal({
        amount: total.toFixed(2),
        externalRequestId: `sale-${Date.now()}`,
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

  function findSaleCustomer() {
    const localDigits = localPhoneDigits(customerPhone);
    if (localDigits.length < 6) return null;
    return (customers || []).find(
      (entry) => entry.phoneDigits === localDigits || entry.mobileDigits === localDigits,
    ) || null;
  }

  function handleCheckout() {
    if (!canCheckout) {
      if (imeiIssue) setMessage(imeiIssue);
      else if (!paymentMethod) setMessage("Choose a payment method before completing the sale.");
      else if (!cardChargeComplete) setMessage("Charge the card before completing the sale.");
      return;
    }
    const localDigits = localPhoneDigits(customerPhone);
    const saleCustomer = findSaleCustomer();
    // If a real phone was entered but the customer is new or missing a name /
    // address, prompt for those before finishing so the receipt + CRM are filled.
    if (localDigits.length >= 6 && (!saleCustomer || !saleCustomer.name || !saleCustomer.address)) {
      setCustomerPrompt({ phone: customerPhone.trim(), customer: saleCustomer });
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
      paymentMethod,
      notes: notes.trim(),
      createdAt: new Date().toISOString(),
      details: {
        request: "POS sale",
        productType: cart.length === 1 ? cart[0].category || "Item" : "Mixed",
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
        storeAddress: activeStoreInfo?.address || "",
        storeHours: activeStoreInfo?.hours || "",
        customerName: customerInfo?.name || "",
        customerMobile: customerInfo?.mobile || "",
        customerAddress: customerInfo?.address || "",
        cardStatus: requiresCardCharge ? card.status : "",
        solaRefNum: requiresCardCharge ? card.refNum : "",
      },
    };
    onCompleteSale(sale);
    setCompletedSale(sale);
    printSaleReceipt(sale);
    setCart([]);
    setCustomerPhone("");
    setNotes("");
    setPaymentMethod("");
    setOutOfState(false);
    setCard({ status: "idle", message: "", refNum: "" });
    setMessage("");
  }

  // Saves the entered/updated customer to the CRM, then finishes the sale with
  // those details on the receipt.
  function handleCustomerPromptSave(values) {
    if (!customerPrompt) return;
    const info = {
      name: values.name.trim(),
      mobile: values.mobile.trim(),
      address: values.address.trim(),
    };
    onSaveCustomer?.({
      id: customerPrompt.customer?.id || "",
      phone: customerPrompt.phone,
      mobile: info.mobile,
      name: info.name,
      address: info.address,
    });
    setCustomerPrompt(null);
    completeSale(info);
  }

  // Cashier chose not to add details — finish with whatever the CRM already has.
  function handleCustomerPromptSkip() {
    const customer = customerPrompt?.customer || null;
    setCustomerPrompt(null);
    completeSale(customer);
  }

  function startNewSale() {
    setCompletedSale(null);
    setCard({ status: "idle", message: "", refNum: "" });
    setMessage("Ready for the next customer.");
    setTimeout(() => scanRef.current?.focus(), 0);
  }

  return (
    <>
      <section className="workspace pos-hero">
        <div className="workspace-header">
          <div>
            <p className="eyebrow">Point of sale</p>
            <h2>Scan items and check out</h2>
          </div>
          <div className="summary-strip">
            <span className="metric">Store <strong>{activeLocation || "Unassigned"}</strong></span>
            <span className="metric">Cashier <strong>{activeEmployee}</strong></span>
          </div>
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
                        <p className="muted">{line.sku}</p>
                      </td>
                      <td>
                        {formatMoney(line.price)}
                        {adjust ? <p className="muted">→ {formatMoney(unitPrice)}</p> : null}
                      </td>
                      <td>
                        <input
                          className="pos-adjust"
                          value={line.adjustCode}
                          onChange={(event) => updateAdjust(line.lineId, event.target.value)}
                          placeholder="+/- $"
                          inputMode="text"
                          autoComplete="off"
                          spellCheck={false}
                        />
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
                      <td>
                        <button className="secondary-button" type="button" onClick={() => removeLine(line.lineId)}>
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

        <section className="workspace pos-checkout">
          <div className="workspace-header">
            <div>
              <p className="eyebrow">Checkout</p>
              <h2>{formatMoney(total)}</h2>
            </div>
          </div>
          <div className="form-grid">
            <label className="field">
              <span>Customer phone (optional)</span>
              <CustomerPhoneInput
                value={customerPhone}
                onChange={setCustomerPhone}
                customers={customers}
                onSaveCustomerName={onSaveCustomerName}
                onSaveCustomer={onSaveCustomer}
                onSelectCustomer={(customer) => setCustomerPhone(customer.phone)}
                placeholder="For receipt / follow-up"
              />
            </label>
            <label className="field">
              <span>Payment method</span>
              <select value={paymentMethod} onChange={(event) => setPaymentMethod(event.target.value)}>
                <option value="" disabled>Select one</option>
                {paymentMethods.map((method) => (
                  <option key={method}>{method}</option>
                ))}
              </select>
            </label>
            <label className="field full">
              <span>Notes (optional)</span>
              <textarea value={notes} onChange={(event) => setNotes(event.target.value)} rows={2} />
            </label>
          </div>

          <div className="pos-totals">
            <div className="pos-totals-row"><span>Subtotal</span><span>{formatMoney(subtotal)}</span></div>
            <label className="checkbox-field pos-out-of-state">
              <input type="checkbox" checked={outOfState} onChange={(event) => setOutOfState(event.target.checked)} />
              <span>Out of state (no sales tax)</span>
            </label>
            <div className="pos-totals-row">
              <span>Tax{taxApplies ? ` (${taxRate}%)` : ""}</span>
              <span>{formatMoney(taxAmount)}</span>
            </div>
            {!outOfState && taxRate === 0 ? (
              <p className="muted">No tax rate set for this store. Add the store address in Inventory.</p>
            ) : null}
            <div className="pos-totals-row pos-totals-grand"><span>Total</span><strong>{formatMoney(total)}</strong></div>
          </div>

          {requiresCardCharge ? (
            <div className="payment-panel payment-panel-stack">
              <div>
                <p className="eyebrow">Card payment (Verifone P200)</p>
                <h3>Charge {formatMoney(total)} on the terminal</h3>
              </div>
              <div className="card-reader-row">
                <span className="reader-dot connected" aria-hidden="true" />
                <span className="muted">Verifone P200 · local terminal (Sola BBPOS)</span>
              </div>
              <div className="segmented-control" role="tablist" aria-label="Card entry mode">
                <button type="button" className={cardEntryMode === "terminal" ? "selected" : ""} onClick={() => setCardEntryMode("terminal")} disabled={card.status === "charging" || card.status === "paid"}>Tap / dip / swipe</button>
                <button type="button" className={cardEntryMode === "manual" ? "selected" : ""} onClick={() => setCardEntryMode("manual")} disabled={card.status === "charging" || card.status === "paid"}>Manual entry</button>
              </div>
              <button
                className="secondary-button"
                type="button"
                onClick={chargeCard}
                disabled={!total || card.status === "charging" || card.status === "paid"}
              >
                {card.status === "paid"
                  ? "Card charged"
                  : card.status === "charging"
                    ? "Waiting for card..."
                    : cardEntryMode === "manual"
                      ? "Charge card (manual entry)"
                      : "Charge card (tap / dip / swipe)"}
              </button>
              {card.message ? (
                <p className={card.status === "error" ? "summary-error" : "muted"}>{card.message}</p>
              ) : null}
            </div>
          ) : null}
          {imeiIssue ? (
            <p className="muted pos-warning">{imeiIssue}</p>
          ) : null}
          {requiresCardCharge && !cardChargeComplete && !imeiIssue ? (
            <p className="muted pos-warning">Charge the card before completing the sale.</p>
          ) : null}
          <p className="muted pos-checkout-hint">Use the Complete sale bar at the bottom of the screen.</p>
        </section>
      </div>

      <section className="history">
        <div className="history-header">
          <div>
            <p className="eyebrow">Quick add</p>
            <h2>Find a product</h2>
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
          {quickAddProducts.length ? (
            quickAddProducts.map((product) => (
              <button
                className="pos-product"
                type="button"
                key={product.id}
                onClick={() => {
                  if (addProductToCart(product)) setMessage(`Added ${product.name}.`);
                  scanRef.current?.focus();
                }}
              >
                <strong>{product.name}</strong>
                <span>{formatMoney(Number(product.price) || 0)}</span>
                <small className="muted">
                  {product.requiresImei
                    ? `In stock ${product.imeis?.length || 0} - IMEI`
                    : `Stock ${Number(product.quantity) || 0}`}
                </small>
              </button>
            ))
          ) : (
            <p className="empty-state">{productSearch.trim().length >= 2 ? "No matching products for this store." : "Start typing to find a product."}</p>
          )}
        </div>
      </section>

      <div className="pos-action-spacer" />
      <div className="pos-action-bar">
        <div className="pos-action-bar-info">
          <span>{itemCount} item{itemCount === 1 ? "" : "s"} · {activeLocation || "Store"}</span>
          <strong>{formatMoney(total)}</strong>
        </div>
        <div className="pos-action-bar-cta">
          {imeiIssue ? <span className="pos-action-warn">{imeiIssue}</span> : null}
          {!imeiIssue && requiresCardCharge && !cardChargeComplete ? <span className="pos-action-warn">Charge the card first</span> : null}
          <button className="primary-button pos-complete-button" type="button" disabled={!canCheckout} onClick={handleCheckout}>
            {cart.length ? `Complete sale · ${formatMoney(total)}` : "Scan items to start"}
          </button>
        </div>
      </div>

      {customerPrompt ? (
        <CustomerInfoDialog
          phone={customerPrompt.phone}
          customer={customerPrompt.customer}
          onSave={handleCustomerPromptSave}
          onSkip={handleCustomerPromptSkip}
          onClose={() => setCustomerPrompt(null)}
        />
      ) : null}

      {completedSale ? (
        <SaleReceiptDialog sale={completedSale} onClose={startNewSale} />
      ) : null}
    </>
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

// Prompt shown at checkout when the entered phone is a new customer or is missing
// a name / address — captures those for the receipt and the CRM.
function CustomerInfoDialog({ phone, customer, onSave, onSkip, onClose }) {
  const isNew = !customer;
  const [name, setName] = useState(customer?.name || "");
  const [mobile, setMobile] = useState(customer?.mobile || "");
  const [address, setAddress] = useState(customer?.address || "");

  function submit(event) {
    event.preventDefault();
    // Stop the submit from bubbling (through React's portal tree) to any parent
    // report/order form, which would otherwise also fire its own submit.
    event.stopPropagation();
    onSave({ name, mobile, address });
  }

  // Rendered through a portal so the dialog's <form> is never nested inside the
  // parent report/order form. Nested forms make the browser submit the outer
  // form instead — which skips this dialog's save and reloads the app.
  return createPortal(
    <div className="dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <div className="dialog-card" role="dialog" aria-modal="true" onMouseDown={(event) => event.stopPropagation()}>
        <h2>{isNew ? "Add new customer" : "Complete customer details"}</h2>
        <p className="muted">
          {isNew
            ? `${phone} isn't in the CRM yet. Add their details for the receipt and follow-up.`
            : `${phone} is missing some details. Add them for the receipt and follow-up.`}
        </p>
        <form className="form-grid" onSubmit={submit}>
          <label className="field"><span>Phone</span><input value={phone} disabled /></label>
          <label className="field"><span>Name</span><input value={name} onChange={(event) => setName(event.target.value)} autoFocus /></label>
          <label className="field"><span>Mobile (optional)</span><input value={mobile} inputMode="tel" onChange={(event) => setMobile(event.target.value)} /></label>
          <AddressAutocomplete value={address} onChange={setAddress} />
          <div className="pos-form-actions form-actions-row">
            <button className="primary-button" type="submit">Save &amp; complete sale</button>
            <button className="secondary-button" type="button" onClick={onSkip}>Skip</button>
          </div>
        </form>
      </div>
    </div>,
    document.body,
  );
}

// Shared 80mm thermal receipt styling.
const THERMAL_BASE_CSS = `
  @page { size: 80mm auto; margin: 0; }
  html, body { margin: 0; }
  body { width: 80mm; box-sizing: border-box; padding: 8px 9px 14px; color: #000;
    font-family: ui-sans-serif, system-ui, "Segoe UI", sans-serif; font-size: 12.5px; line-height: 1.38; }
  /* Thermal printers are monochrome — render the wordmark logo as crisp black. */
  .receipt-logo { display: block; max-width: 72mm; max-height: 64px; margin: 0 auto 6px; object-fit: contain;
    filter: grayscale(1) brightness(0); }
  table { width: 100%; border-collapse: collapse; }
  td { padding: 4px 0; vertical-align: top; }
  .meta { font-size: 11.5px; text-align: center; }
  .divider { border-top: 1px dashed #000; margin: 7px 0; }
  .contact { text-align: center; font-size: 11px; }
  .store-name { text-align: center; font-weight: 800; margin-top: 6px; }
  .store-addr { text-align: center; font-size: 11px; }
  .cust { text-align: center; font-size: 11.5px; margin-top: 2px; }
  .hours { text-align: center; font-size: 11px; margin-bottom: 4px; }
  .thanks { text-align: center; margin-top: 10px; font-weight: 700; }
  .feedback { text-align: center; font-size: 10.5px; margin-top: 4px; }
  .powered { text-align: center; font-size: 9.5px; margin-top: 8px; color: #333; }
  small { color: #000; }
`;

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
  const phoneLine = [phone, mobile].filter(Boolean).join(" / ");
  return `<div class="cust">${name ? `${escapeHtml(name)}<br/>` : ""}${phoneLine ? `${escapeHtml(phoneLine)}<br/>` : ""}${address ? escapeHtml(address) : ""}</div>`;
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
    ? `<div class="barcode">${code128Svg(receiptCode, { moduleWidth: 2, height: 56 })}<div class="barcode-text">${escapeHtml(receiptCode)}</div></div>`
    : "";

  const taxAmount = Number(details.taxAmount) || 0;
  const taxBlock = taxAmount > 0 || Number(details.subtotal) > 0
    ? `
    <div class="line"><span>Subtotal</span><span>${formatMoney(Number(details.subtotal) || 0)}</span></div>
    <div class="line"><span>Tax${details.taxRate ? ` (${details.taxRate}%)` : ""}</span><span>${formatMoney(taxAmount)}</span></div>`
    : "";

  const css = `
    .line { display: flex; justify-content: space-between; font-size: 12px; }
    .total { font-size: 15px; font-weight: 800; display: flex; justify-content: space-between; margin-top: 4px; }
    .paid { font-size: 11.5px; text-align: center; margin-top: 6px; }
    .barcode { text-align: center; margin-top: 12px; }
    .barcode svg { max-width: 100%; height: 56px; }
    .barcode-text { font-size: 11px; letter-spacing: 2px; margin-top: 2px; }`;
  const customerBlock = receiptCustomerHtml(
    details.customerName,
    sale.customerPhone,
    details.customerMobile,
    details.customerAddress,
  );
  const body = `
    ${receiptHeaderHtml(location, details.storeAddress)}
    <div class="divider"></div>
    <div class="meta">${escapeHtml(soldAt.toLocaleString())} &middot; Cashier: ${escapeHtml(sale.servedBy || "-")}</div>
    ${customerBlock}
    <div class="divider"></div>
    <table>${rows}</table>
    <div class="divider"></div>
    ${taxBlock}
    <div class="total"><span>Total</span><span>${formatMoney(total)}</span></div>
    <div class="paid">Paid by ${escapeHtml(sale.paymentMethod || "-")}</div>
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
    ? `<div class="barcode">${code128Svg(receiptCode, { moduleWidth: 2, height: 56 })}<div class="barcode-text">${escapeHtml(receiptCode)}</div></div>`
    : "";

  const taxAmount = Number(order.taxAmount) || 0;
  const taxBlock = taxAmount > 0 || Number(order.subtotal) > 0
    ? `
    <div class="line"><span>Subtotal</span><span>${formatMoney(Number(order.subtotal) || 0)}</span></div>
    <div class="line"><span>Tax${order.taxRate ? ` (${order.taxRate}%)` : ""}</span><span>${formatMoney(taxAmount)}</span></div>`
    : "";

  const css = `
    .line { display: flex; justify-content: space-between; font-size: 12px; }
    .total { font-size: 15px; font-weight: 800; display: flex; justify-content: space-between; margin-top: 4px; }
    .paid { font-size: 11.5px; text-align: center; margin-top: 6px; }
    .deliver { font-size: 12px; margin-top: 6px; }
    .deliver strong { display: block; }
    .barcode { text-align: center; margin-top: 12px; }
    .barcode svg { max-width: 100%; height: 56px; }
    .barcode-text { font-size: 11px; letter-spacing: 2px; margin-top: 2px; }`;
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
    <div class="meta">Handler: ${escapeHtml(order.assignedTo || "-")}</div>
    <div class="divider"></div>
    <table>${rows}</table>
    <div class="divider"></div>
    ${taxBlock}
    <div class="total"><span>Total</span><span>${formatMoney(total)}</span></div>
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
    .eyebrow { text-align: center; font-size: 11px; text-transform: uppercase; letter-spacing: 1px; }
    .ticket { text-align: center; font-size: 26px; font-weight: 800; margin: 4px 0; letter-spacing: 1px; }
    .who { text-align: center; font-size: 12.5px; font-weight: 700; }
    .row { font-size: 12.5px; margin: 2px 0; }
    .row strong { display: inline-block; min-width: 52px; }
    .issue { font-size: 14px; font-weight: 800; margin-top: 4px; }`;
  const body = `
    <div class="eyebrow">Repair — stick on phone</div>
    <div class="ticket">${escapeHtml(details.ticketNumber || "")}</div>
    ${customer ? `<div class="who">${escapeHtml(customer)}</div>` : ""}
    <div class="divider"></div>
    ${details.model ? `<div class="row"><strong>Model</strong> ${escapeHtml(details.model)}</div>` : ""}
    ${details.imei ? `<div class="row"><strong>IMEI</strong> ${escapeHtml(details.imei)}</div>` : ""}
    ${details.damage ? `<div class="issue">Issue: ${escapeHtml(details.damage)}</div>` : ""}`;

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
    ["Estimated price", estimatedPrice ? formatMoney(Number(estimatedPrice) || 0) : ""],
    ["Final price", details.finalPrice ? formatMoney(Number(details.finalPrice) || 0) : ""],
    ["Paid", details.paymentStatus],
    ["Expected ready", details.dueDate],
    ["Notify by", details.notificationPreference],
    ["Served by", report.servedBy],
  ];
  const rows = rowsSource
    .filter(([, value]) => value)
    .map(([label, value]) => `<tr><td>${escapeHtml(label)}</td><td style="text-align:right">${escapeHtml(String(value))}</td></tr>`)
    .join("");

  const css = `
    .eyebrow { text-align: center; font-size: 11px; text-transform: uppercase; letter-spacing: 1px; }
    .ticket { text-align: center; font-size: 24px; font-weight: 800; margin: 6px 0; letter-spacing: 1px; }
    .notes { font-size: 11.5px; margin-top: 10px; }`;
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

function SaleReceiptDialog({ sale, onClose }) {
  const details = sale.details || {};
  const lines = details.lineItems || [];
  const total = Number(sale.paymentAmount) || 0;
  const soldAt = toJsDate(sale.createdAt) || new Date();

  function printReceipt() {
    printSaleReceipt(sale);
  }

  return (
    <div className="dialog-backdrop" role="presentation">
      <div className="dialog-card receipt-card" role="dialog" aria-modal="true">
        <img className="receipt-logo" src="/logo.webp" alt="Diamant Telecom" />
        <div className="receipt-success">
          <span className="receipt-check" aria-hidden="true">&#10003;</span>
          <div>
            <h3>Sale complete</h3>
            <p className="muted">{formatMoney(total)} paid by {sale.paymentMethod}</p>
          </div>
        </div>

        <div className="receipt-meta">
          <span><strong>Store:</strong> {details.location || "-"}</span>
          <span><strong>Cashier:</strong> {sale.servedBy || "-"}</span>
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

        <div className="pos-form-actions">
          <button className="primary-button" type="button" onClick={onClose} autoFocus>
            New sale
          </button>
          <button className="secondary-button" type="button" onClick={printReceipt}>
            Print receipt
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
    const value = entry.replace(/\D/g, "").slice(0, 15);
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
          <span>{scanMode ? "Scan an IMEI — it adds automatically" : "Type a 15-digit IMEI, then press Enter"}</span>
          <input
            ref={inputRef}
            value={entry}
            onChange={(event) => setEntry(event.target.value)}
            onKeyDown={handleEntryKeyDown}
            placeholder={scanMode ? "Scan IMEI" : "Type 15-digit IMEI, then Enter"}
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
        <div>
          <p className="eyebrow">Add stock</p>
          <h3>{product.name}</h3>
          <p className="muted">In stock now: {currentStock}{requiresImei ? " IMEIs" : ""}</p>
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
            <select value={location} onChange={(event) => setLocation(event.target.value)}>
              <option value="">All stores</option>
              {stores.map((store) => (
                <option key={store}>{store}</option>
              ))}
            </select>
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

function InventoryPage({
  products,
  storeLocations,
  sessionRole,
  onSaveProduct,
  onRemoveProduct,
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
    location: storeLocations[0] || "",
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
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  // Group per-store product rows up by item so we can show, in one popup, how
  // many of each item are in stock at every store along with its variants.
  const groups = useMemo(() => {
    const map = new Map();
    for (const product of products) {
      const key = String(product.sku || product.name || product.id).trim().toLowerCase();
      const stock = product.requiresImei ? product.imeis?.length || 0 : Number(product.quantity) || 0;
      const loc = product.location || "";
      const group = map.get(key) || {
        key,
        name: product.name,
        sku: product.sku,
        category: product.category,
        requiresImei: Boolean(product.requiresImei),
        total: 0,
        byStore: {},
        variants: [],
      };
      group.byStore[loc] = (group.byStore[loc] || 0) + stock;
      group.total += stock;
      group.variants.push(product);
      if (!group.name && product.name) group.name = product.name;
      if (!group.sku && product.sku) group.sku = product.sku;
      if (!group.category && product.category) group.category = product.category;
      if (product.requiresImei) group.requiresImei = true;
      map.set(key, group);
    }
    return Array.from(map.values()).sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")));
  }, [products]);

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
  const selectedHasAllStores = selectedGroup ? Boolean(selectedGroup.byStore[""]) : false;

  return (
    <>
      <section className="workspace">
        <div className="workspace-header">
          <div>
            <p className="eyebrow">Inventory</p>
            <h2>{form.id ? "Edit product" : "Add product"}</h2>
          </div>
        </div>
        <form className="form-grid inventory-form" onSubmit={submit}>
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
            <select value={form.location} onChange={(event) => updateField("location", event.target.value)}>
              <option value="">All stores</option>
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
      </section>

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

      {selectedGroup ? (
        <ItemDetailsDialog
          group={selectedGroup}
          storeLocations={storeLocations}
          hasAllStores={selectedHasAllStores}
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

// Popup showing one item's stock per store plus each per-store variant, with
// restock / edit / delete actions. Replaces the always-on inventory tables.
function ItemDetailsDialog({ group, storeLocations, hasAllStores, sessionRole, onClose, onRestock, onEdit, onDelete }) {
  const isAdmin = sessionRole === "admin";
  const subtitle = [group.sku ? `SKU ${group.sku}` : "", group.category || "", group.requiresImei ? "IMEI tracked" : ""]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="dialog-backdrop" role="presentation" onClick={onClose}>
      <div
        className="dialog-card dialog-card-wide"
        role="dialog"
        aria-modal="true"
        aria-labelledby="item-dialog-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div>
          <p className="eyebrow">Inventory</p>
          <h2 id="item-dialog-title">{group.name}</h2>
          {subtitle ? <p className="muted">{subtitle}</p> : null}
        </div>

        <div className="table-wrap catalog-table">
          <table>
            <thead>
              <tr>
                {storeLocations.map((location) => (
                  <th key={location}>{location}</th>
                ))}
                {hasAllStores ? <th>All stores</th> : null}
                <th>Total</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                {storeLocations.map((location) => (
                  <td key={location}>{group.byStore[location] || 0}</td>
                ))}
                {hasAllStores ? <td>{group.byStore[""] || 0}</td> : null}
                <td><strong>{group.total}</strong></td>
              </tr>
            </tbody>
          </table>
        </div>

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

  const sortedReports = [...reports].sort(
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
                <label className="field">
                  <span>Sola device ID</span>
                  <input
                    key={`device-${location}-${deviceFor(location)}`}
                    defaultValue={deviceFor(location)}
                    placeholder="CloudIM device ID"
                    autoComplete="off"
                    spellCheck={false}
                    onBlur={(event) => onSetStoreDevice(location, event.target.value)}
                  />
                </label>
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
              </tr>
            </thead>
            <tbody>
              {sortedReports.length ? (
                sortedReports.map((report) => (
                  <tr key={report.id}>
                    <td>{formatShortDate(report.createdAt)}</td>
                    <td>{report.servedBy || "-"}</td>
                    <td><span className={`badge ${report.type}`}>{reportTypes[report.type].label}</span></td>
                    <td>{report.customerPhone || "-"}</td>
                    <td><ReportDetails report={report} /></td>
                    <td>{formatPayment(report.paymentAmount)}</td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan="6" className="empty-state">No employee activity yet.</td>
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

function ReportRow({ report, onStatusChange, onDeleteReport, onReturn, hasActions }) {
  const [open, setOpen] = useState(false);
  const saleLineItems = report.details?.lineItems || [];
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
          </td>
        ) : null}
      </tr>
      {open ? (
        <tr className="report-detail-row">
          <td colSpan={columnCount}><ReportDetails report={report} /></td>
        </tr>
      ) : null}
    </>
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
      ["Total", details.totalPrice ? formatMoney(Number(details.totalPrice)) : ""],
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
      ["Refunded", details.refundTotal ? formatMoney(Number(details.refundTotal)) : ""],
    ],
  }[report.type];

  const recordingUrl = report.type === "call"
    ? callRecordingUrl(details.telebroadCallId, details.telebroadUniqueId)
    : "";

  const filled = lines.filter(([, value]) => value);
  // Collapsed rows show just the first couple of fields as a one-line teaser.
  const shown = compact ? filled.slice(0, 2) : filled;

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

  const refundTotal = lines.reduce((sum, line) => sum + line.price * line.returnQty, 0);
  const anySelected = lines.some((line) => line.returnQty > 0);
  const imeiNeedsScan = lines.some(
    (line) => line.requiresImei && line.returnQty > 0 && line.scanImei !== line.soldImei,
  );
  const requiresSolaRefund = ["CC", "Card"].includes(refundMethod) && Boolean(originalRefNum);
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

    await Promise.resolve(onSubmit(report, { returnLines, refundMethod, solaRefundRef: solaRef, notes }));
    onClose();
  }

  return (
    <div className="dialog-backdrop" role="presentation">
      <div className="dialog-card dialog-card-wide" role="dialog" aria-modal="true">
        <div>
          <p className="eyebrow">Return / refund</p>
          <h3>Return items from this sale</h3>
          <p className="muted">
            {formatShortDate(report.createdAt)} · {report.customerPhone || "no phone"} · paid {formatPayment(report.paymentAmount)} ({report.paymentMethod || "-"})
          </p>
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
                        onChange={(event) => setLine(line.index, { scanImei: event.target.value.replace(/\D/g, "").slice(0, 15) })}
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
function CustomerPhoneInput({ value, onChange, customers, onSelectCustomer, onSaveCustomerName, onSaveCustomer, placeholder, required, name, autoFocus }) {
  const [open, setOpen] = useState(false);
  const [detailsPrompt, setDetailsPrompt] = useState(null);
  // The leading US "1" is pre-filled and ignored. localDigits is the 10-digit
  // local number (area code included); searching starts after 5 of those digits.
  const localDigits = localPhoneDigits(value);
  const matches = localDigits.length >= 5
    ? (customers || [])
        .filter((customer) => (customer.phoneDigits || "").includes(localDigits) || (customer.mobileDigits || "").includes(localDigits))
        .slice(0, 8)
    : [];
  // A full-number match drives the read-only details summary shown beneath the
  // field, so the phone number stays the only thing the user has to enter.
  const exactMatch = localDigits.length >= 7
    ? (customers || []).find((customer) => customer.phoneDigits === localDigits || customer.mobileDigits === localDigits) || null
    : null;
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

  function saveDetails(values) {
    const customer = detailsPrompt;
    onSaveCustomer?.({
      id: customer.id || "",
      phone: customer.phone || value,
      name: values.name.trim(),
      mobile: values.mobile.trim(),
      address: values.address.trim(),
    });
    setDetailsPrompt(null);
    onSelectCustomer?.({
      ...customer,
      name: values.name.trim() || customer.name,
      mobile: values.mobile.trim() || customer.mobile,
      address: values.address.trim() || customer.address,
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

function CustomersPage({ customers, sessionRole, onSave, onRemove, onSync }) {
  const emptyCustomer = { id: "", name: "", phone: "", mobile: "", address: "", email: "", contactDetails: "", notes: "" };
  const [form, setForm] = useState(emptyCustomer);
  const [search, setSearch] = useState("");
  const isAdmin = sessionRole === "admin";

  function update(field, value) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  function submit(event) {
    event.preventDefault();
    if (!form.phone.trim() && !form.name.trim()) return;
    onSave(form);
    setForm(emptyCustomer);
  }

  function editCustomer(customer) {
    setForm({ ...emptyCustomer, ...customer });
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    const queryDigits = digitsOnly(query);
    return [...customers]
      .filter((customer) => {
        if (!query) return true;
        const text = [customer.name, customer.phone, customer.address, customer.email, customer.contactDetails]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        return text.includes(query) || (queryDigits && (customer.phoneDigits || "").includes(queryDigits));
      })
      .sort((a, b) => String(a.name || a.phone || "").localeCompare(String(b.name || b.phone || "")));
  }, [customers, search]);

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
            <h2>{customers.length} total</h2>
          </div>
          <div className="history-actions">
            <input className="pos-search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search name, phone, address" />
            {isAdmin ? <button className="secondary-button" type="button" onClick={onSync}>Sync from reports</button> : null}
          </div>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>Name</th><th>Phone</th><th>Address</th><th>Email</th><th>Notes</th><th></th></tr>
            </thead>
            <tbody>
              {filtered.length ? (
                filtered.map((customer) => (
                  <tr key={customer.id}>
                    <td><strong>{customer.name || "-"}</strong></td>
                    <td>{customer.phone || "-"}</td>
                    <td>{customer.address || "-"}</td>
                    <td>{customer.email || "-"}</td>
                    <td className="muted">{customer.notes || ""}</td>
                    <td className="pos-row-actions">
                      <button className="secondary-button compact-button" type="button" onClick={() => editCustomer(customer)}>Edit</button>
                      {isAdmin ? <button className="secondary-button compact-button" type="button" onClick={() => onRemove(customer.id)}>Delete</button> : null}
                    </td>
                  </tr>
                ))
              ) : (
                <tr><td colSpan="6" className="empty-state">No customers yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
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
