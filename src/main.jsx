import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ACTIVE_EMPLOYEE_KEY,
  ADMIN_PIN,
  defaultEmployees,
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
  SESSION_KEY,
  STORAGE_KEY,
  STORE_DEVICES_KEY,
  STORE_LOCATIONS_KEY,
} from "./constants";
import { useCloudCollectionState, useCloudDocumentState } from "./hooks/useCloudState";
import { attachAuthMetadata, ensureFirebaseAuth } from "./firebaseClient";
import { chargeOnDevice } from "./solaTerminal";
import {
  buildAppNotifications,
  calculateInclusiveDays,
  calculateRentalPrice,
  calculateReturnDueDate,
  createEmptyFilters,
  digitsOnly,
  escapeHtml,
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
  const [activeEmployee, setActiveEmployee] = useState(
    localStorage.getItem(ACTIVE_EMPLOYEE_KEY) || employees[0] || "",
  );
  const [sessionRole, setSessionRole] = useState(() => {
    const savedRole = localStorage.getItem(SESSION_KEY) || "";
    return savedRole === "signed-in" ? "employee" : savedRole;
  });
  const [activeView, setActiveView] = useState("pendingReports");
  const [filters, setFilters] = useState(createEmptyFilters);
  const [formNonce, setFormNonce] = useState(0);
  const [dialogOpen, setDialogOpen] = useState(false);

  useEffect(() => {
    if (!employees.includes(activeEmployee)) {
      setActiveEmployee(employees[0] || "");
    }
  }, [activeEmployee, employees]);

  useEffect(() => {
    localStorage.setItem(ACTIVE_EMPLOYEE_KEY, activeEmployee);
  }, [activeEmployee]);

  const activeLocation = useMemo(() => {
    const match = (employeeLocations || []).find((entry) => entry?.name === activeEmployee);
    return match?.location || storeLocations[0] || "";
  }, [employeeLocations, activeEmployee, storeLocations]);

  const activeDeviceId = useMemo(() => {
    const match = (storeDevices || []).find((entry) => entry?.name === activeLocation);
    return match?.deviceId || "";
  }, [storeDevices, activeLocation]);

  const employeeCanSeeReport = useMemo(() => {
    return (report) => {
      const store = report.location || report.details?.location || "";
      return !store || store === activeLocation || report.servedBy === activeEmployee;
    };
  }, [activeLocation, activeEmployee]);

  const filteredReports = useMemo(() => {
    const query = filters.query.trim().toLowerCase();
    const phoneQuery = digitsOnly(query);
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

      return (
        (filters.type === "all" || report.type === filters.type) &&
        (sessionRole !== "admin" || filters.employee === "all" || report.servedBy === filters.employee) &&
        (filters.paymentMethod === "all" || report.paymentMethod === filters.paymentMethod) &&
        (filters.status === "all" || report.details?.status === filters.status) &&
        (!dateFrom || (reportDate && reportDate >= dateFrom)) &&
        (!dateTo || (reportDate && reportDate <= dateTo)) &&
        (!Number.isFinite(amountMin) || reportAmount >= amountMin) &&
        (!Number.isFinite(amountMax) || reportAmount <= amountMax) &&
        (!query || searchable.includes(query) || (phoneQuery && searchableDigits.includes(phoneQuery)))
      );
    });
  }, [employeeCanSeeReport, filters, reports, sessionRole]);

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

  function addStoreLocation(name) {
    const cleanName = String(name || "").trim();
    if (!cleanName || storeLocations.includes(cleanName)) return;
    setStoreLocations((current) => [...current, cleanName]);
  }

  function removeStoreLocation(name) {
    if (storeLocations.length <= 1) {
      window.alert("Keep at least one store location.");
      return;
    }
    setStoreLocations((current) => current.filter((location) => location !== name));
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

  function addEmployee(name) {
    const cleanName = name.trim();
    if (!cleanName || employees.includes(cleanName)) return;
    setEmployees((current) => [...current, cleanName]);
    setActiveEmployee(cleanName);
  }

  function removeEmployee(name) {
    if (employees.length <= 1) {
      window.alert("Keep at least one employee.");
      return;
    }
    setEmployees((current) => current.filter((employee) => employee !== name));
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

  function login({ employeeName, role, pin }) {
    const name = employeeName.trim();
    if (!name) return;

    if (role === "admin") {
      if (pin !== ADMIN_PIN) {
        window.alert("Wrong admin PIN. Demo admin PIN is admin123.");
        return;
      }
      if (!employees.includes(name)) {
        setEmployees((current) => [...current, name]);
      }
      setActiveEmployee(name || "Admin");
      localStorage.setItem(SESSION_KEY, "admin");
      setSessionRole("admin");
      setActiveView("admin");
      return;
    }

    if (!employees.includes(name)) {
      setEmployees((current) => [...current, name]);
    }
    setActiveEmployee(name);
    localStorage.setItem(SESSION_KEY, "employee");
    setSessionRole("employee");
    setActiveView("pendingReports");
  }

  function requestPasswordReset(employeeName) {
    const name = employeeName.trim();
    if (!name) return;
    if (!employees.includes(name)) {
      setEmployees((current) => [...current, name]);
    }
    setResetRequests((current) => [
      {
        id: crypto.randomUUID(),
        employee: name,
        createdAt: new Date().toISOString(),
        status: "Requested",
      },
      ...current,
    ]);
    window.alert("Password reset request saved. In Firebase, this will send a real reset link.");
  }

  function markResetHandled(requestId) {
    setResetRequests((current) =>
      current.map((request) =>
        request.id === requestId ? { ...request, status: "Handled" } : request,
      ),
    );
  }

  function logout() {
    localStorage.removeItem(SESSION_KEY);
    setSessionRole("");
    setActiveView("pendingReports");
  }

  if (!sessionRole) {
    return (
      <LoginPage
        employees={employees}
        defaultEmployee={activeEmployee}
        onLogin={login}
        onResetPassword={requestPasswordReset}
      />
    );
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
            onClaim={claimPendingReport}
            onSave={savePendingReport}
          />
        ) : activeView === "openRepairs" ? (
          <OpenRepairsPage
            reports={filteredReports}
            onStatusChange={updateRepairStatus}
          />
        ) : activeView === "reports" ? (
          <>
            {activeType === "rental" ? (
              <RentalReportForm
                key={`${activeType}-${formNonce}`}
                activeEmployee={activeEmployee}
                onSave={saveReport}
              />
            ) : activeType === "phoneOrder" ? (
              <PhoneOrderPage
                key={`${activeType}-${formNonce}`}
                activeEmployee={activeEmployee}
                sessionRole={sessionRole}
                phoneOrders={phoneOrders}
                orderHandlers={orderHandlers}
                onCreate={createPhoneOrder}
                onDelivered={completePhoneOrder}
              />
            ) : (
              <ReportForm
                key={`${activeType}-${formNonce}`}
                activeType={activeType}
                activeEmployee={activeEmployee}
                reports={reports}
                onSave={saveReport}
              />
            )}

            <ReportHistory
              employees={visibleEmployees}
              reports={filteredReports}
              filters={filters}
              onFiltersChange={setFilters}
              onClearFilters={() => setFilters(createEmptyFilters())}
              onStatusChange={updateRepairStatus}
              onExport={() => exportCsv(filteredReports)}
              onClearReports={clearReports}
              notifications={visibleNotifications}
            />
          </>
        ) : activeView === "pos" ? (
          <PosPage
            key={`pos-${formNonce}`}
            products={products}
            activeEmployee={activeEmployee}
            activeLocation={activeLocation}
            activeDeviceId={activeDeviceId}
            onCompleteSale={savePosSale}
          />
        ) : activeView === "inventory" ? (
          <InventoryPage
            products={products}
            employees={employees}
            storeLocations={storeLocations}
            employeeLocations={employeeLocations}
            storeDevices={storeDevices}
            sessionRole={sessionRole}
            onSaveProduct={saveProduct}
            onRemoveProduct={removeProduct}
            onAddStoreLocation={addStoreLocation}
            onRemoveStoreLocation={removeStoreLocation}
            onSetEmployeeLocation={setEmployeeLocation}
            onSetStoreDevice={setStoreDevice}
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
          employees={employees}
          onAdd={addEmployee}
          onRemove={removeEmployee}
          onClose={() => setDialogOpen(false)}
        />
      )}
    </div>
  );
}

function LoginPage({ employees, defaultEmployee, onLogin, onResetPassword }) {
  const [employee, setEmployee] = useState(defaultEmployee || employees[0] || "");
  const [role, setRole] = useState("employee");
  const [pin, setPin] = useState("");

  function handleSubmit(event) {
    event.preventDefault();
    onLogin({ employeeName: employee, role, pin });
  }

  return (
    <main className="login-page">
      <section className="login-shell">
        <div className="login-aside">
          <div className="brand">
            <span className="brand-mark">D</span>
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
            <span className="brand-mark">D</span>
            <div>
              <h1>Diamant Telecom</h1>
              <p>Store reports</p>
            </div>
          </div>

          <form className="login-form" onSubmit={handleSubmit}>
            <div>
              <p className="eyebrow">{role === "admin" ? "Admin login" : "Employee login"}</p>
              <h2>{role === "admin" ? "Sign in to manage the store" : "Sign in to report customer activity"}</h2>
            </div>

            <div className="segmented-control" role="tablist" aria-label="Login type">
              <button
                className={role === "employee" ? "selected" : ""}
                type="button"
                onClick={() => setRole("employee")}
              >
                Employee
              </button>
              <button
                className={role === "admin" ? "selected" : ""}
                type="button"
                onClick={() => setRole("admin")}
              >
                Admin
              </button>
            </div>

            <label className="field">
              <span>{role === "admin" ? "Admin name" : "Employee name"}</span>
              <input
                list="employee-options"
                value={employee}
                onChange={(event) => setEmployee(event.target.value)}
                placeholder="Type your name"
                required
              />
              <datalist id="employee-options">
                {employees.map((name) => (
                  <option value={name} key={name} />
                ))}
              </datalist>
            </label>

            <label className="field">
              <span>{role === "admin" ? "Admin PIN" : "PIN"}</span>
              <input
                type="password"
                value={pin}
                onChange={(event) => setPin(event.target.value)}
                placeholder={role === "admin" ? "Demo: admin123" : "Demo mode: any PIN"}
              />
            </label>

            <button className="primary-button" type="submit">{role === "admin" ? "Admin login" : "Sign in"}</button>
            {role === "employee" ? (
              <button className="secondary-button" type="button" onClick={() => onResetPassword(employee)}>
                Reset password
              </button>
            ) : null}
          </form>
        </div>
      </section>
    </main>
  );
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
        <span className="brand-mark">D</span>
        <div>
          <h1>Diamant Telecom</h1>
          <p>Store reports</p>
        </div>
      </div>

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
      {sessionRole === "admin" ? (
        <button
          className={`ghost-button ${activeView === "admin" ? "active-ghost" : ""}`}
          type="button"
          onClick={() => onViewChange(activeView === "admin" ? "reports" : "admin")}
        >
          {activeView === "admin" ? "Back to reports" : "Admin page"}
        </button>
      ) : null}
      <button className="ghost-button" type="button" onClick={onLogout}>
        Sign out
      </button>

      <nav className="report-tabs" aria-label="Report type">
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
          {sessionRole === "admin" ? (
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
          ) : null}
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
        </nav>
    </aside>
  );
}

function ReportForm({ activeType, activeEmployee, reports, onSave }) {
  const [now, setNow] = useState(new Date());
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

    Promise.resolve(onSave(savedReport)).then(() => {
      if (activeType === "repair") {
        window.alert(`Repair ticket created: ${details.ticketNumber}`);
      }
    });
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
            <input name="customerPhone" inputMode="tel" autoComplete="tel" placeholder="(555) 123-4567" required />
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

function RentalReportForm({ activeEmployee, onSave }) {
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
              <input inputMode="tel" value={form.customerPhone} onChange={(event) => updateField("customerPhone", event.target.value)} required />
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
  reports,
  filters,
  onFiltersChange,
  onClearFilters,
  onStatusChange,
  onExport,
  onClearReports,
  notifications,
}) {
  const totals = reports.reduce(
    (acc, report) => {
      acc.count += 1;
      acc.amount += Number.parseFloat(report.paymentAmount || "0") || 0;
      acc[report.type] += 1;
      return acc;
    },
        { count: 0, amount: 0, call: 0, sale: 0, repair: 0, sim: 0, rental: 0, phoneOrder: 0 },
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
          <button className="secondary-button" type="button" onClick={onExport}>Export CSV</button>
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
          <span>From date</span>
          <input type="date" value={filters.dateFrom} onChange={(event) => updateFilter("dateFrom", event.target.value)} />
        </label>
        <label className="field">
          <span>To date</span>
          <input type="date" value={filters.dateTo} onChange={(event) => updateFilter("dateTo", event.target.value)} />
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

      <div className="summary-strip">
        <span className="metric">Reports <strong>{totals.count}</strong></span>
        <span className="metric">Payments <strong>{formatMoney(totals.amount)}</strong></span>
        <span className="metric">Calls <strong>{totals.call}</strong></span>
        <span className="metric">Sales <strong>{totals.sale}</strong></span>
        <span className="metric">Repairs <strong>{totals.repair}</strong></span>
        <span className="metric">SIM <strong>{totals.sim}</strong></span>
        <span className="metric">Rentals <strong>{totals.rental}</strong></span>
        <span className="metric">Orders <strong>{totals.phoneOrder}</strong></span>
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
            </tr>
          </thead>
          <tbody>
            {reports.length ? (
              reports.map((report) => (
                <ReportRow
                  report={report}
                  key={report.id}
                  onStatusChange={onStatusChange}
                />
              ))
            ) : (
              <tr>
                <td colSpan="8" className="empty-state">No reports match this view.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
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

function PendingReportsPage({ pendingReports, activeEmployee, onClaim, onSave }) {
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

function PendingReportCard({ pendingReport, activeEmployee, onClaim, onSave }) {
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
            <input value={fields.customerPhone} onChange={(event) => updateField("customerPhone", event.target.value)} />
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

function PhoneOrderPage({ activeEmployee, sessionRole, phoneOrders, orderHandlers, onCreate, onDelivered }) {
  const [now, setNow] = useState(new Date());
  const [form, setForm] = useState({
    location: orderHandlers[0]?.location || "",
    assignedTo: orderHandlers[0]?.name || "",
    customerName: "",
    customerPhone: "",
    contactDetails: "",
    address: "",
    model: "",
    orderTotal: "",
    paymentStatus: "Paid",
    paymentMethod: "Cash",
    notes: "",
  });

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
  const canCreate = form.location.trim()
    && form.assignedTo.trim()
    && form.customerPhone.trim()
    && form.address.trim()
    && form.model.trim()
    && form.orderTotal.trim()
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
      model: form.model.trim(),
      orderTotal: form.orderTotal.trim(),
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
            <input inputMode="tel" value={form.customerPhone} onChange={(event) => updateField("customerPhone", event.target.value)} required />
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

        <div className="form-grid">
          <label className="field">
            <span>Phone / order</span>
            <input value={form.model} onChange={(event) => updateField("model", event.target.value)} placeholder="iPhone 15, case, charger..." required />
          </label>
          <label className="field">
            <span>Order total</span>
            <input inputMode="decimal" value={form.orderTotal} onChange={(event) => updateField("orderTotal", event.target.value)} required />
          </label>
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

function PosPage({ products, activeEmployee, activeLocation, activeDeviceId, onCompleteSale }) {
  const [cart, setCart] = useState([]);
  const [scan, setScan] = useState("");
  const [customerPhone, setCustomerPhone] = useState("");
  const [paymentMethod, setPaymentMethod] = useState(paymentMethods[0]);
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

  const total = cart.reduce((sum, line) => sum + line.price * line.qty, 0);
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
        cardStatus: requiresCardCharge ? card.status : "",
        solaRefNum: requiresCardCharge ? card.refNum : "",
      },
    };
    onCompleteSale(sale);
    setCompletedSale(sale);
    setCart([]);
    setCustomerPhone("");
    setNotes("");
    setPaymentMethod(paymentMethods[0]);
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

        <form className="pos-scan" onSubmit={handleScan}>
          <input
            ref={scanRef}
            className="pos-scan-input"
            value={scan}
            onChange={(event) => setScan(event.target.value)}
            placeholder="Scan or type a barcode / SKU, then Enter"
            inputMode="text"
            autoComplete="off"
            spellCheck={false}
          />
          <button className="primary-button" type="submit">Add</button>
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
              <input
                inputMode="tel"
                value={customerPhone}
                onChange={(event) => setCustomerPhone(event.target.value)}
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
          <button className="primary-button" type="button" disabled={!canCheckout} onClick={handleCheckout}>
            Complete sale - {formatMoney(total)}
          </button>
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

      {completedSale ? (
        <SaleReceiptDialog sale={completedSale} onClose={startNewSale} />
      ) : null}
    </>
  );
}

function SaleReceiptDialog({ sale, onClose }) {
  const details = sale.details || {};
  const lines = details.lineItems || [];
  const total = Number(sale.paymentAmount) || 0;
  const soldAt = toJsDate(sale.createdAt) || new Date();

  function printReceipt() {
    const printWindow = window.open("", "_blank", "width=380,height=640");
    if (!printWindow) {
      window.print();
      return;
    }
    const rows = lines
      .map(
        (line) => `
          <tr>
            <td>${line.qty}x ${escapeHtml(line.name)}${line.imei ? `<br/><small>IMEI ${escapeHtml(line.imei)}</small>` : ""}</td>
            <td style="text-align:right">${formatMoney((Number(line.price) || 0) * (Number(line.qty) || 0))}</td>
          </tr>`,
      )
      .join("");
    printWindow.document.write(`
      <html>
        <head>
          <title>Receipt</title>
          <style>
            body { font-family: ui-sans-serif, system-ui, sans-serif; padding: 16px; color: #111; }
            h2 { margin: 0 0 2px; }
            .meta { font-size: 12px; color: #555; margin-bottom: 12px; }
            table { width: 100%; border-collapse: collapse; font-size: 13px; }
            td { padding: 6px 0; border-bottom: 1px dashed #ccc; vertical-align: top; }
            .total { font-size: 16px; font-weight: 700; margin-top: 12px; display: flex; justify-content: space-between; }
            .thanks { text-align: center; margin-top: 16px; font-size: 12px; color: #555; }
          </style>
        </head>
        <body>
          <h2>Diamant Telecom</h2>
          <div class="meta">
            ${escapeHtml(details.location || "")}<br/>
            ${soldAt.toLocaleString()}<br/>
            Cashier: ${escapeHtml(sale.servedBy || "")}${sale.customerPhone ? `<br/>Customer: ${escapeHtml(sale.customerPhone)}` : ""}
          </div>
          <table>${rows}</table>
          <div class="total"><span>Total</span><span>${formatMoney(total)}</span></div>
          <div class="meta" style="margin-top:6px">Paid by ${escapeHtml(sale.paymentMethod || "")}</div>
          <div class="thanks">Thank you!</div>
        </body>
      </html>`);
    printWindow.document.close();
    printWindow.focus();
    printWindow.print();
  }

  return (
    <div className="dialog-backdrop" role="presentation">
      <div className="dialog-card receipt-card" role="dialog" aria-modal="true">
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
      <div className="imei-lot-scan">
        <label className="field">
          <span>Scan IMEI one at a time</span>
          <input
            ref={inputRef}
            value={entry}
            onChange={(event) => setEntry(event.target.value)}
            onKeyDown={handleEntryKeyDown}
            placeholder="Scan or type 15-digit IMEI, then Enter"
            inputMode="numeric"
            autoComplete="off"
            spellCheck={false}
            disabled={reachedTarget}
          />
        </label>
        <button
          className="secondary-button align-end"
          type="button"
          onClick={addImei}
          disabled={reachedTarget}
        >
          Add IMEI
        </button>
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
  sessionRole,
  onSaveProduct,
  onRemoveProduct,
  onAddStoreLocation,
  onRemoveStoreLocation,
  onSetEmployeeLocation,
  onSetStoreDevice,
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
  const [form, setForm] = useState(emptyForm);
  const [newStore, setNewStore] = useState("");
  const [search, setSearch] = useState("");
  const [restock, setRestock] = useState(null);

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
          className="handler-form"
          onSubmit={(event) => {
            event.preventDefault();
            onAddStoreLocation(newStore);
            setNewStore("");
          }}
        >
          <label className="field">
            <span>New store name</span>
            <input value={newStore} onChange={(event) => setNewStore(event.target.value)} required />
          </label>
          <button className="primary-button align-end" type="submit">Add store</button>
        </form>
        <div className="request-list">
          {storeLocations.map((location) => (
            <div className="request-row" key={location}>
              <div>
                <strong>{location}</strong>
                <p className="muted">Sola terminal device ID for card payments at this store</p>
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
              <button className="secondary-button" type="button" onClick={() => onRemoveStoreLocation(location)}>
                Remove
              </button>
            </div>
          ))}
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
        { amount: 0, call: 0, sale: 0, repair: 0, sim: 0, rental: 0, phoneOrder: 0 },
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

function ReportRow({ report, onStatusChange }) {
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
        ) : (
          <span className="muted">-</span>
        )}
      </td>
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
      ["Card txn", details.solaRefNum || details.stripePaymentIntentId || details.solaTransactionId],
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
      ["Delivered", details.deliveredAt ? formatShortDate(details.deliveredAt) : ""],
    ],
  }[report.type];

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
      {report.notes ? <span className="muted">{report.notes}</span> : null}
    </div>
  );
}

function EmployeeDialog({ employees, onAdd, onRemove, onClose }) {
  const [name, setName] = useState("");

  function handleAdd() {
    onAdd(name);
    setName("");
  }

  return (
    <div className="dialog-backdrop" role="presentation">
      <div className="dialog-card" role="dialog" aria-modal="true" aria-labelledby="employee-dialog-title">
        <div>
          <p className="eyebrow">Team</p>
          <h2 id="employee-dialog-title">Manage employees</h2>
        </div>
        <label className="field">
          <span>Add employee</span>
          <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Employee name" />
        </label>
        <div className="employee-list">
          {employees.map((employee) => (
            <div className="employee-row" key={employee}>
              <span>{employee}</span>
              <button type="button" onClick={() => onRemove(employee)}>Remove</button>
            </div>
          ))}
        </div>
        <div className="form-actions">
          <button className="primary-button" type="button" onClick={handleAdd}>Add</button>
          <button className="secondary-button" type="button" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
