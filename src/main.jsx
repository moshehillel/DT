import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

const STORAGE_KEY = "diamant-telecom-reports-v1";
const EMPLOYEE_KEY = "diamant-telecom-employees-v1";
const ACTIVE_EMPLOYEE_KEY = "diamant-telecom-active-employee-v1";
const SESSION_KEY = "diamant-telecom-session-v1";
const RESET_REQUESTS_KEY = "diamant-telecom-reset-requests-v1";
const ADMIN_PIN = "admin123";
const FUNCTIONS_BASE_URL = import.meta.env.VITE_FUNCTIONS_BASE_URL || "";

const defaultEmployees = ["Moshe", "Employee 1"];
const paymentMethods = ["Cash", "CC", "Check", "Card", "Zelle", "Cash App", "Apple Pay", "Other"];
const repairStatuses = [
  "Received",
  "Diagnosing",
  "Waiting for parts",
  "In repair",
  "Ready",
  "Picked up",
  "Delivered",
  "Cancelled",
];

const reportTypes = {
  call: {
    title: "Phone call report",
    label: "Phone call",
    mark: "C",
    description: "Inbound requests",
    fields: [
      { name: "callerName", label: "Caller name", placeholder: "Customer name" },
      { name: "reason", label: "What does the caller want?", placeholder: "Price check, repair update, sale question" },
      { name: "outcome", label: "Call outcome", placeholder: "Answered, needs follow-up, came in store" },
      { name: "followUpDate", label: "Follow-up date", type: "date" },
    ],
  },
  sale: {
    title: "Sale report",
    label: "Sale",
    mark: "S",
    description: "Phones and products",
    fields: [
      { name: "request", label: "What does the customer want?", placeholder: "Phone, charger, accessory, plan" },
      { name: "productType", label: "Product type", placeholder: "Phone" },
      { name: "model", label: "Phone model", placeholder: "iPhone 14 Pro" },
      { name: "imei", label: "IMEI", placeholder: "15 digit IMEI" },
    ],
  },
  repair: {
    title: "Repair report",
    label: "Repair",
    mark: "R",
    description: "Device service",
    fields: [
      { name: "model", label: "Phone model", placeholder: "Samsung Galaxy S23" },
      { name: "damage", label: "What is damaged?", placeholder: "Screen, charging port, battery" },
      { name: "status", label: "Repair status", type: "select", options: repairStatuses },
      { name: "paymentStatus", label: "Repair paid?", type: "select", options: ["Not paid", "Paid"] },
      { name: "notificationPreference", label: "When delivered notify by", type: "select", options: ["Text message", "Phone call"] },
      { name: "dueDate", label: "Expected ready date", type: "date" },
    ],
  },
  sim: {
    title: "SIM activation report",
    label: "SIM activation",
    mark: "A",
    description: "Carrier setup",
    fields: [
      { name: "carrier", label: "Carrier", placeholder: "US Mobile, H2O, Ultra, Lyca" },
      { name: "simPhone", label: "SIM phone number", placeholder: "(555) 000-0000" },
      { name: "plan", label: "Plan / activation notes", placeholder: "Monthly plan, port-in, new number" },
      { name: "accountPin", label: "PIN / account note", placeholder: "Optional" },
    ],
  },
  rental: {
    title: "Phone rental report",
    label: "Phone rental",
    mark: "P",
    description: "Temporary devices",
    fields: [
      { name: "rentalType", label: "Rental type", type: "select", options: ["SIM only", "Phone", "Upgraded phone"] },
      { name: "model", label: "Phone model", placeholder: "iPhone 12, Galaxy A14" },
      { name: "imei", label: "IMEI / device ID", placeholder: "Optional for SIM only" },
      { name: "simPhone", label: "SIM phone number", placeholder: "(555) 000-0000" },
      { name: "startDate", label: "Start date", type: "date" },
      { name: "endDate", label: "End date", type: "date" },
      { name: "returnTime", label: "Return time", type: "time" },
      { name: "deposit", label: "Deposit", placeholder: "0.00" },
    ],
  },
};

function readJson(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) || fallback;
  } catch {
    return fallback;
  }
}

function createEmptyFilters() {
  return {
    query: "",
    type: "all",
    employee: "all",
    status: "all",
    paymentMethod: "all",
    dateFrom: "",
    dateTo: "",
    amountMin: "",
    amountMax: "",
  };
}

function digitsOnly(value) {
  return String(value || "").replace(/\D/g, "");
}

function generateRepairTicketNumber(reports) {
  const today = new Date();
  const datePart = [
    today.getFullYear(),
    String(today.getMonth() + 1).padStart(2, "0"),
    String(today.getDate()).padStart(2, "0"),
  ].join("");
  const prefix = `DR-${datePart}`;
  const todaysRepairCount = reports.filter((report) =>
    report.type === "repair" && report.details?.ticketNumber?.startsWith(prefix),
  ).length;

  return `${prefix}-${String(todaysRepairCount + 1).padStart(4, "0")}`;
}

function App() {
  const [activeType, setActiveType] = useState("sale");
  const [employees, setEmployees] = useStoredState(EMPLOYEE_KEY, defaultEmployees);
  const [reports, setReports] = useStoredState(STORAGE_KEY, []);
  const [notifications, setNotifications] = useStoredState("diamant-telecom-notifications-v1", []);
  const [resetRequests, setResetRequests] = useStoredState(RESET_REQUESTS_KEY, []);
  const [activeEmployee, setActiveEmployee] = useState(
    localStorage.getItem(ACTIVE_EMPLOYEE_KEY) || employees[0] || "",
  );
  const [sessionRole, setSessionRole] = useState(() => {
    const savedRole = localStorage.getItem(SESSION_KEY) || "";
    return savedRole === "signed-in" ? "employee" : savedRole;
  });
  const [activeView, setActiveView] = useState("reports");
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

  const filteredReports = useMemo(() => {
    const query = filters.query.trim().toLowerCase();
    const phoneQuery = digitsOnly(query);
    const amountMin = Number.parseFloat(filters.amountMin);
    const amountMax = Number.parseFloat(filters.amountMax);
    const dateFrom = filters.dateFrom ? new Date(`${filters.dateFrom}T00:00:00`) : null;
    const dateTo = filters.dateTo ? new Date(`${filters.dateTo}T23:59:59`) : null;
    const availableReports = sessionRole === "admin"
      ? reports
      : reports.filter((report) => report.servedBy === activeEmployee);

    return availableReports.filter((report) => {
      const reportDate = new Date(report.createdAt);
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
        (!dateFrom || reportDate >= dateFrom) &&
        (!dateTo || reportDate <= dateTo) &&
        (!Number.isFinite(amountMin) || reportAmount >= amountMin) &&
        (!Number.isFinite(amountMax) || reportAmount <= amountMax) &&
        (!query || searchable.includes(query) || (phoneQuery && searchableDigits.includes(phoneQuery)))
      );
    });
  }, [activeEmployee, filters, reports, sessionRole]);

  const visibleEmployees = sessionRole === "admin" ? employees : [activeEmployee];
  const visibleNotifications = useMemo(() => {
    if (sessionRole === "admin") return notifications;
    const visibleReportIds = new Set(
      reports.filter((report) => report.servedBy === activeEmployee).map((report) => report.id),
    );
    return notifications.filter((notice) => visibleReportIds.has(notice.reportId));
  }, [activeEmployee, notifications, reports, sessionRole]);
  const appNotifications = useMemo(() => {
    const availableReports = sessionRole === "admin"
      ? reports
      : reports.filter((report) => report.servedBy === activeEmployee);
    return buildAppNotifications(availableReports);
  }, [activeEmployee, reports, sessionRole]);

  function saveReport(report) {
    setReports((current) => [report, ...current]);
    setFormNonce((value) => value + 1);
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

    if (status === "Delivered" && oldStatus !== "Delivered" && report?.customerPhone) {
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
      message: `Your ${report.details?.model || "phone"} repair has been delivered. Thank you from Diamant Telecom.`,
    };

    setNotifications((current) => [notification, ...current]);
    window.alert(
      `${method} queued for ${report.customerPhone}. This will send automatically after Firebase Cloud Functions / SMS provider is connected.`,
    );
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
    const confirmed = window.confirm("Clear all reports in this browser? This only affects local data.");
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
    setActiveView("reports");
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
    setActiveView("reports");
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
            <span>{activeView === "admin" ? "Admin workspace" : "Store reporting"}</span>
          </div>
          <button className="secondary-button" type="button" onClick={logout}>
            Logout
          </button>
        </div>

        <NotificationCenter notifications={appNotifications} />

        {activeView === "reports" ? (
          <>
            {activeType === "rental" ? (
              <RentalReportForm
                key={`${activeType}-${formNonce}`}
                activeEmployee={activeEmployee}
                onSave={saveReport}
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
        ) : (
          <AdminPage
            employees={employees}
            reports={reports}
            notifications={notifications}
            resetRequests={resetRequests}
            onMarkResetHandled={markResetHandled}
            onResetPassword={requestPasswordReset}
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

function useStoredState(key, fallback) {
  const [value, setValue] = useState(() => readJson(key, fallback));

  useEffect(() => {
    localStorage.setItem(key, JSON.stringify(value));
  }, [key, value]);

  return [value, setValue];
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

      {activeView === "reports" ? (
        <nav className="report-tabs" aria-label="Report type">
          {Object.entries(reportTypes).map(([type, config]) => (
            <button
              className={`tab ${activeType === type ? "active" : ""}`}
              type="button"
              key={type}
              onClick={() => onTypeChange(type)}
            >
              <span className="tab-mark">{config.mark}</span>
              <span>
                <strong>{config.label}</strong>
                <small>{config.description}</small>
              </span>
            </button>
          ))}
        </nav>
      ) : null}
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

    onSave(savedReport);

    if (activeType === "repair") {
      window.alert(`Repair ticket created: ${details.ticketNumber}`);
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
      <input name={field.name} type={field.type || "text"} placeholder={field.placeholder || ""} />
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

function buildAppNotifications(reports) {
  const today = startOfDay(new Date());

  return reports
    .filter((report) => report.type === "rental")
    .map((report) => {
      const dueDate = report.details?.returnDueDate || calculateReturnDueDate(report.details?.endDate, report.details?.returnTime);
      if (!dueDate) return null;
      const due = startOfDay(new Date(`${dueDate}T00:00:00`));
      if (due >= today) return null;

      return {
        id: `rental-overdue-${report.id}`,
        severity: "urgent",
        title: "Rental past due",
        message: `${report.customerPhone || "Customer"} should have returned ${report.details?.model || report.details?.rentalType || "rental"} by ${dueDate}.`,
      };
    })
    .filter(Boolean);
}

function startOfDay(date) {
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  return copy;
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
    simPhone: "",
    returnDays: "",
    paymentMethod: "Cash",
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
  const zoneDaysValid = totalDays > 0 && zoneDays === totalDays;
  const needsUsNumber = form.usaNumber;
  const hasCli = Boolean(submitState.cli);
  const hasUsDdi = Boolean(submitState.usDdi) && submitState.usDdi.toLowerCase() !== "yes";
  const numbersReady = hasCli && (!needsUsNumber || hasUsDdi);
  const rentalSubmitted = submitState.status === "submitted" || submitState.status === "numbers-ready";
  const minimumDaysValid = getMinimumRentalDays(form.rentalRegion) <= totalDays;
  const canSubmitRental = isRentalFormComplete(form)
    && zoneDaysValid
    && minimumDaysValid
    && totalPrice > 0
    && isRcukRental;
  const canSave = isSimpleRental
    ? isRentalFormComplete(form) && minimumDaysValid && totalPrice > 0
    : rentalSubmitted && submitState.getNumbersAttempted;

  function updateField(name, value) {
    setForm((current) => ({ ...current, [name]: value }));
    setSubmitState((current) => (
      current.status === "idle" ? current : { ...current, message: "Rental changed. Submit to RCUK again before saving.", status: "idle", rentalId: "", cli: "", usDdi: "", getNumbersAttempted: false, raw: null }
    ));
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
      sim_phone: form.simPhone,
      start_date: form.startDate,
      end_date: form.endDate,
      return_days: form.returnDays,
      customer_phone: form.customerPhone,
      payment_method: form.paymentMethod,
      total_price: totalPrice,
      notes: form.notes,
    };
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
        message: data.message || "Numbers are not ready yet.",
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
        message: ready ? "Numbers returned. You can save the rental report." : "Still pending. Try Get numbers again.",
        cli,
        usDdi,
        getNumbersAttempted: true,
        raw: data.raw || data,
      }));
    } catch (error) {
      setSubmitState((current) => ({
        ...current,
        status: "submitted",
        message: error.message || "Could not get rental numbers.",
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
        simPhone: form.simPhone,
        startDate: form.startDate,
        endDate: form.endDate,
        returnTime: `${form.returnDays || 0} days`,
        returnDueDate: calculateReturnDueDate(form.endDate, form.returnDays),
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
              <input value={form.imei} onChange={(event) => updateField("imei", event.target.value)} />
            </label>
            <label className="field">
              <span>SIM phone number</span>
              <input inputMode="tel" value={form.simPhone} onChange={(event) => updateField("simPhone", event.target.value)} />
            </label>
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
              <span>Served by</span>
              <input value={activeEmployee} disabled readOnly />
            </label>
          </div>

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
    { count: 0, amount: 0, call: 0, sale: 0, repair: 0, sim: 0, rental: 0 },
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

function AdminPage({ employees, reports, notifications, resetRequests, onMarkResetHandled, onResetPassword }) {
  const activity = useMemo(() => {
    return employees.map((employee) => {
      const employeeReports = reports.filter((report) => report.servedBy === employee);
      const totals = employeeReports.reduce(
        (acc, report) => {
          acc.amount += Number.parseFloat(report.paymentAmount || "0") || 0;
          acc[report.type] += 1;
          return acc;
        },
        { amount: 0, call: 0, sale: 0, repair: 0, sim: 0, rental: 0 },
      );
      const lastReport = employeeReports[0];
      return { employee, count: employeeReports.length, totals, lastReport };
    });
  }, [employees, reports]);

  const sortedReports = [...reports].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

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
      ["Model", details.model],
      ["IMEI", details.imei],
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
      ["SIM number", details.simPhone],
      ["Plan", details.plan],
    ],
    rental: [
      ["Rental ID", details.rentalId],
      ["Region", details.rentalRegion],
      ["Service", details.serviceType],
      ["Rental", details.rentalType],
      ["Model", details.model],
      ["IMEI", details.imei],
      ["SIM number", details.simPhone],
      ["Start", details.startDate],
      ["End", details.endDate],
      ["Return time", details.returnTime],
      ["Return due", details.returnDueDate],
      ["Total days", details.totalDays],
      ["UK/EU/WTS", `${details.ukDays || 0}/${details.euDays || 0}/${details.wtsDays || 0}`],
      ["SMS", details.addSms],
      ["USA number", details.usaNumber],
      ["CLI", details.cli],
      ["US DDI", details.usDdi],
      ["Total", details.totalPrice ? formatMoney(Number(details.totalPrice)) : ""],
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

function exportCsv(reports) {
  const headers = [
    "date",
    "type",
    "ticketNumber",
    "customerPhone",
    "servedBy",
    "paymentAmount",
    "paymentMethod",
    "status",
    "details",
    "notes",
  ];
  const csv = [
    headers.join(","),
    ...reports.map((report) =>
      [
        report.createdAt,
        reportTypes[report.type].label,
        report.details?.ticketNumber || "",
        report.customerPhone,
        report.servedBy,
        report.paymentAmount,
        report.paymentMethod,
        report.details?.status || "",
        Object.entries(report.details || {})
          .map(([key, value]) => `${key}: ${value}`)
          .join(" | "),
        report.notes,
      ]
        .map(csvCell)
        .join(","),
    ),
  ].join("\n");

  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `diamant-reports-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

function csvCell(value) {
  return `"${String(value || "").replaceAll('"', '""')}"`;
}

function formatDateTime(date) {
  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function formatShortDate(value) {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatPayment(value) {
  const amount = Number.parseFloat(value || "0");
  if (!Number.isFinite(amount) || !value) return "-";
  return formatMoney(amount);
}

function formatMoney(value) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value);
}

function numberValue(value) {
  const parsed = Number.parseInt(value || "0", 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function calculateInclusiveDays(startDate, endDate) {
  if (!startDate || !endDate) return 0;
  const start = new Date(`${startDate}T00:00:00`);
  const end = new Date(`${endDate}T00:00:00`);
  const diff = Math.round((end - start) / 86400000);
  return diff >= 0 ? diff + 1 : 0;
}

function calculateRentalDailyRate(serviceType, addSms) {
  const base = serviceType === "Voice and data" ? 20 : 15;
  return base + (addSms ? 2 : 0);
}

function isRentalFormComplete(form) {
  const required = [
    form.rentalRegion,
    form.serviceType,
    form.startDate,
    form.endDate,
    form.deviceKind,
    form.customerPhone,
    form.returnDays,
    form.paymentMethod,
  ];

  if (form.rentalRegion === "RCUK") {
    required.push(form.ukDays, form.euDays, form.wtsDays);
  }

  if (form.deviceKind !== "SIM only") {
    required.push(form.model, form.imei);
  }

  return required.every((value) => String(value ?? "").trim() !== "");
}

function getMinimumRentalDays(region) {
  if (region === "Israel") return 7;
  return 4;
}

function calculateRentalPrice(form, totalDays) {
  if (!totalDays) {
    return { dailyRate: 0, totalPrice: 0, label: "-" };
  }

  if (form.rentalRegion === "Israel") {
    return {
      dailyRate: 5,
      totalPrice: totalDays * 5,
      label: "$5/day",
    };
  }

  if (form.rentalRegion === "Canada") {
    const weekCount = Math.floor(totalDays / 7);
    const remainingDays = totalDays % 7;
    const weekendCount = Math.ceil(remainingDays / 2);
    const totalPrice = (weekCount * 45) + (weekendCount * 30);

    return {
      dailyRate: totalDays ? totalPrice / totalDays : 0,
      totalPrice,
      label: "$45/week, $30/weekend",
    };
  }

  const dailyRate = calculateRentalDailyRate(form.serviceType, form.addSms);
  return {
    dailyRate,
    totalPrice: totalDays * dailyRate,
    label: `${formatMoney(dailyRate)}/day`,
  };
}

function calculateReturnDueDate(endDate, returnDays) {
  if (!endDate) return "";
  const numericDays = numberValue(String(returnDays || "").replace("days", ""));
  const date = new Date(`${endDate}T00:00:00`);
  if (Number.isNaN(date.getTime())) return "";
  date.setDate(date.getDate() + numericDays);
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
