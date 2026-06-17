import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

const STORAGE_KEY = "diamant-telecom-reports-v1";
const EMPLOYEE_KEY = "diamant-telecom-employees-v1";
const ACTIVE_EMPLOYEE_KEY = "diamant-telecom-active-employee-v1";
const SESSION_KEY = "diamant-telecom-session-v1";
const RESET_REQUESTS_KEY = "diamant-telecom-reset-requests-v1";
const ADMIN_PIN = "admin123";

const defaultEmployees = ["Moshe", "Employee 1"];
const paymentMethods = ["Cash", "Card", "Zelle", "Cash App", "Apple Pay", "Other"];
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

        {activeView === "reports" ? (
          <>
            <ReportForm
              key={`${activeType}-${formNonce}`}
              activeType={activeType}
              activeEmployee={activeEmployee}
              onSave={saveReport}
            />

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

function ReportForm({ activeType, activeEmployee, onSave }) {
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

    onSave({
      id: crypto.randomUUID(),
      type: activeType,
      createdAt: new Date().toISOString(),
      servedBy: activeEmployee,
      customerPhone: String(formData.get("customerPhone") || "").trim(),
      paymentAmount: String(formData.get("paymentAmount") || "").trim(),
      paymentMethod: String(formData.get("paymentMethod") || "").trim(),
      notes: String(formData.get("notes") || "").trim(),
      details,
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
      <input name={field.name} type={field.type || "text"} placeholder={field.placeholder || ""} />
    </label>
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
    { count: 0, amount: 0, call: 0, sale: 0, repair: 0, sim: 0 },
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
        { amount: 0, call: 0, sale: 0, repair: 0, sim: 0 },
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
      ["Model", details.model],
      ["Damage", details.damage],
      ["Ready", details.dueDate],
    ],
    sim: [
      ["Carrier", details.carrier],
      ["SIM number", details.simPhone],
      ["Plan", details.plan],
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

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
