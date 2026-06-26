import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ACTIVE_EMPLOYEE_KEY,
  COMPANY,
  CUSTOMERS_KEY,
  defaultEmployees,
  resolveStoreDetails,
  defaultManualReportType,
  defaultOrderHandlers,
  defaultStoreLocations,
  EMPLOYEE_KEY,
  EMPLOYEE_LOCATIONS_KEY,
  FUNCTIONS_BASE_URL,
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
  STORAGE_KEY,
  STORE_DEVICES_KEY,
  STORE_LOCATIONS_KEY,
  STORE_TAX_KEY,
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
} from "./firebaseClient";
import { chargeOnDevice, refundToCard } from "./solaTerminal";
import {
  buildAppNotifications,
  calculateInclusiveDays,
  calculateRentalPrice,
  calculateReturnDueDate,
  code128Svg,
  createEmptyFilters,
  digitsOnly,
  escapeHtml,
  generateReceiptCode,
  exportCsv,
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
  toJsDate,
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
  const [employees, setEmployees] = useCloudDocumentState("employees", EMPLOYEE_KEY, defaultEmployees);
  const [reports, setReports] = useCloudCollectionState("reports", STORAGE_KEY, []);
  const [pendingReports, setPendingReports] = useCloudCollectionState("pendingReports", PENDING_REPORTS_KEY, []);
  const [phoneOrders, setPhoneOrders] = useCloudCollectionState("phoneOrders", PHONE_ORDERS_KEY, []);
  const [orderHandlers, setOrderHandlers] = useCloudCollectionState("orderHandlers", ORDER_HANDLERS_KEY, defaultOrderHandlers);
  const [notifications, setNotifications] = useCloudCollectionState("notificationLogs", "diamant-telecom-notifications-v1", []);
  const [resetRequests, setResetRequests] = useCloudCollectionState("passwordResetRequests", RESET_REQUESTS_KEY, []);
  const [products, setProducts] = useCloudCollectionState("products", PRODUCTS_KEY, []);
  const [storeLocations, setStoreLocations] = useCloudDocumentState("storeLocations", STORE_LOCATIONS_KEY, defaultStoreLocations);
  const [employeeLocations, setEmployeeLocations] = useCloudDocumentState("employeeLocations", EMPLOYEE_LOCATIONS_KEY, []);
  const [storeDevices, setStoreDevices] = useCloudDocumentState("storeDevices", STORE_DEVICES_KEY, []);
  const [storeTax, setStoreTax] = useCloudDocumentState("storeTax", STORE_TAX_KEY, []);
  const [customers, setCustomers] = useCloudCollectionState("customers", CUSTOMERS_KEY, []);
  // Employees are locked to their own identity; admins can file/view as any
  // employee in the list.
  const [activeEmployee, setActiveEmployee] = useState(
    isAdmin ? localStorage.getItem(ACTIVE_EMPLOYEE_KEY) || employeeName || employees[0] || "" : employeeName,
  );
  const [activeView, setActiveView] = useState(isAdmin ? "admin" : "pendingReports");
  const [filters, setFilters] = useState(createEmptyFilters);
  const [formNonce, setFormNonce] = useState(0);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [returnTarget, setReturnTarget] = useState(null);

  // Keep the signed-in employee's name in the shared list so admins can see and
  // attribute to them.
  useEffect(() => {
    if (employeeName && !employees.includes(employeeName)) {
      setEmployees((current) => (current.includes(employeeName) ? current : [...current, employeeName]));
    }
  }, [employeeName, employees, setEmployees]);

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

  const employeeCanSeeReport = useMemo(() => {
    return (report) => {
      const store = report.location || report.details?.location || "";
      return !store || store === activeLocation || report.servedBy === activeEmployee;
    };
  }, [activeLocation, activeEmployee]);

  const filteredReports = useMemo(() => {
    const query = filters.query.trim().toLowerCase();
    const phoneQuery = digitsOnly(query);
    const itemQuery = filters.item.trim().toLowerCase();
    const nameQuery = filters.customerName.trim().toLowerCase();
    const amountMin = Number.parseFloat(filters.amountMin);
    const amountMax = Number.parseFloat(filters.amountMax);
    const dateFrom = filters.dateFrom ? new Date(`${filters.dateFrom}T00:00:00`) : null;
    const dateTo = filters.dateTo ? new Date(`${filters.dateTo}T23:59:59`) : null;
    const availableReports = sessionRole === "admin"
      ? reports
      : reports.filter(employeeCanSeeReport);

    return availableReports.filter((report) => {
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
        (sessionRole !== "admin" || filters.employee === "all" || report.servedBy === filters.employee) &&
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
  }, [employeeCanSeeReport, filters, reports, sessionRole]);

  const visibleReports = useMemo(
    () => (sessionRole === "admin" ? reports : reports.filter(employeeCanSeeReport)),
    [employeeCanSeeReport, reports, sessionRole],
  );

  const visibleEmployees = sessionRole === "admin" ? employees : [activeEmployee];
  const visibleNotifications = useMemo(() => {
    if (sessionRole === "admin") return notifications;
    const visibleReportIds = new Set(
      reports.filter(employeeCanSeeReport).map((report) => report.id),
    );
    return notifications.filter((notice) => visibleReportIds.has(notice.reportId));
  }, [employeeCanSeeReport, notifications, reports, sessionRole]);
  const appNotifications = useMemo(() => {
    const availableReports = sessionRole === "admin"
      ? reports
      : reports.filter(employeeCanSeeReport);
    return buildAppNotifications(availableReports);
  }, [employeeCanSeeReport, reports, sessionRole]);

  function addStoreLocation(store) {
    const name = String((typeof store === "string" ? store : store?.name) || "").trim();
    if (!name || storeLocations.includes(name)) return;
    const address = typeof store === "string" ? {} : store || {};
    setStoreLocations((current) => [...current, name]);
    setStoreTax((current) => [
      ...current.filter((entry) => entry?.name !== name),
      {
        name,
        street: String(address.street || "").trim(),
        city: String(address.city || "").trim(),
        state: String(address.state || "").trim(),
        zip: String(address.zip || "").trim(),
        rate: 0,
      },
    ]);
  }

  function removeStoreLocation(name) {
    if (storeLocations.length <= 1) {
      window.alert("Keep at least one store location.");
      return;
    }
    setStoreLocations((current) => current.filter((location) => location !== name));
    setStoreTax((current) => current.filter((entry) => entry?.name !== name));
  }

  function setStoreTaxRate(name, rate) {
    const value = Number.parseFloat(rate);
    setStoreTax((current) =>
      current.map((entry) => (entry?.name === name ? { ...entry, rate: Number.isFinite(value) ? value : 0 } : entry)),
    );
  }

  // Auto-add/merge a customer into the CRM from any sale/call/order. Only fills
  // blank fields on an existing customer — never overwrites entered details.
  function upsertCustomer(info) {
    const phone = String(info?.phone || "").trim();
    const digits = digitsOnly(phone);
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
    const digits = digitsOnly(phone);
    const now = new Date().toISOString();
    const normalized = {
      phone,
      phoneDigits: digits,
      name: String(customer.name || "").trim(),
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
    setCustomers((current) => current.filter((entry) => entry.id !== customerId));
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
        name: String(details.customerName || details.callerName || "").trim(),
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
    setEmployeeLocations((current) => {
      const others = (current || []).filter((entry) => entry?.name !== name);
      if (!location) return others;
      return [...others, { name, location }];
    });
  }

  function setStoreDevice(name, deviceId) {
    const cleanDeviceId = String(deviceId || "").trim();
    setStoreDevices((current) => {
      const others = (current || []).filter((entry) => entry?.name !== name);
      if (!cleanDeviceId) return others;
      return [...others, { name, deviceId: cleanDeviceId }];
    });
  }

  function saveProduct(product) {
    const id = product.id || crypto.randomUUID();
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
      name: String(product.name || "").trim(),
      price: String(product.price ?? "").trim(),
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
      address: order.address,
      contactDetails: order.contactDetails,
    });
    setPhoneOrders((current) => [enrichedOrder, ...current]);
    queuePhoneOrderAssignedNotifications(enrichedOrder);
    setFormNonce((value) => value + 1);
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

    setOrderHandlers((current) => [
      ...current,
      {
        id: crypto.randomUUID(),
        name,
        phone: handler.phone.trim(),
        location,
      },
    ]);
  }

  function removeOrderHandler(handlerId) {
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

  // Keep the shared employee-name list in step with the real user accounts so
  // attribution and admin filters keep working.
  function syncEmployeeName(name) {
    const cleanName = String(name || "").trim();
    if (!cleanName) return;
    setEmployees((current) => (current.includes(cleanName) ? current : [...current, cleanName]));
  }

  function unsyncEmployeeName(name) {
    const cleanName = String(name || "").trim();
    if (!cleanName) return;
    setEmployees((current) => current.filter((employee) => employee !== cleanName));
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
        onManageEmployees={() => setDialogOpen(true)}
        onTypeChange={setActiveType}
        onViewChange={setActiveView}
        onLogout={logout}
      />

      <main className="main">
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
            onClaim={claimPendingReport}
            onSave={savePendingReport}
          />
        ) : activeView === "openRepairs" ? (
          <OpenRepairsPage
            reports={filteredReports}
            onStatusChange={updateRepairStatus}
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
              onSave={saveReport}
            />
          ) : activeType === "phoneOrder" ? (
            <PhoneOrderPage
              key={`${activeType}-${formNonce}`}
              activeEmployee={activeEmployee}
              sessionRole={sessionRole}
              phoneOrders={phoneOrders}
              orderHandlers={orderHandlers}
              storeTax={storeTax}
              customers={customers}
              onCreate={createPhoneOrder}
              onDelivered={completePhoneOrder}
            />
          ) : (
            <ReportForm
              key={`${activeType}-${formNonce}`}
              activeType={activeType}
              activeEmployee={activeEmployee}
              reports={reports}
              customers={customers}
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
            onClearReports={clearReports}
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
            customers={customers}
            onCompleteSale={savePosSale}
          />
        ) : activeView === "inventory" ? (
          <InventoryPage
            products={products}
            employees={employees}
            storeLocations={storeLocations}
            employeeLocations={employeeLocations}
            storeDevices={storeDevices}
            storeTax={storeTax}
            sessionRole={sessionRole}
            onSaveProduct={saveProduct}
            onRemoveProduct={removeProduct}
            onAddStoreLocation={addStoreLocation}
            onRemoveStoreLocation={removeStoreLocation}
            onSetEmployeeLocation={setEmployeeLocation}
            onSetStoreDevice={setStoreDevice}
            onSetStoreTaxRate={setStoreTaxRate}
          />
        ) : (
          <AdminPage
            employees={employees}
            reports={reports}
            notifications={notifications}
            resetRequests={resetRequests}
            orderHandlers={orderHandlers}
            onMarkResetHandled={markResetHandled}
            onResetPassword={requestPasswordReset}
            onAddOrderHandler={addOrderHandler}
            onRemoveOrderHandler={removeOrderHandler}
          />
        )}
      </main>

      {dialogOpen && sessionRole === "admin" && (
        <EmployeeDialog
          onClose={() => setDialogOpen(false)}
          onSyncName={syncEmployeeName}
          onUnsyncName={unsyncEmployeeName}
          storeLocations={storeLocations}
          employeeLocations={employeeLocations}
          onSetLocation={setEmployeeLocation}
        />
      )}

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

  return (
    <main className="login-page">
      <section className="login-shell">
        <div className="login-aside">
          <div className="brand">
            <img className="brand-mark brand-logo" src="/logo.webp" alt="Diamant Telecom" />
            <div>
              <h1>Diamant Telecom</h1>
              <p>Store reports</p>
            </div>
          </div>
          <div className="login-aside-copy">
            <p className="eyebrow">Daily workspace</p>
            <h2>Capture every call, sale, repair, and activation in one clean place.</h2>
          </div>
          <div className="login-mini-grid">
            <span>Calls</span>
            <span>Sales</span>
            <span>Repairs</span>
            <span>SIM</span>
          </div>
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
            <div>
              <p className="eyebrow">Sign in</p>
              <h2>Sign in to your account</h2>
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
              <span>Password</span>
              <input
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="Your password"
                autoComplete="current-password"
                required
              />
            </label>

            <button className="primary-button" type="submit" disabled={status === "signing-in"}>
              {status === "signing-in" ? "Signing in…" : "Sign in"}
            </button>
            <button className="secondary-button" type="button" onClick={handleForgotPassword}>
              Forgot password
            </button>
            {message ? <p className="summary-error">{message}</p> : null}
            {authError ? <p className="summary-error">Could not reach the sign-in service. Check your connection.</p> : null}
          </form>
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

function Sidebar({
  activeType,
  activeView,
  sessionRole,
  employees,
  activeEmployee,
  onEmployeeChange,
  onManageEmployees,
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

        {sessionRole === "admin" ? (
          <>
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
        {sessionRole === "admin" ? (
          <button className="ghost-button" type="button" onClick={onManageEmployees}>
            Manage employees
          </button>
        ) : null}
        <button className="ghost-button" type="button" onClick={onLogout}>
          Sign out
        </button>
      </div>
    </aside>
  );
}

function ReportForm({ activeType, activeEmployee, reports, customers, onSave }) {
  const [now, setNow] = useState(new Date());
  const [customerPhone, setCustomerPhone] = useState("");
  const config = reportTypes[activeType];

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 30000);
    return () => window.clearInterval(timer);
  }, []);

  function handleSubmit(event) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const details = {};

    config.fields.forEach((field) => {
      details[field.name] = String(formData.get(field.name) || "").trim();
    });

    if (activeType === "repair") {
      details.ticketNumber = generateRepairTicketNumber(reports);
      details.ticketDigits = digitsOnly(details.ticketNumber);
    }

    const savedReport = {
      id: crypto.randomUUID(),
      type: activeType,
      createdAt: new Date().toISOString(),
      servedBy: activeEmployee,
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
              onSelectCustomer={(customer) => setCustomerPhone(customer.phone)}
              placeholder="(555) 123-4567"
              required
            />
          </label>

          <label className="field">
            <span>Payment amount</span>
            <input name="paymentAmount" inputMode="decimal" placeholder="0.00" />
          </label>

          <label className="field">
            <span>Payment method</span>
            <select name="paymentMethod" defaultValue="Cash">
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
          {config.fields.map((field) => (
            <DynamicField key={field.name} field={field} />
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

function DynamicField({ field }) {
  if (field.type === "select") {
    return (
      <label className="field">
        <span>{field.label}</span>
        <select name={field.name} defaultValue={field.options[0]}>
          {field.options.map((option) => (
            <option key={option}>{option}</option>
          ))}
        </select>
      </label>
    );
  }

  return (
    <label className="field">
      <span>{field.label}</span>
      <input
        name={field.name}
        type={field.type || "text"}
        placeholder={field.placeholder || ""}
        {...(field.name === "imei" ? {
          inputMode: "numeric",
          autoComplete: "off",
          spellCheck: false,
        } : {})}
      />
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

function RentalReportForm({ activeEmployee, customers, onSave }) {
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
    paymentMethod: "Cash",
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
              <span>SIM number</span>
              <input inputMode="numeric" value={form.simNumber} onChange={(event) => updateField("simNumber", event.target.value)} />
            </label>
            {isRcukRental ? (
              <label className="field">
                <span>SIM sent to RCUK</span>
                <input value={normalizedSimNumber} readOnly disabled />
              </label>
            ) : null}
          </div>

          <div className="form-grid">
            <label className="field">
              <span>Customer phone</span>
              <CustomerPhoneInput
                value={form.customerPhone}
                onChange={(value) => updateField("customerPhone", value)}
                customers={customers}
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
                {paymentMethods.map((method) => <option key={method}>{method}</option>)}
              </select>
            </label>
            <label className="field">
              <span>Return reminder</span>
              <select value={form.returnReminderPreference} onChange={(event) => updateField("returnReminderPreference", event.target.value)}>
                <option>Text message</option>
                <option>Phone call</option>
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
                <button className="secondary-button" type="button" onClick={checkSimWithRcuk} disabled={!normalizedSimNumber || simCheckState.status === "checking"}>
                  Check SIM
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
          <button className="secondary-button" type="button" onClick={onExport} disabled={!rangeValid}>Export view (CSV)</button>
          {onExportAll ? (
            <button className="secondary-button" type="button" onClick={onExportAll}>Export all (CSV)</button>
          ) : null}
          <button className="danger-button" type="button" onClick={onClearReports}>Clear local data</button>
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

function OpenRepairsPage({ reports, onStatusChange }) {
  const openRepairs = reports.filter((report) =>
    report.type === "repair" && !["Completed", "Cancelled"].includes(report.details?.status),
  );

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
              <th>Customer</th>
              <th>Phone</th>
              <th>Damage</th>
              <th>Payment</th>
              <th>Served by</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {openRepairs.length ? (
              openRepairs.map((repair) => (
                <tr key={repair.id}>
                  <td><strong>{repair.details?.ticketNumber || "-"}</strong></td>
                  <td>{formatShortDate(repair.createdAt)}</td>
                  <td>{repair.customerPhone || "-"}</td>
                  <td>{repair.details?.model || "-"}</td>
                  <td>{repair.details?.damage || "-"}</td>
                  <td>{formatPayment(repair.paymentAmount)} · {repair.details?.paymentStatus || "Not paid"}</td>
                  <td>{repair.servedBy || "-"}</td>
                  <td>
                    <select
                      className="status-select"
                      value={repair.details?.status || repairStatuses[0]}
                      onChange={(event) => onStatusChange(repair.id, event.target.value)}
                    >
                      {repairStatuses.map((status) => (
                        <option key={status}>{status}</option>
                      ))}
                    </select>
                  </td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan="8" className="empty-state">No open repairs.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function PendingReportsPage({ pendingReports, activeEmployee, customers, onClaim, onSave }) {
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

function PendingReportCard({ pendingReport, activeEmployee, customers, onClaim, onSave }) {
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
  const [fields, setFields] = useState(() => ({
    customerPhone: pendingReport.customerPhone || imported.customerPhone || imported.callerIdExternal || "",
    callerName: pendingReport.details?.callerName || imported.callerNameExternal || "",
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
        : "Cash",
  }));

  function updateField(name, value) {
    setFields((current) => ({ ...current, [name]: value }));
  }

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
              <label className="field">
                <span>What does the caller want?</span>
                <input value={fields.reason} onChange={(event) => updateField("reason", event.target.value)} required />
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

function PhoneOrderPage({ activeEmployee, sessionRole, phoneOrders, orderHandlers, storeTax, customers, onCreate, onDelivered }) {
  const [now, setNow] = useState(new Date());
  const [outOfState, setOutOfState] = useState(false);

  function fillFromCustomer(customer) {
    setForm((current) => ({
      ...current,
      customerPhone: customer.phone || current.customerPhone,
      customerName: customer.name || current.customerName,
      address: customer.address || current.address,
      contactDetails: customer.contactDetails || current.contactDetails,
    }));
  }
  const [form, setForm] = useState({
    location: orderHandlers[0]?.location || "",
    assignedTo: orderHandlers[0]?.name || "",
    customerName: "",
    customerPhone: "",
    contactDetails: "",
    address: "",
    paymentStatus: "Paid",
    paymentMethod: "Cash",
    notes: "",
  });
  const [items, setItems] = useState([{ id: crypto.randomUUID(), name: "", qty: "1", price: "" }]);

  function updateItem(id, patch) {
    setItems((current) => current.map((item) => (item.id === id ? { ...item, ...patch } : item)));
  }
  function addItem() {
    setItems((current) => [...current, { id: crypto.randomUUID(), name: "", qty: "1", price: "" }]);
  }
  function removeItem(id) {
    setItems((current) => (current.length > 1 ? current.filter((item) => item.id !== id) : current));
  }

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 30000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!orderHandlers.length) return;
    setForm((current) => {
      if (current.location && current.assignedTo) return current;
      const firstHandler = orderHandlers[0];
      return {
        ...current,
        location: current.location || firstHandler.location || "",
        assignedTo: current.assignedTo || firstHandler.name || "",
      };
    });
  }, [orderHandlers]);

  const locations = uniqueValues(orderHandlers.map((handler) => handler.location));
  const locationHandlers = orderHandlers.filter((handler) => handler.location === form.location);
  const selectedHandler = orderHandlers.find((handler) => handler.name === form.assignedTo && handler.location === form.location)
    || locationHandlers[0]
    || null;
  const visibleOrders = sessionRole === "admin"
    ? phoneOrders
    : phoneOrders.filter((order) => order.assignedTo === activeEmployee);
  const validItems = items.filter((item) => item.name.trim());
  const subtotal = validItems.reduce(
    (sum, item) => sum + (Number(item.price) || 0) * (Number(item.qty) || 1),
    0,
  );
  const taxRate = Number((storeTax || []).find((entry) => entry?.name === form.location)?.rate) || 0;
  const taxApplies = !outOfState && taxRate > 0;
  const taxAmount = taxApplies ? subtotal * (taxRate / 100) : 0;
  const orderTotal = subtotal + taxAmount;
  const itemsText = validItems
    .map((item) => `${Number(item.qty) || 1}x ${item.name.trim()}`)
    .join(", ");
  const canCreate = form.location.trim()
    && form.assignedTo.trim()
    && form.customerPhone.trim()
    && form.address.trim()
    && validItems.length > 0
    && form.paymentStatus.trim();

  function updateField(name, value) {
    setForm((current) => {
      const next = { ...current, [name]: value };
      if (name === "location") {
        const firstHandler = orderHandlers.find((handler) => handler.location === value);
        next.assignedTo = firstHandler?.name || "";
      }
      return next;
    });
  }

  function submitOrder(event) {
    event.preventDefault();
    if (!canCreate || !selectedHandler) return;

    onCreate({
      id: crypto.randomUUID(),
      type: "phoneOrder",
      status: "Assigned",
      createdAt: new Date().toISOString(),
      createdBy: activeEmployee,
      location: form.location.trim(),
      assignedTo: selectedHandler.name,
      assignedPhone: selectedHandler.phone || "",
      customerName: form.customerName.trim(),
      customerPhone: form.customerPhone.trim(),
      customerPhoneDigits: digitsOnly(form.customerPhone),
      contactDetails: form.contactDetails.trim(),
      address: form.address.trim(),
      model: itemsText,
      itemsText,
      lineItems: validItems.map((item) => ({
        name: item.name.trim(),
        qty: Number(item.qty) || 1,
        price: Number(item.price) || 0,
      })),
      subtotal: subtotal.toFixed(2),
      taxRate,
      taxAmount: taxAmount.toFixed(2),
      outOfState: outOfState ? "Yes" : "No",
      orderTotal: orderTotal.toFixed(2),
      paymentStatus: form.paymentStatus,
      paymentMethod: form.paymentMethod,
      notes: form.notes.trim(),
    });
  }

  return (
    <section className="workspace">
      <div className="workspace-header">
        <div>
          <p className="eyebrow">Manual order</p>
          <h2>Phone order</h2>
        </div>
        <div className="clock-pill">{formatDateTime(now)}</div>
      </div>

      <form className="report-form" onSubmit={submitOrder}>
        <div className="form-grid">
          <label className="field">
            <span>Location</span>
            <select value={form.location} onChange={(event) => updateField("location", event.target.value)} required>
              <option value="">Select location</option>
              {locations.map((location) => <option key={location}>{location}</option>)}
            </select>
          </label>
          <label className="field">
            <span>Assign to</span>
            <select value={form.assignedTo} onChange={(event) => updateField("assignedTo", event.target.value)} required>
              <option value="">Select handler</option>
              {locationHandlers.map((handler) => <option key={handler.id}>{handler.name}</option>)}
            </select>
          </label>
          <label className="field">
            <span>Handler phone</span>
            <input value={selectedHandler?.phone || ""} readOnly disabled />
          </label>
          <label className="field">
            <span>Created by</span>
            <input value={activeEmployee} readOnly disabled />
          </label>
        </div>

        <div className="form-grid">
          <label className="field">
            <span>Customer name</span>
            <input value={form.customerName} onChange={(event) => updateField("customerName", event.target.value)} />
          </label>
          <label className="field">
            <span>Customer phone</span>
            <CustomerPhoneInput
              value={form.customerPhone}
              onChange={(value) => updateField("customerPhone", value)}
              customers={customers}
              onSelectCustomer={fillFromCustomer}
              required
            />
          </label>
          <label className="field">
            <span>Contact details</span>
            <input value={form.contactDetails} onChange={(event) => updateField("contactDetails", event.target.value)} placeholder="Email, WhatsApp, alternate phone" />
          </label>
          <label className="field">
            <span>Address</span>
            <input value={form.address} onChange={(event) => updateField("address", event.target.value)} required />
          </label>
        </div>

        <div className="order-items">
          <div className="order-items-head">
            <p className="form-section-title">Items</p>
            <button className="secondary-button compact-button" type="button" onClick={addItem}>Add item</button>
          </div>
          {items.map((item, index) => (
            <div className="order-item-row" key={item.id}>
              <label className="field">
                {index === 0 ? <span>Item / model</span> : null}
                <input
                  value={item.name}
                  onChange={(event) => updateItem(item.id, { name: event.target.value })}
                  placeholder="iPhone 15, case, charger..."
                />
              </label>
              <label className="field order-item-qty">
                {index === 0 ? <span>Qty</span> : null}
                <input
                  type="number"
                  min="1"
                  value={item.qty}
                  onChange={(event) => updateItem(item.id, { qty: event.target.value })}
                />
              </label>
              <label className="field order-item-price">
                {index === 0 ? <span>Unit price</span> : null}
                <input
                  inputMode="decimal"
                  value={item.price}
                  onChange={(event) => updateItem(item.id, { price: event.target.value })}
                  placeholder="0.00"
                />
              </label>
              <button
                className="secondary-button compact-button order-item-remove"
                type="button"
                onClick={() => removeItem(item.id)}
                disabled={items.length === 1}
                aria-label="Remove item"
              >
                ×
              </button>
            </div>
          ))}
          <div className="pos-totals-row"><span>Subtotal</span><span>{formatMoney(subtotal)}</span></div>
          <label className="checkbox-field pos-out-of-state">
            <input type="checkbox" checked={outOfState} onChange={(event) => setOutOfState(event.target.checked)} />
            <span>Out of state (no sales tax)</span>
          </label>
          <div className="pos-totals-row">
            <span>Tax{taxApplies ? ` (${taxRate}%)` : ""}</span>
            <span>{formatMoney(taxAmount)}</span>
          </div>
          <div className="order-items-total">
            <span>Order total</span>
            <strong>{formatMoney(orderTotal)}</strong>
          </div>
        </div>

        <div className="form-grid">
          <label className="field">
            <span>Payment status</span>
            <select value={form.paymentStatus} onChange={(event) => updateField("paymentStatus", event.target.value)}>
              <option>Paid</option>
              <option>Collect payment</option>
            </select>
          </label>
          <label className="field">
            <span>Payment method</span>
            <select value={form.paymentMethod} onChange={(event) => updateField("paymentMethod", event.target.value)}>
              {paymentMethods.map((method) => <option key={method}>{method}</option>)}
            </select>
          </label>
        </div>

        <label className="field full">
          <span>Notes</span>
          <textarea rows="4" value={form.notes} onChange={(event) => updateField("notes", event.target.value)} />
        </label>

        <div className="form-actions">
          <button className="primary-button" type="submit" disabled={!canCreate || !selectedHandler}>Create and notify</button>
        </div>
      </form>

      <OpenPhoneOrders
        orders={visibleOrders}
        activeEmployee={activeEmployee}
        sessionRole={sessionRole}
        onDelivered={onDelivered}
      />
    </section>
  );
}

function OpenPhoneOrders({ orders, activeEmployee, sessionRole, onDelivered }) {
  return (
    <div className="order-board">
      <div className="history-header">
        <div>
          <p className="eyebrow">Assigned orders</p>
          <h2>Open phone orders</h2>
        </div>
        <span className="metric">Open <strong>{orders.length}</strong></span>
      </div>
      <div className="pending-grid">
        {orders.length ? orders.map((order) => {
          const canDeliver = sessionRole === "admin" || order.assignedTo === activeEmployee;
          return (
            <article className="pending-card" key={order.id}>
              <div className="pending-card-head">
                <div>
                  <p className="eyebrow">{order.location}</p>
                  <h3>{order.model}</h3>
                </div>
                <span className="badge phoneOrder">{order.paymentStatus}</span>
              </div>
              <div className="pending-import">
                <span><strong>Customer:</strong> {order.customerName || order.customerPhone}</span>
                <span><strong>Phone:</strong> {order.customerPhone}</span>
                <span><strong>Total:</strong> {formatPayment(order.orderTotal)}</span>
                <span><strong>Assigned:</strong> {order.assignedTo}</span>
              </div>
              <div className="details">
                <span><strong>Address:</strong> {order.address}</span>
                {order.contactDetails ? <span><strong>Contact:</strong> {order.contactDetails}</span> : null}
                {order.notes ? <span className="muted">{order.notes}</span> : null}
              </div>
              <button className="primary-button" type="button" disabled={!canDeliver} onClick={() => onDelivered(order.id)}>
                Mark delivered
              </button>
            </article>
          );
        }) : (
          <p className="empty-state">No open phone orders.</p>
        )}
      </div>
    </div>
  );
}

function PosPage({ products, activeEmployee, activeLocation, activeDeviceId, activeTaxRate, customers, onCompleteSale }) {
  const [cart, setCart] = useState([]);
  const [scan, setScan] = useState("");
  const [scanMode, setScanMode] = useState(true);
  const [customerPhone, setCustomerPhone] = useState("");
  const [paymentMethod, setPaymentMethod] = useState(paymentMethods[0]);
  const [outOfState, setOutOfState] = useState(false);
  const [notes, setNotes] = useState("");
  const [message, setMessage] = useState("");
  const [completedSale, setCompletedSale] = useState(null);
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
    };
  }

  function findProductBySku(sku) {
    const clean = String(sku || "").trim().toLowerCase();
    if (!clean) return null;
    const matches = products.filter(
      (product) => String(product.sku || "").trim().toLowerCase() === clean,
    );
    if (!matches.length) return null;
    return (
      matches.find((product) => product.location === activeLocation) ||
      matches.find((product) => !product.location) ||
      matches[0]
    );
  }

  function addProductToCart(product) {
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
  }

  function handleScan(event) {
    event.preventDefault();
    const term = scan.trim();
    if (!term) return;
    const product = findProductBySku(term);
    if (!product) {
      setMessage(`No product found for "${term}".`);
    } else {
      addProductToCart(product);
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

  function removeLine(lineId) {
    setCart((current) => current.filter((line) => line.lineId !== lineId));
  }

  const subtotal = cart.reduce((sum, line) => sum + line.price * line.qty, 0);
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
  const canCheckout = cart.length > 0 && !imeiIssue && cardChargeComplete;

  useEffect(() => {
    setCard((current) =>
      current.status === "idle" ? current : { status: "idle", message: "", refNum: "" },
    );
  }, [total, paymentMethod]);

  async function chargeCard() {
    if (!requiresCardCharge || !total) return;
    try {
      setCard({ status: "charging", message: "Sending sale to the terminal...", refNum: "" });
      const result = await chargeOnDevice({
        amount: total.toFixed(2),
        deviceId: activeDeviceId,
        location: activeLocation,
        customerPhone: customerPhone.trim(),
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

  function handleCheckout() {
    if (!canCheckout) {
      if (imeiIssue) setMessage(imeiIssue);
      else if (!cardChargeComplete) setMessage("Charge the card before completing the sale.");
      return;
    }
    const lineItems = cart.map((line) => ({
      productId: line.productId,
      sku: line.sku,
      name: line.name,
      price: line.price,
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
    setPaymentMethod(paymentMethods[0]);
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
                    <th>Qty</th>
                    <th>IMEI</th>
                    <th>Line</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {cart.map((line) => (
                    <tr key={line.lineId}>
                      <td>
                        <strong>{line.name}</strong>
                        <p className="muted">{line.sku}</p>
                      </td>
                      <td>{formatMoney(line.price)}</td>
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
                      <td>{formatMoney(line.price * line.qty)}</td>
                      <td>
                        <button className="secondary-button" type="button" onClick={() => removeLine(line.lineId)}>
                          Remove
                        </button>
                      </td>
                    </tr>
                  ))}
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
                onSelectCustomer={(customer) => setCustomerPhone(customer.phone)}
                placeholder="For receipt / follow-up"
              />
            </label>
            <label className="field">
              <span>Payment method</span>
              <select value={paymentMethod} onChange={(event) => setPaymentMethod(event.target.value)}>
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
                <p className="eyebrow">Card payment (Sola terminal)</p>
                <h3>Charge {formatMoney(total)} on the terminal</h3>
              </div>
              <div className="card-reader-row">
                <span className={`reader-dot ${activeDeviceId ? "connected" : "disconnected"}`} aria-hidden="true" />
                <span className="muted">
                  {activeDeviceId
                    ? `Terminal: ${activeDeviceId}`
                    : "No terminal assigned to this store"}
                </span>
              </div>
              <button
                className="secondary-button"
                type="button"
                onClick={chargeCard}
                disabled={!total || !activeDeviceId || card.status === "charging" || card.status === "paid"}
              >
                {card.status === "paid"
                  ? "Card charged"
                  : card.status === "charging"
                    ? "Waiting for card..."
                    : "Charge card (tap / dip / swipe)"}
              </button>
              {!activeDeviceId ? (
                <p className="summary-error">Assign a Sola device ID to this store in Inventory before taking card payments.</p>
              ) : null}
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
            <h2>Tap a product</h2>
          </div>
        </div>
        <div className="pos-product-grid">
          {availableProducts.length ? (
            availableProducts.map((product) => (
              <button
                className="pos-product"
                type="button"
                key={product.id}
                onClick={() => {
                  addProductToCart(product);
                  setMessage(`Added ${product.name}.`);
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
            <p className="empty-state">No products for this store yet. Add them in Inventory.</p>
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

      {completedSale ? (
        <SaleReceiptDialog sale={completedSale} onClose={startNewSale} />
      ) : null}
    </>
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
  .hours { text-align: center; font-size: 11px; margin-bottom: 4px; }
  .thanks { text-align: center; margin-top: 10px; font-weight: 700; }
  .feedback { text-align: center; font-size: 10.5px; margin-top: 4px; }
  small { color: #000; }
`;

// Shared receipt header: logo, company-wide contact, and the store's address.
function receiptHeaderHtml(location) {
  const store = resolveStoreDetails(location);
  const logoUrl = `${window.location.origin}/logo.webp`;
  const storeBlock = store
    ? `<div class="store-name">${escapeHtml(store.name)}</div>
       <div class="store-addr">${escapeHtml(store.address)}${store.phone ? `<br/>${escapeHtml(store.phone)}` : ""}</div>`
    : location
      ? `<div class="store-name">${escapeHtml(location)}</div>`
      : "";
  return `
    <img class="receipt-logo" src="${logoUrl}" alt="Diamant Telecom" onerror="this.style.display='none'" />
    <div class="contact">${escapeHtml(COMPANY.phone)} &middot; ${escapeHtml(COMPANY.web)}<br/>${escapeHtml(COMPANY.email)}</div>
    ${storeBlock}`;
}

// Shared receipt footer: store hours, thank-you, and feedback line.
function receiptFooterHtml(location) {
  const store = resolveStoreDetails(location);
  const hours = store?.hours ? `<div class="hours">Hours: ${escapeHtml(store.hours)}</div>` : "";
  return `
    ${hours}
    <div class="thanks">Thank you for choosing Diamant Telecom!</div>
    <div class="feedback">Questions or feedback? Call our direct line ${escapeHtml(COMPANY.phone)} ext 9</div>`;
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
  const body = `
    ${receiptHeaderHtml(location)}
    <div class="divider"></div>
    <div class="meta">${escapeHtml(soldAt.toLocaleString())} &middot; Cashier: ${escapeHtml(sale.servedBy || "-")}${sale.customerPhone ? `<br/>Customer: ${escapeHtml(sale.customerPhone)}` : ""}</div>
    <div class="divider"></div>
    <table>${rows}</table>
    <div class="divider"></div>
    ${taxBlock}
    <div class="total"><span>Total</span><span>${formatMoney(total)}</span></div>
    <div class="paid">Paid by ${escapeHtml(sale.paymentMethod || "-")}</div>
    ${barcodeBlock}
    <div class="divider"></div>
    ${receiptFooterHtml(location)}`;

  openThermalReceipt("Receipt", css, body);
}

// Prints a repair drop-off ticket with the generated ticket number.
function printRepairTicket(report) {
  const details = report.details || {};
  const createdAt = (toJsDate(report.createdAt) || new Date()).toLocaleString();
  const location = report.location || details.location || "";

  const rowsSource = [
    ["Phone", report.customerPhone],
    ["Model", details.model],
    ["Issue", details.damage],
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
    ${receiptHeaderHtml(location)}
    <div class="divider"></div>
    <div class="eyebrow">Repair ticket</div>
    <div class="ticket">${escapeHtml(details.ticketNumber || "")}</div>
    <div class="meta">${escapeHtml(createdAt)}</div>
    <div class="divider"></div>
    <table>${rows}</table>
    ${report.notes ? `<div class="notes">Notes: ${escapeHtml(report.notes)}</div>` : ""}
    <div class="divider"></div>
    <div class="thanks">Keep this ticket for pickup.</div>
    ${receiptFooterHtml(location)}`;

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

function RestockDialog({ product, onClose, onAddStock }) {
  const requiresImei = Boolean(product.requiresImei);
  const [quantity, setQuantity] = useState("0");
  const [imeis, setImeis] = useState([]);
  const currentStock = requiresImei ? product.imeis?.length || 0 : Number(product.quantity) || 0;

  function submit(event) {
    event.preventDefault();
    const target = Number(quantity) || 0;
    if (!target) {
      window.alert("Enter how many units to add.");
      return;
    }
    if (requiresImei && imeis.length !== target) {
      window.alert(`You are adding ${target} units but scanned ${imeis.length} IMEIs. Scan exactly ${target}.`);
      return;
    }
    onAddStock({ addQuantity: target, newImeis: imeis });
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
          <label className="field">
            <span>Quantity to add</span>
            <input
              type="number"
              min="0"
              value={quantity}
              onChange={(event) => setQuantity(event.target.value)}
              autoFocus
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
  employees,
  storeLocations,
  employeeLocations,
  storeDevices,
  storeTax,
  sessionRole,
  onSaveProduct,
  onRemoveProduct,
  onAddStoreLocation,
  onRemoveStoreLocation,
  onSetEmployeeLocation,
  onSetStoreDevice,
  onSetStoreTaxRate,
}) {
  const isAdmin = sessionRole === "admin";
  const emptyForm = {
    id: "",
    sku: "",
    name: "",
    price: "",
    category: productCategories[0],
    requiresImei: false,
    location: storeLocations[0] || "",
    quantity: "0",
    imeis: [],
  };
  const emptyStore = { name: "", street: "", city: "", state: "", zip: "" };
  const [form, setForm] = useState(emptyForm);
  const [newStore, setNewStore] = useState(emptyStore);
  const [search, setSearch] = useState("");
  const [restock, setRestock] = useState(null);

  function taxFor(name) {
    return (storeTax || []).find((entry) => entry?.name === name) || null;
  }

  function updateField(name, value) {
    setForm((current) => ({ ...current, [name]: value }));
  }

  function addStock(product, { addQuantity, newImeis }) {
    if (product.requiresImei) {
      onSaveProduct({ ...product, imeis: [...(product.imeis || []), ...newImeis] });
    } else {
      onSaveProduct({ ...product, quantity: (Number(product.quantity) || 0) + addQuantity });
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
      quantity: String(product.quantity ?? 0),
      imeis: product.imeis || [],
    });
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return products
      .filter((product) => {
        if (!query) return true;
        return [product.name, product.sku, product.category, product.location]
          .join(" ")
          .toLowerCase()
          .includes(query);
      })
      .sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")));
  }, [products, search]);

  function locationFor(name) {
    return (employeeLocations || []).find((entry) => entry?.name === name)?.location || "";
  }

  function deviceFor(name) {
    return (storeDevices || []).find((entry) => entry?.name === name)?.deviceId || "";
  }

  if (!isAdmin) {
    return (
      <section className="workspace">
        <div className="workspace-header">
          <div>
            <p className="eyebrow">Inventory</p>
            <h2>Admin only</h2>
          </div>
        </div>
        <p className="empty-state">Only admins can manage the catalog and stores.</p>
      </section>
    );
  }

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
            <span>SKU / barcode</span>
            <input
              value={form.sku}
              onChange={(event) => updateField("sku", event.target.value)}
              placeholder="Scan or type"
              autoComplete="off"
              spellCheck={false}
              required
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
            <p className="eyebrow">Catalog</p>
            <h2>Products ({products.length})</h2>
          </div>
          <input
            className="pos-search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search name, SKU, store"
          />
        </div>
        <div className="table-wrap catalog-table">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>SKU</th>
                <th>Category</th>
                <th>Store</th>
                <th>Price</th>
                <th>Stock</th>
                <th>IMEI</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {filtered.length ? (
                filtered.map((product) => (
                  <tr key={product.id}>
                    <td><strong>{product.name}</strong></td>
                    <td>{product.sku}</td>
                    <td>{product.category}</td>
                    <td>{product.location || "All stores"}</td>
                    <td>{formatMoney(Number(product.price) || 0)}</td>
                    <td>{product.requiresImei ? (product.imeis?.length || 0) : Number(product.quantity) || 0}</td>
                    <td>{product.requiresImei ? "Yes" : "No"}</td>
                    <td className="pos-row-actions">
                      <button className="secondary-button compact-button" type="button" onClick={() => setRestock(product)}>
                        Restock
                      </button>
                      <button className="secondary-button compact-button" type="button" onClick={() => editProduct(product)}>
                        Edit
                      </button>
                      <button className="secondary-button compact-button" type="button" onClick={() => onRemoveProduct(product.id)}>
                        Delete
                      </button>
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan="8" className="empty-state">No products yet.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="history">
        <div className="history-header">
          <div>
            <p className="eyebrow">Stores</p>
            <h2>Locations</h2>
          </div>
        </div>
        <form
          className="form-grid inventory-form"
          onSubmit={(event) => {
            event.preventDefault();
            onAddStoreLocation(newStore);
            setNewStore(emptyStore);
          }}
        >
          <label className="field">
            <span>Store name</span>
            <input value={newStore.name} onChange={(event) => setNewStore((s) => ({ ...s, name: event.target.value }))} required />
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
          <button className="primary-button align-end" type="submit">Add store</button>
        </form>
        <p className="muted">Enter each store's sales-tax rate below.</p>
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
                <div className="store-row-actions">
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
            <p className="eyebrow">Staff</p>
            <h2>Assign employees to a store</h2>
          </div>
        </div>
        <div className="request-list">
          {employees.map((employee) => (
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
            </div>
          ))}
        </div>
      </section>

      {restock ? (
        <RestockDialog
          product={restock}
          onClose={() => setRestock(null)}
          onAddStock={(payload) => addStock(restock, payload)}
        />
      ) : null}
    </>
  );
}

function AdminPage({
  employees,
  reports,
  notifications,
  resetRequests,
  orderHandlers,
  onMarkResetHandled,
  onResetPassword,
  onAddOrderHandler,
  onRemoveOrderHandler,
}) {
  const [handlerForm, setHandlerForm] = useState({ name: "", phone: "", location: "" });
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
            <span>Location</span>
            <input value={handlerForm.location} onChange={(event) => updateHandlerField("location", event.target.value)} required />
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
  const saleLineItems = report.details?.lineItems || [];
  const returnableType = report.type === "sale" || report.type === "phoneOrder";
  const fullyReturned = report.details?.returnStatus === "Fully returned";
  const canReturn = Boolean(onReturn) && returnableType && saleLineItems.length > 0 && !fullyReturned;
  return (
    <tr>
      <td>{formatShortDate(report.createdAt)}</td>
      <td><span className={`badge ${report.type}`}>{reportTypes[report.type].label}</span></td>
      <td>{report.customerPhone || "-"}</td>
      <td><ReportDetails report={report} /></td>
      <td>{formatPayment(report.paymentAmount)}</td>
      <td>{report.paymentMethod || "-"}</td>
      <td>{report.servedBy || "-"}</td>
      <td>
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
        <td className="pos-row-actions">
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
  );
}

function ReportDetails({ report }) {
  const details = report.details || {};
  const lines = {
    sale: [
      ["Request", details.request],
      ["Product", details.productType],
      ["Store", details.location],
      ["Items", details.itemsText],
      ["Model", details.model],
      ["IMEI", details.imei],
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
      ["Address", details.address],
      ["Contact", details.contactDetails],
      ["Payment", details.paymentStatus],
      ["Tax", Number(details.taxAmount) > 0 ? `${formatMoney(Number(details.taxAmount))}${details.taxRate ? ` (${details.taxRate}%)` : ""}` : ""],
      ["Delivered", details.deliveredAt ? formatShortDate(details.deliveredAt) : ""],
      ["Returned", details.returnStatus],
    ],
    return: [
      ["Items", details.itemsText],
      ["IMEI", details.imei],
      ["Refund method", details.refundMethod],
      ["Card refund", details.solaRefundRef],
      ["Original sale", details.originalReportId],
      ["Refunded", details.refundTotal ? formatMoney(Number(details.refundTotal)) : ""],
    ],
  }[report.type];

  const recordingUrl = report.type === "call"
    ? callRecordingUrl(details.telebroadCallId, details.telebroadUniqueId)
    : "";

  return (
    <div className="details">
      {lines.filter(([, value]) => value).length ? (
        lines
          .filter(([, value]) => value)
          .map(([label, value]) => (
            <span key={label}><strong>{label}:</strong> {value}</span>
          ))
      ) : (
        <span>-</span>
      )}
      {recordingUrl ? (
        <a className="secondary-button compact-button" href={recordingUrl} target="_blank" rel="noopener noreferrer">
          ▶ Call recording
        </a>
      ) : null}
      {report.notes ? <span className="muted">{report.notes}</span> : null}
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
function CustomerPhoneInput({ value, onChange, customers, onSelectCustomer, placeholder, required, name, autoFocus }) {
  const [open, setOpen] = useState(false);
  const digits = digitsOnly(value);
  const matches = digits.length >= 2
    ? (customers || []).filter((customer) => (customer.phoneDigits || "").includes(digits)).slice(0, 8)
    : [];

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
        onFocus={() => setOpen(true)}
        onBlur={() => window.setTimeout(() => setOpen(false), 150)}
      />
      {open && matches.length ? (
        <div className="phone-autocomplete-menu">
          {matches.map((customer) => (
            <button
              type="button"
              className="phone-autocomplete-item"
              key={customer.id}
              onMouseDown={(event) => {
                event.preventDefault();
                onSelectCustomer?.(customer);
                setOpen(false);
              }}
            >
              <strong>{customer.name || "(no name)"}</strong>
              <span>{customer.phone}</span>
              {customer.address ? <small>{customer.address}</small> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function CustomersPage({ customers, sessionRole, onSave, onRemove, onSync }) {
  const emptyCustomer = { id: "", name: "", phone: "", address: "", email: "", contactDetails: "", notes: "" };
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

function EmployeeDialog({ onClose, onSyncName, onUnsyncName, storeLocations, employeeLocations, onSetLocation }) {
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
    <div className="dialog-backdrop" role="presentation">
      <div className="dialog-card dialog-card-wide" role="dialog" aria-modal="true" aria-labelledby="employee-dialog-title">
        <div>
          <p className="eyebrow">Team</p>
          <h2 id="employee-dialog-title">Manage employees</h2>
          <p className="muted">Create sign-in accounts and control who is an admin.</p>
        </div>

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

        <div className="form-actions">
          <button className="secondary-button" type="button" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
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
