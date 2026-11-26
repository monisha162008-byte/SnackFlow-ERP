# SnackFlow ERP – Smart Manufacturing & Audit Management System

**Internship Project — Centre for Digital Infrastructure, NIT Tiruchirappalli**

SnackFlow ERP is a full-stack Manufacturing, Inventory Ledger, Production Costing, Sales & GST Invoicing, Receivables, and Audit Trail web application designed for a South Indian packaged snacks manufacturer based in Tamil Nadu.

---

## 1. Architecture & Technology Stack

- **Frontend:** React 19, TypeScript, Tailwind CSS v4, Lucide Icons, `jsPDF` + `jspdf-autotable` (PDF GST Tax Invoices & Reports), `ExcelJS` (`.xlsx` & `.csv` exports).
- **Backend:** Node.js + Express (`server.ts`) with Zod request validation and strict server-enforced RBAC middleware (`src/middleware/auth.ts`).
- **Database:** PostgreSQL (Google Cloud SQL) managed via **Drizzle ORM** (`src/db/schema.ts`) using atomic database transactions (`db.transaction`) and an immutable `stock_ledger`.
- **Authentication:**
  - **Firebase Authentication** (Google Sign-In via `firebase` + `firebase-admin` ID token verification).
  - **Demo Evaluation Role Accounts** secured with salted `crypto.scrypt` password hashes and HMAC-SHA256 signed in-memory Bearer session tokens.
- **Testing:** Vitest unit + full-stack HTTP & PostgreSQL benchmark integration suite (`tests/erp.test.ts`).

---

## 2. Demo Login Credentials (Dummy Evaluation Accounts)

| Role | Email | Password | Capabilities |
|---|---|---|---|
| **Owner** | `owner@snackflow.demo` | `Owner@2026` | Executive dashboard, all reports, audit history, user management, benchmark reset |
| **Factory Admin** | `admin@snackflow.demo` | `Admin@2026` | Order review/approval, GST invoicing, dispatch, payments, master data CRUD |
| **Production Supervisor** | `supervisor@snackflow.demo` | `Prod@2026` | Material purchases, material issues, BOM production runs, wastage & overheads |
| **Salesman A (Tamil Nadu)** | `salesman.a@snackflow.demo` | `Sales@2026` | Assigned customer (Retailer A), order entry, stock check, own order history |
| **Salesman B (Karnataka)** | `salesman.b@snackflow.demo` | `Sales@2026` | Assigned customer (Distributor B), order entry, stock shortage visibility |
| **Accountant / Auditor** | `auditor@snackflow.demo` | `Audit@2026` | Strictly **read-only** access across invoices, ledgers, reports, audit trail & exports |

> **Notice:** All accounts, GSTINs (`33AABCS1429B1Z5 (DUMMY)`), and invoices are dummy sample data for academic evaluation. The system is **not** connected to government GSTN or e-Invoice APIs.

---

## 3. Financial, GST & Costing Assumptions

1. **Zero Floating-Point Money & Stock Math (`src/lib/erp-math.ts`):**
   - Monetary amounts are stored as **integer paisa** (`₹50.00 = 5000`).
   - Stock quantities are stored as **integer milli-units** (`1 kg = 1000`, `1 litre = 1000`, `1 piece = 1000`).
   - Tax and variance rates are stored in **basis points** (`5% = 500 bps`, `2.5% = 250 bps`, `3% alert threshold = 300 bps`).
2. **Weighted-Average Raw Material Valuation:**
   - Opening flour: `100 kg @ ₹42 = ₹4,200`.
   - Purchase: `60 kg @ ₹45 = ₹2,700`.
   - Weighted-average rate: `(4200 + 2700) / 160 = ₹43.125/kg`.
   - Issuing `40 kg` charges `₹1,725.00` to the production run.
3. **Production Costing Absorption:**
   - Full cost of actual consumed materials—**including damaged pouches** (`188 good + 6 damaged = 194 pouches = ₹485`)—plus cartons (`9 × ₹15 = ₹135`), labour (`₹1,200`), and power/gas (`₹600`) is absorbed into the production run (`₹5,855`).
   - `Cost per good packet = ₹5,855 / 188 = ₹31.14`.
4. **Sequential GST Invoice Numbering:**
   - Financial-year prefix convention: `SF/26-27/0001`, incremented atomically inside the invoice transaction.
   - Factory state is `Tamil Nadu`. Intra-state customers (Tamil Nadu) receive **CGST 2.5% + SGST 2.5%**; inter-state customers (e.g., Karnataka) receive **IGST 5%**.
   - Posted invoices cannot be deleted; cancellation is performed via a **Credit Note reversal** (`CN/26-27/XXXX`).

---

## 4. Running Locally & Executing Tests

1. Install dependencies:
   ```bash
   npm install
   ```
2. Configure environment variables (`SQL_HOST`, `SQL_DB_NAME`, `SQL_USER`, `SQL_PASSWORD`, `SQL_ADMIN_USER`, `SQL_ADMIN_PASSWORD`) provided by Cloud SQL / runtime secrets.
3. Push schema to PostgreSQL:
   ```bash
   npx drizzle-kit push --config=src/db/drizzle.config.ts
   ```
4. Start development server on port `3000`:
   ```bash
   npm run dev
   ```
5. Run automated unit, RBAC, and full 16-step benchmark integration tests:
   ```bash
   npm test
   ```
6. Build for production:
   ```bash
   npm run build
   npm start
   ```

---

## 5. GitHub Synchronization

1. Initialize Git (if not already initialized) and verify `.gitignore` excludes `.env`, `node_modules/`, and `dist/`.
2. Stage and commit:
   ```bash
   git add .
   git commit -m "Implement SnackFlow ERP with PostgreSQL, RBAC, GST invoicing, and benchmark verification"
   ```
3. Add your GitHub remote and push:
   ```bash
   git remote add origin https://github.com/<your-username>/snackflow-erp.git
   git branch -M main
   git push -u origin main
   ```

---

## 6. Deployment & Obtaining a Public URL

- **In Google AI Studio:** Click **Share / Deploy** in the AI Studio toolbar to deploy the full-stack container to Google Cloud Run (with Cloud SQL Auth Proxy and Firebase OAuth domains automatically wired), producing a live `https://*.run.app` public URL.
- **Manual Cloud Run Deployment:**
  1. Build the frontend bundle: `npm run build`.
  2. Deploy with Cloud SQL connection and `NODE_ENV=production` running `npm start` (`node server.ts` on port `3000` / `$PORT`).
  3. Add the deployed Cloud Run domain to Firebase Authentication Authorized Domains.

---

## 7. Known Limitations

- Sample GST invoices use dummy GSTINs and do not integrate with live government GSTN / e-Way Bill / e-Invoice portals.
- Multi-currency and multi-warehouse transfer orders are outside the single-plant Tamil Nadu scope.
- Email/SMS notifications for low-stock alerts are surfaced in-app on the Operations Dashboard rather than dispatched via an external SMTP gateway.
