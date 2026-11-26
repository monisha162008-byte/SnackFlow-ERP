import 'dotenv/config';
import express, { type Request, type Response } from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { and, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from './src/db/index.ts';
import {
  auditLogs,
  bomItems,
  boms,
  companySettings,
  customers,
  dispatchItems,
  dispatches,
  finishedGoodsStock,
  gstInvoiceItems,
  gstInvoices,
  payments,
  productionConsumptions,
  productionRuns,
  products,
  purchaseItems,
  purchases,
  rawMaterials,
  salesOrderItems,
  salesOrders,
  stockLedger,
  suppliers,
  users,
} from './src/db/schema.ts';
import {
  DEMO_ACCOUNTS,
  ensureSeededOnBoot,
  runFullBenchmarkScenario,
  seedOpeningBenchmarkState,
} from './src/db/seed.ts';
import {
  hashPassword,
  requireAuth,
  requireRole,
  ROLES,
  signSessionToken,
  verifyPassword,
  type AuthRequest,
  type Role,
} from './src/middleware/auth.ts';
import {
  createAndOptionallyPostProductionRun,
  createPurchaseTransaction,
  createSalesOrderTransaction,
  ErpError,
  generateGstInvoiceTransaction,
  postProductionRun,
  recordAuditLog,
  recordDispatchTransaction,
  recordPaymentTransaction,
  recordStockAdjustmentTransaction,
  reverseGstInvoiceTransaction,
  reviewSalesOrderTransaction,
} from './src/services/erp-service.ts';
import {
  calculateBomPlannedQtyMilli,
  calculateProductionRunCosting,
  MILLI_SCALE,
} from './src/lib/erp-math.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let seedPromise: Promise<void> | null = null;
async function lazyEnsureSeeded() {
  if (!seedPromise) {
    seedPromise = ensureSeededOnBoot().catch((err) => {
      seedPromise = null;
      throw err;
    });
  }
  await seedPromise;
}

function handleError(res: Response, err: unknown) {
  if (err instanceof ErpError) {
    res.status(err.statusCode).json({ error: err.message });
    return;
  }
  if (err instanceof z.ZodError) {
    res.status(400).json({
      error: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    });
    return;
  }
  console.error('API error:', err);
  res.status(500).json({ error: 'Internal server error' });
}

export function createApp() {
  const app = express();
  app.use(express.json({ limit: '2mb' }));

  // Public health check
  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', app: 'SnackFlow ERP' });
  });

  // Public list of demo role labels (no secrets/passwords returned in API; passwords documented in UI & README for evaluation)
  app.get('/api/auth/demo-directory', async (_req, res) => {
    try {
      await lazyEnsureSeeded();
      res.json({
        accounts: DEMO_ACCOUNTS.map((a) => ({
          email: a.email,
          name: a.name,
          role: a.role,
        })),
      });
    } catch (err) {
      handleError(res, err);
    }
  });

  // Demo email/password login
  app.post('/api/auth/login', async (req, res) => {
    try {
      await lazyEnsureSeeded();
      const body = z
        .object({
          email: z.string().email(),
          password: z.string().min(1),
        })
        .parse(req.body);

      const normalized = body.email.toLowerCase().trim();
      const [userRow] = await db
        .select()
        .from(users)
        .where(eq(users.email, normalized))
        .limit(1);

      if (!userRow || !userRow.passwordHash) {
        res.status(401).json({ error: 'Invalid email or password' });
        return;
      }
      if (!userRow.isActive) {
        res.status(403).json({ error: 'Account is disabled' });
        return;
      }
      if (!verifyPassword(body.password, userRow.passwordHash)) {
        res.status(401).json({ error: 'Invalid email or password' });
        return;
      }

      const authUser = {
        id: userRow.id,
        uid: userRow.uid,
        email: userRow.email,
        name: userRow.name,
        role: userRow.role as Role,
        isActive: userRow.isActive,
      };
      const token = signSessionToken(authUser);

      res.json({
        token,
        user: {
          id: authUser.id,
          email: authUser.email,
          name: authUser.name,
          role: authUser.role,
        },
      });
    } catch (err) {
      handleError(res, err);
    }
  });

  // Authenticated profile (supports both Firebase Google ID token and Demo Bearer token)
  app.get('/api/auth/me', async (req: AuthRequest, res: Response, next) => {
    try {
      await lazyEnsureSeeded();
      next();
    } catch (err) {
      handleError(res, err);
    }
  }, requireAuth, async (req: AuthRequest, res: Response) => {
    res.json({
      user: {
        id: req.user!.id,
        email: req.user!.email,
        name: req.user!.name,
        role: req.user!.role,
      },
    });
  });

  // All routes below require authentication
  app.use('/api', async (req, res, next) => {
    if (req.path === '/health' || req.path.startsWith('/auth/')) {
      next();
      return;
    }
    try {
      await lazyEnsureSeeded();
      next();
    } catch (err) {
      handleError(res, err);
    }
  });

  // ==================== DASHBOARD ====================
  app.get('/api/dashboard', requireAuth, async (req: AuthRequest, res: Response) => {
    try {
      const today = new Date().toISOString().slice(0, 10);
      const user = req.user!;

      const [settings] = await db.select().from(companySettings).limit(1);
      const allOrders = await db.select().from(salesOrders).orderBy(desc(salesOrders.id));
      const allInvoices = await db.select().from(gstInvoices).orderBy(desc(gstInvoices.id));
      const allRuns = await db.select().from(productionRuns).orderBy(desc(productionRuns.id));
      const allMaterials = await db.select().from(rawMaterials).orderBy(rawMaterials.id);
      const allProducts = await db.select().from(products).orderBy(products.id);
      const allFg = await db.select().from(finishedGoodsStock);
      const allConsumptions = await db.select().from(productionConsumptions);
      const recentLedger = await db
        .select()
        .from(stockLedger)
        .orderBy(desc(stockLedger.id))
        .limit(10);

      const visibleOrders =
        user.role === 'salesman'
          ? allOrders.filter((o) => o.salesmanId === user.id)
          : allOrders;

      const todaySalesPaisa = allInvoices
        .filter((i) => i.status !== 'reversed' && i.invoiceDate === today)
        .reduce((sum, i) => sum + i.totalAmountPaisa, 0);

      const totalSalesPaisa = allInvoices
        .filter((i) => i.status !== 'reversed')
        .reduce((sum, i) => sum + i.totalAmountPaisa, 0);

      const ordersAwaitingApproval = visibleOrders.filter((o) => o.status === 'submitted').length;
      const ordersDispatched = visibleOrders.filter((o) =>
        ['dispatched', 'partially_dispatched'].includes(o.status)
      ).length;

      const fgMap = new Map(allFg.map((f) => [f.productId, f]));
      const totalFinishedGoodsPackets = allFg.reduce((s, f) => s + f.currentQtyPackets, 0);
      const lowMaterialAlerts = allMaterials.filter(
        (m) => m.isActive && m.currentQtyMilli <= m.reorderLevelMilli
      );

      const postedRuns = allRuns.filter((r) => r.status === 'posted');
      const totalProductionOutput = postedRuns.reduce((s, r) => s + r.actualGoodPackets, 0);
      const latestRun = postedRuns[0] ?? null;
      const yieldVarianceAlerts = postedRuns.filter((r) => r.hasVarianceAlert);

      const matMap = new Map(allMaterials.map((m) => [m.id, m]));
      const materialVarianceAlerts = allConsumptions
        .filter((c) => c.hasAlert)
        .map((c) => ({
          ...c,
          materialName: matMap.get(c.materialId)?.name ?? 'Material',
        }));

      const outstandingReceivablesPaisa = allInvoices
        .filter((i) => i.status !== 'reversed')
        .reduce((s, i) => s + i.outstandingPaisa, 0);

      const shortageOrders = visibleOrders.filter((o) => Boolean(o.stockShortageNote));

      // Monthly aggregations from real DB records
      const monthlySalesMap = new Map<string, number>();
      for (const inv of allInvoices) {
        if (inv.status === 'reversed') continue;
        const m = inv.invoiceDate.slice(0, 7);
        monthlySalesMap.set(m, (monthlySalesMap.get(m) ?? 0) + inv.totalAmountPaisa);
      }

      const monthlyProdMap = new Map<string, { expected: number; actual: number }>();
      for (const r of postedRuns) {
        const m = r.completionDate.slice(0, 7);
        const cur = monthlyProdMap.get(m) ?? { expected: 0, actual: 0 };
        cur.expected += r.expectedOutputPackets;
        cur.actual += r.actualGoodPackets;
        monthlyProdMap.set(m, cur);
      }

      const consumptionByMaterial = allMaterials.map((m) => {
        const lines = allConsumptions.filter((c) => c.materialId === m.id);
        const plannedMilli = lines.reduce((s, l) => s + l.plannedQtyMilli, 0);
        const actualMilli = lines.reduce((s, l) => s + l.actualQtyMilli, 0);
        return {
          name: m.name,
          unit: m.unit,
          planned: plannedMilli / MILLI_SCALE,
          actual: actualMilli / MILLI_SCALE,
          closing: m.currentQtyMilli / MILLI_SCALE,
        };
      });

      res.json({
        company: settings,
        kpis: {
          todaySalesPaisa,
          totalSalesPaisa,
          ordersAwaitingApproval,
          ordersDispatched,
          totalFinishedGoodsPackets,
          lowMaterialAlertCount: lowMaterialAlerts.length,
          totalProductionOutput,
          latestCostPerPacketPaisa: latestRun?.costPerGoodPacketPaisa ?? 0,
          latestYieldVarianceBps: latestRun?.yieldVarianceBps ?? 0,
          yieldVarianceAlertCount: yieldVarianceAlerts.length,
          outstandingReceivablesPaisa,
          shortageOrderCount: shortageOrders.length,
        },
        alerts: {
          lowMaterials: lowMaterialAlerts,
          yieldVarianceRuns: yieldVarianceAlerts,
          materialVariances: materialVarianceAlerts,
          shortageOrders,
        },
        charts: {
          monthlySales: Array.from(monthlySalesMap.entries()).map(([month, totalPaisa]) => ({
            month,
            totalRupees: totalPaisa / 100,
          })),
          monthlyProduction: Array.from(monthlyProdMap.entries()).map(([month, vals]) => ({
            month,
            ...vals,
          })),
          materialConsumption: consumptionByMaterial,
        },
        finishedGoods: allProducts.map((p) => ({
          productId: p.id,
          code: p.code,
          name: p.name,
          packSizeLabel: p.packSizeLabel,
          currentQtyPackets: fgMap.get(p.id)?.currentQtyPackets ?? 0,
          avgCostPaisa: fgMap.get(p.id)?.avgCostPaisa ?? 0,
          sellingPricePaisa: p.sellingPricePaisa,
        })),
        recentTransactions: recentLedger,
      });
    } catch (err) {
      handleError(res, err);
    }
  });

  // ==================== PRODUCTS ====================
  app.get('/api/products', requireAuth, async (_req, res) => {
    try {
      const prods = await db.select().from(products).orderBy(products.id);
      const fg = await db.select().from(finishedGoodsStock);
      const allBoms = await db.select().from(boms);
      const fgMap = new Map(fg.map((f) => [f.productId, f]));
      const bomMap = new Map(allBoms.map((b) => [b.id, b]));

      res.json(
        prods.map((p) => ({
          ...p,
          availablePackets: fgMap.get(p.id)?.currentQtyPackets ?? 0,
          avgCostPaisa: fgMap.get(p.id)?.avgCostPaisa ?? 0,
          bomName: p.bomId ? bomMap.get(p.bomId)?.name ?? null : null,
        }))
      );
    } catch (err) {
      handleError(res, err);
    }
  });

  app.post(
    '/api/products',
    requireAuth,
    requireRole(['factory_admin', 'owner']),
    async (req: AuthRequest, res: Response) => {
      try {
        const body = z
          .object({
            code: z.string().min(2),
            name: z.string().min(2),
            category: z.string().min(2),
            packSizeLabel: z.string().min(1),
            packSizeGrams: z.number().int().positive(),
            packetsPerCarton: z.number().int().positive(),
            unit: z.string().min(1).default('packet'),
            hsnCode: z.string().min(4),
            sellingPricePaisa: z.number().int().positive(),
            gstBps: z.number().int().min(0).max(2800),
            bomId: z.number().int().positive().nullable().optional(),
            reorderLevelPackets: z.number().int().min(0).default(50),
            isActive: z.boolean().default(true),
          })
          .parse(req.body);

        const created = await db.transaction(async (tx) => {
          const [p] = await tx
            .insert(products)
            .values({
              ...body,
              bomId: body.bomId ?? null,
            })
            .returning();
          await tx.insert(finishedGoodsStock).values({
            productId: p.id,
            currentQtyPackets: 0,
            avgCostPaisa: 0,
          });
          await recordAuditLog(tx, req.user!, 'CREATE_PRODUCT', 'product', p.code, null, p);
          return p;
        });

        res.status(201).json(created);
      } catch (err) {
        handleError(res, err);
      }
    }
  );

  app.patch(
    '/api/products/:id',
    requireAuth,
    requireRole(['factory_admin', 'owner']),
    async (req: AuthRequest, res: Response) => {
      try {
        const id = Number(req.params.id);
        const body = z
          .object({
            name: z.string().min(2).optional(),
            category: z.string().min(2).optional(),
            packSizeLabel: z.string().min(1).optional(),
            packSizeGrams: z.number().int().positive().optional(),
            packetsPerCarton: z.number().int().positive().optional(),
            hsnCode: z.string().min(4).optional(),
            sellingPricePaisa: z.number().int().positive().optional(),
            gstBps: z.number().int().min(0).max(2800).optional(),
            bomId: z.number().int().positive().nullable().optional(),
            reorderLevelPackets: z.number().int().min(0).optional(),
            isActive: z.boolean().optional(),
          })
          .parse(req.body);

        const [prev] = await db.select().from(products).where(eq(products.id, id)).limit(1);
        if (!prev) {
          res.status(404).json({ error: 'Product not found' });
          return;
        }
        const [updated] = await db.transaction(async (tx) => {
          const rows = await tx.update(products).set(body).where(eq(products.id, id)).returning();
          await recordAuditLog(tx, req.user!, 'UPDATE_PRODUCT', 'product', prev.code, prev, rows[0]);
          return rows;
        });
        res.json(updated);
      } catch (err) {
        handleError(res, err);
      }
    }
  );

  // ==================== CUSTOMERS ====================
  app.get('/api/customers', requireAuth, async (req: AuthRequest, res: Response) => {
    try {
      const user = req.user!;
      const allCustomers = await db.select().from(customers).orderBy(customers.id);
      const allUsers = await db.select({ id: users.id, name: users.name, role: users.role }).from(users);
      const userMap = new Map(allUsers.map((u) => [u.id, u.name]));

      const filtered =
        user.role === 'salesman'
          ? allCustomers.filter((c) => c.assignedSalesmanId === user.id)
          : allCustomers;

      res.json(
        filtered.map((c) => ({
          ...c,
          assignedSalesmanName: c.assignedSalesmanId
            ? userMap.get(c.assignedSalesmanId) ?? null
            : null,
        }))
      );
    } catch (err) {
      handleError(res, err);
    }
  });

  app.post(
    '/api/customers',
    requireAuth,
    requireRole(['factory_admin', 'owner']),
    async (req: AuthRequest, res: Response) => {
      try {
        const body = z
          .object({
            code: z.string().min(2),
            name: z.string().min(2),
            customerType: z.enum(['retailer', 'distributor']),
            contactPerson: z.string().min(2),
            phone: z.string().min(6),
            email: z.string().email().optional().or(z.literal('')),
            address: z.string().min(3),
            state: z.string().min(2),
            gstin: z.string().optional().or(z.literal('')),
            assignedSalesmanId: z.number().int().positive().nullable().optional(),
            creditLimitPaisa: z.number().int().min(0).default(5000000),
          })
          .parse(req.body);

        const [created] = await db.transaction(async (tx) => {
          const rows = await tx
            .insert(customers)
            .values({
              ...body,
              email: body.email || null,
              gstin: body.gstin || null,
              assignedSalesmanId: body.assignedSalesmanId ?? null,
            })
            .returning();
          await recordAuditLog(tx, req.user!, 'CREATE_CUSTOMER', 'customer', rows[0].code, null, rows[0]);
          return rows;
        });

        res.status(201).json(created);
      } catch (err) {
        handleError(res, err);
      }
    }
  );

  app.patch(
    '/api/customers/:id',
    requireAuth,
    requireRole(['factory_admin', 'owner']),
    async (req: AuthRequest, res: Response) => {
      try {
        const id = Number(req.params.id);
        const body = z
          .object({
            name: z.string().min(2).optional(),
            customerType: z.enum(['retailer', 'distributor']).optional(),
            contactPerson: z.string().min(2).optional(),
            phone: z.string().min(6).optional(),
            email: z.string().optional().nullable(),
            address: z.string().min(3).optional(),
            state: z.string().min(2).optional(),
            gstin: z.string().optional().nullable(),
            assignedSalesmanId: z.number().int().positive().nullable().optional(),
            creditLimitPaisa: z.number().int().min(0).optional(),
            isActive: z.boolean().optional(),
          })
          .parse(req.body);

        const [prev] = await db.select().from(customers).where(eq(customers.id, id)).limit(1);
        if (!prev) {
          res.status(404).json({ error: 'Customer not found' });
          return;
        }
        const [updated] = await db.transaction(async (tx) => {
          const rows = await tx.update(customers).set(body).where(eq(customers.id, id)).returning();
          await recordAuditLog(tx, req.user!, 'UPDATE_CUSTOMER', 'customer', prev.code, prev, rows[0]);
          return rows;
        });
        res.json(updated);
      } catch (err) {
        handleError(res, err);
      }
    }
  );

  // ==================== SUPPLIERS ====================
  app.get('/api/suppliers', requireAuth, async (_req, res) => {
    try {
      const list = await db.select().from(suppliers).orderBy(suppliers.id);
      res.json(list);
    } catch (err) {
      handleError(res, err);
    }
  });

  app.post(
    '/api/suppliers',
    requireAuth,
    requireRole(['factory_admin', 'owner']),
    async (req: AuthRequest, res: Response) => {
      try {
        const body = z
          .object({
            code: z.string().min(2),
            name: z.string().min(2),
            contactPerson: z.string().min(2),
            phone: z.string().min(6),
            email: z.string().email().optional().or(z.literal('')),
            address: z.string().min(3),
            state: z.string().min(2),
            gstin: z.string().optional().or(z.literal('')),
          })
          .parse(req.body);

        const [created] = await db.transaction(async (tx) => {
          const rows = await tx
            .insert(suppliers)
            .values({
              ...body,
              email: body.email || null,
              gstin: body.gstin || null,
            })
            .returning();
          await recordAuditLog(tx, req.user!, 'CREATE_SUPPLIER', 'supplier', rows[0].code, null, rows[0]);
          return rows;
        });
        res.status(201).json(created);
      } catch (err) {
        handleError(res, err);
      }
    }
  );

  app.patch(
    '/api/suppliers/:id',
    requireAuth,
    requireRole(['factory_admin', 'owner']),
    async (req: AuthRequest, res: Response) => {
      try {
        const id = Number(req.params.id);
        const body = z
          .object({
            name: z.string().min(2).optional(),
            contactPerson: z.string().min(2).optional(),
            phone: z.string().min(6).optional(),
            email: z.string().optional().nullable(),
            address: z.string().min(3).optional(),
            state: z.string().min(2).optional(),
            gstin: z.string().optional().nullable(),
            isActive: z.boolean().optional(),
          })
          .parse(req.body);
        const [prev] = await db.select().from(suppliers).where(eq(suppliers.id, id)).limit(1);
        if (!prev) {
          res.status(404).json({ error: 'Supplier not found' });
          return;
        }
        const [updated] = await db.transaction(async (tx) => {
          const rows = await tx.update(suppliers).set(body).where(eq(suppliers.id, id)).returning();
          await recordAuditLog(tx, req.user!, 'UPDATE_SUPPLIER', 'supplier', prev.code, prev, rows[0]);
          return rows;
        });
        res.json(updated);
      } catch (err) {
        handleError(res, err);
      }
    }
  );

  // ==================== RAW MATERIALS & PACKAGING ====================
  app.get('/api/materials', requireAuth, async (_req, res) => {
    try {
      const list = await db.select().from(rawMaterials).orderBy(rawMaterials.id);
      res.json(
        list.map((m) => ({
          ...m,
          weightedAvgRatePaisa:
            m.currentQtyMilli > 0
              ? Math.round((m.totalValuePaisa * MILLI_SCALE) / m.currentQtyMilli)
              : m.openingRatePaisa,
          weightedAvgRateExactRupees:
            m.currentQtyMilli > 0
              ? (m.totalValuePaisa / 100) / (m.currentQtyMilli / MILLI_SCALE)
              : m.openingRatePaisa / 100,
        }))
      );
    } catch (err) {
      handleError(res, err);
    }
  });

  app.post(
    '/api/materials',
    requireAuth,
    requireRole(['factory_admin', 'owner']),
    async (req: AuthRequest, res: Response) => {
      try {
        const body = z
          .object({
            code: z.string().min(2),
            name: z.string().min(2),
            category: z.enum(['raw_material', 'packaging']),
            unit: z.enum(['kg', 'litre', 'pieces']),
            openingQtyMilli: z.number().int().min(0),
            openingRatePaisa: z.number().int().min(0),
            reorderLevelMilli: z.number().int().min(0),
          })
          .parse(req.body);

        const openingVal = Math.round(
          (body.openingQtyMilli * body.openingRatePaisa) / MILLI_SCALE
        );

        const created = await db.transaction(async (tx) => {
          const [mat] = await tx
            .insert(rawMaterials)
            .values({
              ...body,
              currentQtyMilli: body.openingQtyMilli,
              totalValuePaisa: openingVal,
            })
            .returning();

          if (body.openingQtyMilli > 0) {
            await tx.insert(stockLedger).values({
              itemType: body.category,
              materialId: mat.id,
              productId: null,
              itemName: mat.name,
              qtyDeltaMilli: body.openingQtyMilli,
              balanceAfterMilli: body.openingQtyMilli,
              unit: mat.unit,
              unitCostPaisa: body.openingRatePaisa,
              totalValuePaisa: openingVal,
              movementType: 'opening_stock',
              sourceDocType: 'opening_balance',
              sourceDocId: mat.code,
              userId: req.user!.id,
              userName: req.user!.name,
              remarks: 'Opening balance recorded on material creation',
            });
          }

          await recordAuditLog(tx, req.user!, 'CREATE_MATERIAL', 'raw_material', mat.code, null, mat);
          return mat;
        });

        res.status(201).json(created);
      } catch (err) {
        handleError(res, err);
      }
    }
  );

  // ==================== BILL OF MATERIALS ====================
  app.get('/api/boms', requireAuth, async (_req, res) => {
    try {
      const allBoms = await db.select().from(boms).orderBy(boms.id);
      const allItems = await db.select().from(bomItems).orderBy(bomItems.id);
      const allMats = await db.select().from(rawMaterials);
      const matMap = new Map(allMats.map((m) => [m.id, m]));

      res.json(
        allBoms.map((b) => ({
          ...b,
          items: allItems
            .filter((i) => i.bomId === b.id)
            .map((i) => ({
              ...i,
              materialCode: matMap.get(i.materialId)?.code ?? '',
              materialName: matMap.get(i.materialId)?.name ?? 'Material',
              currentStockMilli: matMap.get(i.materialId)?.currentQtyMilli ?? 0,
              weightedAvgRateExactRupees: (() => {
                const m = matMap.get(i.materialId);
                if (!m) return 0;
                return m.currentQtyMilli > 0
                  ? (m.totalValuePaisa / 100) / (m.currentQtyMilli / MILLI_SCALE)
                  : m.openingRatePaisa / 100;
              })(),
            })),
        }))
      );
    } catch (err) {
      handleError(res, err);
    }
  });

  app.post(
    '/api/boms',
    requireAuth,
    requireRole(['factory_admin', 'owner']),
    async (req: AuthRequest, res: Response) => {
      try {
        const body = z
          .object({
            code: z.string().min(2),
            name: z.string().min(2),
            version: z.string().min(1).default('v1.0'),
            basePackGrams: z.number().int().positive(),
            standardBatchPackets: z.number().int().positive(),
            expectedYieldPackets: z.number().int().positive(),
            notes: z.string().optional(),
            items: z
              .array(
                z.object({
                  materialId: z.number().int().positive(),
                  standardQtyMilli: z.number().int().positive(),
                  componentType: z.enum(['raw_material', 'packaging']),
                  scalingRule: z.enum(['proportional_to_weight', 'per_packet', 'per_carton']),
                  standardRatePaisa: z.number().int().min(0),
                })
              )
              .min(1),
          })
          .parse(req.body);

        const created = await db.transaction(async (tx) => {
          const [b] = await tx
            .insert(boms)
            .values({
              code: body.code,
              name: body.name,
              version: body.version,
              basePackGrams: body.basePackGrams,
              standardBatchPackets: body.standardBatchPackets,
              expectedYieldPackets: body.expectedYieldPackets,
              notes: body.notes ?? null,
            })
            .returning();

          for (const item of body.items) {
            const [mat] = await tx
              .select()
              .from(rawMaterials)
              .where(eq(rawMaterials.id, item.materialId))
              .limit(1);
            if (!mat) throw new ErpError(404, `Material ${item.materialId} not found.`);
            await tx.insert(bomItems).values({
              bomId: b.id,
              materialId: item.materialId,
              standardQtyMilli: item.standardQtyMilli,
              unit: mat.unit,
              componentType: item.componentType,
              scalingRule: item.scalingRule,
              standardRatePaisa: item.standardRatePaisa,
            });
          }

          await recordAuditLog(tx, req.user!, 'CREATE_BOM', 'bom', b.code, null, b);
          return b;
        });

        res.status(201).json(created);
      } catch (err) {
        handleError(res, err);
      }
    }
  );

  // Preview scaled BOM plan for any product & batchCount (supports 200g / 500g variant sharing)
  app.get('/api/boms/:bomId/plan', requireAuth, async (req, res) => {
    try {
      const bomId = Number(req.params.bomId);
      const productId = Number(req.query.productId);
      const batchCount = Math.max(1, Number(req.query.batchCount || 1));

      const [bom] = await db.select().from(boms).where(eq(boms.id, bomId)).limit(1);
      if (!bom) {
        res.status(404).json({ error: 'BOM not found' });
        return;
      }
      const [product] = await db.select().from(products).where(eq(products.id, productId)).limit(1);
      if (!product) {
        res.status(404).json({ error: 'Product not found' });
        return;
      }

      const items = await db.select().from(bomItems).where(eq(bomItems.bomId, bom.id));
      const allMats = await db.select().from(rawMaterials);
      const matMap = new Map(allMats.map((m) => [m.id, m]));

      res.json({
        bomId: bom.id,
        productId: product.id,
        batchCount,
        expectedOutputPackets: bom.expectedYieldPackets * batchCount,
        packScalingRatio: product.packSizeGrams / bom.basePackGrams,
        lines: items.map((line) => {
          const mat = matMap.get(line.materialId)!;
          const plannedQtyMilli = calculateBomPlannedQtyMilli({
            standardQtyMilli: line.standardQtyMilli,
            scalingRule: line.scalingRule,
            batchCount,
            bomBasePackGrams: bom.basePackGrams,
            bomExpectedYieldPackets: bom.expectedYieldPackets,
            productPackSizeGrams: product.packSizeGrams,
            productPacketsPerCarton: product.packetsPerCarton,
          });
          return {
            materialId: mat.id,
            materialName: mat.name,
            materialCode: mat.code,
            componentType: line.componentType,
            scalingRule: line.scalingRule,
            unit: mat.unit,
            plannedQtyMilli,
            availableQtyMilli: mat.currentQtyMilli,
          };
        }),
      });
    } catch (err) {
      handleError(res, err);
    }
  });

  // ==================== INVENTORY & STOCK LEDGER ====================
  app.get('/api/inventory', requireAuth, async (_req, res) => {
    try {
      const mats = await db.select().from(rawMaterials).orderBy(rawMaterials.id);
      const prods = await db.select().from(products).orderBy(products.id);
      const fg = await db.select().from(finishedGoodsStock);
      const fgMap = new Map(fg.map((f) => [f.productId, f]));

      res.json({
        rawMaterials: mats.filter((m) => m.category === 'raw_material'),
        packagingMaterials: mats.filter((m) => m.category === 'packaging'),
        finishedGoods: prods.map((p) => ({
          productId: p.id,
          code: p.code,
          name: p.name,
          packSizeLabel: p.packSizeLabel,
          packetsPerCarton: p.packetsPerCarton,
          currentQtyPackets: fgMap.get(p.id)?.currentQtyPackets ?? 0,
          avgCostPaisa: fgMap.get(p.id)?.avgCostPaisa ?? 0,
          sellingPricePaisa: p.sellingPricePaisa,
          reorderLevelPackets: p.reorderLevelPackets,
        })),
      });
    } catch (err) {
      handleError(res, err);
    }
  });

  app.get('/api/stock-ledger', requireAuth, async (req, res) => {
    try {
      const movementType = typeof req.query.movementType === 'string' ? req.query.movementType : '';
      const itemType = typeof req.query.itemType === 'string' ? req.query.itemType : '';
      const entries = await db.select().from(stockLedger).orderBy(desc(stockLedger.id)).limit(300);

      const filtered = entries.filter((e) => {
        if (movementType && e.movementType !== movementType) return false;
        if (itemType && e.itemType !== itemType) return false;
        return true;
      });
      res.json(filtered);
    } catch (err) {
      handleError(res, err);
    }
  });

  app.post(
    '/api/inventory/adjustments',
    requireAuth,
    requireRole(['factory_admin', 'production_supervisor', 'owner']),
    async (req: AuthRequest, res: Response) => {
      try {
        const body = z
          .object({
            itemType: z.enum(['raw_material', 'packaging', 'finished_goods']),
            itemId: z.number().int().positive(),
            movementType: z.enum(['adjustment', 'wastage', 'return']),
            qtyDeltaMilli: z.number().int().refine((v) => v !== 0, 'Quantity cannot be zero'),
            remarks: z.string().min(3),
            allowNegative: z.boolean().optional(),
          })
          .parse(req.body);

        const result = await recordStockAdjustmentTransaction(req.user!, body);
        res.status(201).json(result);
      } catch (err) {
        handleError(res, err);
      }
    }
  );

  // ==================== PURCHASES ====================
  app.get('/api/purchases', requireAuth, async (_req, res) => {
    try {
      const allPurchases = await db.select().from(purchases).orderBy(desc(purchases.id));
      const allItems = await db.select().from(purchaseItems);
      const allSuppliers = await db.select().from(suppliers);
      const allMats = await db.select().from(rawMaterials);

      const supMap = new Map(allSuppliers.map((s) => [s.id, s]));
      const matMap = new Map(allMats.map((m) => [m.id, m]));

      res.json(
        allPurchases.map((p) => ({
          ...p,
          supplierName: supMap.get(p.supplierId)?.name ?? 'Supplier',
          items: allItems
            .filter((i) => i.purchaseId === p.id)
            .map((i) => ({
              ...i,
              materialName: matMap.get(i.materialId)?.name ?? 'Material',
              materialCode: matMap.get(i.materialId)?.code ?? '',
            })),
        }))
      );
    } catch (err) {
      handleError(res, err);
    }
  });

  app.post(
    '/api/purchases',
    requireAuth,
    requireRole(['production_supervisor', 'factory_admin', 'owner']),
    async (req: AuthRequest, res: Response) => {
      try {
        const body = z
          .object({
            supplierId: z.number().int().positive(),
            purchaseDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
            referenceNumber: z.string().min(1),
            notes: z.string().optional(),
            items: z
              .array(
                z.object({
                  materialId: z.number().int().positive(),
                  qtyMilli: z.number().int().positive(),
                  ratePaisa: z.number().int().min(0),
                })
              )
              .min(1),
          })
          .parse(req.body);

        const created = await createPurchaseTransaction(req.user!, body);
        res.status(201).json(created);
      } catch (err) {
        handleError(res, err);
      }
    }
  );

  // ==================== PRODUCTION RUNS ====================
  app.get('/api/production', requireAuth, async (_req, res) => {
    try {
      const runs = await db.select().from(productionRuns).orderBy(desc(productionRuns.id));
      const consumptions = await db.select().from(productionConsumptions);
      const prods = await db.select().from(products);
      const allBoms = await db.select().from(boms);
      const allMats = await db.select().from(rawMaterials);
      const allUsers = await db.select({ id: users.id, name: users.name }).from(users);

      const prodMap = new Map(prods.map((p) => [p.id, p]));
      const bomMap = new Map(allBoms.map((b) => [b.id, b]));
      const matMap = new Map(allMats.map((m) => [m.id, m]));
      const userMap = new Map(allUsers.map((u) => [u.id, u.name]));

      res.json(
        runs.map((r) => {
          const p = prodMap.get(r.productId);
          return {
            ...r,
            productName: p ? `${p.name} (${p.packSizeLabel})` : 'Product',
            sellingPricePaisa: p?.sellingPricePaisa ?? 0,
            bomName: bomMap.get(r.bomId)?.name ?? 'BOM',
            supervisorName: userMap.get(r.supervisorId) ?? 'Supervisor',
            consumptions: consumptions
              .filter((c) => c.productionRunId === r.id)
              .map((c) => ({
                ...c,
                materialName: matMap.get(c.materialId)?.name ?? 'Material',
                materialCode: matMap.get(c.materialId)?.code ?? '',
              })),
          };
        })
      );
    } catch (err) {
      handleError(res, err);
    }
  });

  app.post(
    '/api/production',
    requireAuth,
    requireRole(['production_supervisor', 'factory_admin', 'owner']),
    async (req: AuthRequest, res: Response) => {
      try {
        const body = z
          .object({
            productId: z.number().int().positive(),
            bomId: z.number().int().positive(),
            batchCount: z.number().int().positive(),
            actualGoodPackets: z.number().int().positive(),
            damagedPouches: z.number().int().min(0),
            cartonsUsed: z.number().int().min(0),
            labourCostPaisa: z.number().int().min(0),
            powerGasCostPaisa: z.number().int().min(0),
            startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
            completionDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
            notes: z.string().optional(),
            postImmediately: z.boolean().default(true),
            consumptions: z
              .array(
                z.object({
                  materialId: z.number().int().positive(),
                  actualQtyMilli: z.number().int().min(0),
                })
              )
              .min(1),
          })
          .parse(req.body);

        const run = await createAndOptionallyPostProductionRun(req.user!, body);
        res.status(201).json(run);
      } catch (err) {
        handleError(res, err);
      }
    }
  );

  app.post(
    '/api/production/:id/post',
    requireAuth,
    requireRole(['production_supervisor', 'factory_admin', 'owner']),
    async (req: AuthRequest, res: Response) => {
      try {
        const runId = Number(req.params.id);
        const posted = await postProductionRun(req.user!, runId);
        res.json(posted);
      } catch (err) {
        handleError(res, err);
      }
    }
  );

  // ==================== SALES ORDERS & DISPATCH ====================
  app.get('/api/sales-orders', requireAuth, async (req: AuthRequest, res: Response) => {
    try {
      const user = req.user!;
      const allOrders = await db.select().from(salesOrders).orderBy(desc(salesOrders.id));
      const allItems = await db.select().from(salesOrderItems);
      const allCustomers = await db.select().from(customers);
      const allProducts = await db.select().from(products);
      const allFg = await db.select().from(finishedGoodsStock);
      const allUsers = await db.select({ id: users.id, name: users.name }).from(users);
      const allInvoices = await db.select().from(gstInvoices);

      const custMap = new Map(allCustomers.map((c) => [c.id, c]));
      const prodMap = new Map(allProducts.map((p) => [p.id, p]));
      const fgMap = new Map(allFg.map((f) => [f.productId, f.currentQtyPackets]));
      const userMap = new Map(allUsers.map((u) => [u.id, u.name]));
      const invByOrder = new Map(allInvoices.map((i) => [i.orderId, i]));

      const visible =
        user.role === 'salesman'
          ? allOrders.filter((o) => o.salesmanId === user.id)
          : allOrders;

      res.json(
        visible.map((o) => {
          const cust = custMap.get(o.customerId);
          const inv = invByOrder.get(o.id);
          return {
            ...o,
            customerName: cust?.name ?? 'Customer',
            customerState: cust?.state ?? '',
            customerType: cust?.customerType ?? '',
            salesmanName: userMap.get(o.salesmanId) ?? 'Salesman',
            invoiceId: inv?.id ?? null,
            invoiceNumber: inv?.invoiceNumber ?? null,
            items: allItems
              .filter((i) => i.orderId === o.id)
              .map((i) => ({
                ...i,
                productName: prodMap.get(i.productId)?.name ?? 'Product',
                productCode: prodMap.get(i.productId)?.code ?? '',
                availablePackets: fgMap.get(i.productId) ?? 0,
              })),
          };
        })
      );
    } catch (err) {
      handleError(res, err);
    }
  });

  app.post(
    '/api/sales-orders',
    requireAuth,
    requireRole(['salesman', 'factory_admin', 'owner']),
    async (req: AuthRequest, res: Response) => {
      try {
        const body = z
          .object({
            customerId: z.number().int().positive(),
            orderDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
            status: z.enum(['draft', 'submitted']).default('submitted'),
            notes: z.string().optional(),
            items: z
              .array(
                z.object({
                  productId: z.number().int().positive(),
                  qtyPackets: z.number().int().positive(),
                })
              )
              .min(1),
          })
          .parse(req.body);

        const created = await createSalesOrderTransaction(req.user!, body);
        res.status(201).json(created);
      } catch (err) {
        handleError(res, err);
      }
    }
  );

  app.post(
    '/api/sales-orders/:id/review',
    requireAuth,
    requireRole(['factory_admin', 'owner']),
    async (req: AuthRequest, res: Response) => {
      try {
        const orderId = Number(req.params.id);
        const body = z
          .object({
            action: z.enum(['approve', 'reject', 'cancel', 'update']),
            rejectionReason: z.string().optional(),
            items: z
              .array(
                z.object({
                  productId: z.number().int().positive(),
                  qtyPackets: z.number().int().positive(),
                  unitPricePaisa: z.number().int().positive(),
                })
              )
              .optional(),
          })
          .parse(req.body);

        const updated = await reviewSalesOrderTransaction(req.user!, orderId, body);
        res.json(updated);
      } catch (err) {
        handleError(res, err);
      }
    }
  );

  app.post(
    '/api/dispatches/order/:orderId',
    requireAuth,
    requireRole(['factory_admin', 'owner']),
    async (req: AuthRequest, res: Response) => {
      try {
        const orderId = Number(req.params.orderId);
        const body = z
          .object({
            dispatchDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
            vehicleNo: z.string().optional(),
            transporter: z.string().optional(),
            remarks: z.string().optional(),
            items: z
              .array(
                z.object({
                  productId: z.number().int().positive(),
                  qtyPackets: z.number().int().positive(),
                })
              )
              .optional(),
          })
          .parse(req.body);

        const dispatch = await recordDispatchTransaction(req.user!, orderId, body);
        res.status(201).json(dispatch);
      } catch (err) {
        handleError(res, err);
      }
    }
  );

  app.get('/api/dispatches', requireAuth, async (_req, res) => {
    try {
      const list = await db.select().from(dispatches).orderBy(desc(dispatches.id));
      const items = await db.select().from(dispatchItems);
      const prods = await db.select().from(products);
      const prodMap = new Map(prods.map((p) => [p.id, p]));
      res.json(
        list.map((d) => ({
          ...d,
          items: items
            .filter((i) => i.dispatchId === d.id)
            .map((i) => ({
              ...i,
              productName: prodMap.get(i.productId)?.name ?? 'Product',
            })),
        }))
      );
    } catch (err) {
      handleError(res, err);
    }
  });

  // ==================== GST INVOICES ====================
  app.get('/api/invoices', requireAuth, async (req: AuthRequest, res: Response) => {
    try {
      const allInvoices = await db.select().from(gstInvoices).orderBy(desc(gstInvoices.id));
      const allItems = await db.select().from(gstInvoiceItems);
      const allCustomers = await db.select().from(customers);
      const allOrders = await db.select().from(salesOrders);
      const [settings] = await db.select().from(companySettings).limit(1);

      const custMap = new Map(allCustomers.map((c) => [c.id, c]));
      const orderMap = new Map(allOrders.map((o) => [o.id, o]));

      const visible =
        req.user!.role === 'salesman'
          ? allInvoices.filter((inv) => orderMap.get(inv.orderId)?.salesmanId === req.user!.id)
          : allInvoices;

      res.json(
        visible.map((inv) => ({
          ...inv,
          company: settings,
          customer: custMap.get(inv.customerId) ?? null,
          orderNumber: orderMap.get(inv.orderId)?.orderNumber ?? '',
          items: allItems.filter((i) => i.invoiceId === inv.id),
        }))
      );
    } catch (err) {
      handleError(res, err);
    }
  });

  app.post(
    '/api/invoices/from-order/:orderId',
    requireAuth,
    requireRole(['factory_admin', 'owner']),
    async (req: AuthRequest, res: Response) => {
      try {
        const orderId = Number(req.params.orderId);
        const body = z
          .object({
            invoiceDate: z
              .string()
              .regex(/^\d{4}-\d{2}-\d{2}$/)
              .default(new Date().toISOString().slice(0, 10)),
          })
          .parse(req.body ?? {});

        const inv = await generateGstInvoiceTransaction(req.user!, orderId, body.invoiceDate);
        res.status(201).json(inv);
      } catch (err) {
        handleError(res, err);
      }
    }
  );

  app.post(
    '/api/invoices/:id/reverse',
    requireAuth,
    requireRole(['factory_admin', 'owner']),
    async (req: AuthRequest, res: Response) => {
      try {
        const id = Number(req.params.id);
        const body = z.object({ reason: z.string().min(3) }).parse(req.body);
        const updated = await reverseGstInvoiceTransaction(req.user!, id, body.reason);
        res.json(updated);
      } catch (err) {
        handleError(res, err);
      }
    }
  );

  // ==================== PAYMENTS ====================
  app.get('/api/payments', requireAuth, async (_req, res) => {
    try {
      const allPayments = await db.select().from(payments).orderBy(desc(payments.id));
      const allInvoices = await db.select().from(gstInvoices);
      const allCustomers = await db.select().from(customers);

      const invMap = new Map(allInvoices.map((i) => [i.id, i]));
      const custMap = new Map(allCustomers.map((c) => [c.id, c]));

      const receivablesByCustomer = allCustomers.map((c) => {
        const custInvs = allInvoices.filter(
          (i) => i.customerId === c.id && i.status !== 'reversed'
        );
        const invoicedPaisa = custInvs.reduce((s, i) => s + i.totalAmountPaisa, 0);
        const paidPaisa = custInvs.reduce((s, i) => s + i.paidAmountPaisa, 0);
        const outstandingPaisa = custInvs.reduce((s, i) => s + i.outstandingPaisa, 0);
        return {
          customerId: c.id,
          customerName: c.name,
          customerType: c.customerType,
          state: c.state,
          invoicedPaisa,
          paidPaisa,
          outstandingPaisa,
          invoiceCount: custInvs.length,
        };
      });

      res.json({
        payments: allPayments.map((p) => ({
          ...p,
          invoiceNumber: invMap.get(p.invoiceId)?.invoiceNumber ?? '',
          customerName: custMap.get(p.customerId)?.name ?? '',
        })),
        receivablesByCustomer,
      });
    } catch (err) {
      handleError(res, err);
    }
  });

  app.post(
    '/api/payments',
    requireAuth,
    requireRole(['factory_admin', 'owner']),
    async (req: AuthRequest, res: Response) => {
      try {
        const body = z
          .object({
            invoiceId: z.number().int().positive(),
            paymentDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
            amountPaisa: z.number().int().positive(),
            paymentMode: z.enum(['bank_transfer', 'upi', 'cheque', 'cash']),
            referenceNo: z.string().optional(),
            remarks: z.string().optional(),
          })
          .parse(req.body);

        const created = await recordPaymentTransaction(req.user!, body);
        res.status(201).json(created);
      } catch (err) {
        handleError(res, err);
      }
    }
  );

  // ==================== COSTING ====================
  app.get('/api/costing', requireAuth, async (_req, res) => {
    try {
      const runs = await db
        .select()
        .from(productionRuns)
        .where(eq(productionRuns.status, 'posted'))
        .orderBy(desc(productionRuns.id));
      const consumptions = await db.select().from(productionConsumptions);
      const prods = await db.select().from(products);
      const mats = await db.select().from(rawMaterials);

      const prodMap = new Map(prods.map((p) => [p.id, p]));
      const matMap = new Map(mats.map((m) => [m.id, m]));

      res.json(
        runs.map((r) => {
          const prod = prodMap.get(r.productId);
          const costing = calculateProductionRunCosting({
            rawMaterialCostPaisa: r.rawMaterialCostPaisa,
            packagingCostPaisa: r.packagingCostPaisa,
            labourCostPaisa: r.labourCostPaisa,
            powerGasCostPaisa: r.powerGasCostPaisa,
            actualGoodPackets: r.actualGoodPackets,
            sellingPricePaisa: prod?.sellingPricePaisa ?? 0,
          });
          return {
            ...r,
            productName: prod ? `${prod.name} (${prod.packSizeLabel})` : 'Product',
            sellingPricePaisa: prod?.sellingPricePaisa ?? 0,
            profitPerPacketPaisa: costing.profitPerPacketPaisa,
            profitMarginBps: costing.profitMarginBps,
            breakdown: consumptions
              .filter((c) => c.productionRunId === r.id)
              .map((c) => ({
                ...c,
                materialName: matMap.get(c.materialId)?.name ?? 'Material',
              })),
          };
        })
      );
    } catch (err) {
      handleError(res, err);
    }
  });

  // ==================== REPORTS (ALL 14) ====================
  app.get('/api/reports/:type', requireAuth, async (req: AuthRequest, res: Response) => {
    try {
      const type = req.params.type;
      const from = typeof req.query.from === 'string' ? req.query.from : '2000-01-01';
      const to = typeof req.query.to === 'string' ? req.query.to : '2099-12-31';

      const allInvoices = await db.select().from(gstInvoices).orderBy(desc(gstInvoices.id));
      const allInvItems = await db.select().from(gstInvoiceItems);
      const allCustomers = await db.select().from(customers);
      const allProducts = await db.select().from(products);
      const allPurchases = await db.select().from(purchases).orderBy(desc(purchases.id));
      const allSuppliers = await db.select().from(suppliers);
      const allMats = await db.select().from(rawMaterials).orderBy(rawMaterials.id);
      const allFg = await db.select().from(finishedGoodsStock);
      const allLedger = await db.select().from(stockLedger).orderBy(desc(stockLedger.id));
      const allRuns = await db.select().from(productionRuns).orderBy(desc(productionRuns.id));
      const allConsumptions = await db.select().from(productionConsumptions);
      const allPayments = await db.select().from(payments).orderBy(desc(payments.id));

      const custMap = new Map(allCustomers.map((c) => [c.id, c]));
      const prodMap = new Map(allProducts.map((p) => [p.id, p]));
      const supMap = new Map(allSuppliers.map((s) => [s.id, s]));
      const matMap = new Map(allMats.map((m) => [m.id, m]));
      const fgMap = new Map(allFg.map((f) => [f.productId, f]));
      const invMap = new Map(allInvoices.map((i) => [i.id, i]));
      const runMap = new Map(allRuns.map((r) => [r.id, r]));

      const activeInvoices = allInvoices.filter(
        (i) => i.status !== 'reversed' && i.invoiceDate >= from && i.invoiceDate <= to
      );

      switch (type) {
        case 'sales-register': {
          res.json(
            activeInvoices.map((i) => ({
              invoiceNumber: i.invoiceNumber,
              invoiceDate: i.invoiceDate,
              customerName: custMap.get(i.customerId)?.name ?? '',
              state: i.placeOfSupply,
              supplyType: i.supplyType,
              taxableValuePaisa: i.taxableValuePaisa,
              cgstPaisa: i.cgstPaisa,
              sgstPaisa: i.sgstPaisa,
              igstPaisa: i.igstPaisa,
              totalAmountPaisa: i.totalAmountPaisa,
              paidAmountPaisa: i.paidAmountPaisa,
              outstandingPaisa: i.outstandingPaisa,
            }))
          );
          return;
        }
        case 'customer-wise-sales': {
          const map = new Map<number, { name: string; state: string; invoices: number; taxablePaisa: number; taxPaisa: number; totalPaisa: number }>();
          for (const i of activeInvoices) {
            const c = custMap.get(i.customerId);
            const cur = map.get(i.customerId) ?? {
              name: c?.name ?? '',
              state: c?.state ?? '',
              invoices: 0,
              taxablePaisa: 0,
              taxPaisa: 0,
              totalPaisa: 0,
            };
            cur.invoices += 1;
            cur.taxablePaisa += i.taxableValuePaisa;
            cur.taxPaisa += i.cgstPaisa + i.sgstPaisa + i.igstPaisa;
            cur.totalPaisa += i.totalAmountPaisa;
            map.set(i.customerId, cur);
          }
          res.json(Array.from(map.values()));
          return;
        }
        case 'product-wise-sales': {
          const validInvIds = new Set(activeInvoices.map((i) => i.id));
          const map = new Map<number, { productName: string; hsnCode: string; qtyPackets: number; taxablePaisa: number; totalPaisa: number }>();
          for (const line of allInvItems) {
            if (!validInvIds.has(line.invoiceId)) continue;
            const cur = map.get(line.productId) ?? {
              productName: line.productName,
              hsnCode: line.hsnCode,
              qtyPackets: 0,
              taxablePaisa: 0,
              totalPaisa: 0,
            };
            cur.qtyPackets += line.qtyPackets;
            cur.taxablePaisa += line.taxableValuePaisa;
            cur.totalPaisa += line.lineTotalPaisa;
            map.set(line.productId, cur);
          }
          res.json(Array.from(map.values()));
          return;
        }
        case 'gst-outward-summary': {
          res.json(
            activeInvoices.map((i) => ({
              invoiceNumber: i.invoiceNumber,
              invoiceDate: i.invoiceDate,
              customerName: custMap.get(i.customerId)?.name ?? '',
              customerGstin: custMap.get(i.customerId)?.gstin ?? 'Unregistered',
              placeOfSupply: i.placeOfSupply,
              supplyType: i.supplyType,
              taxableValuePaisa: i.taxableValuePaisa,
              cgstPaisa: i.cgstPaisa,
              sgstPaisa: i.sgstPaisa,
              igstPaisa: i.igstPaisa,
              totalTaxPaisa: i.cgstPaisa + i.sgstPaisa + i.igstPaisa,
              invoiceTotalPaisa: i.totalAmountPaisa,
            }))
          );
          return;
        }
        case 'purchase-register': {
          res.json(
            allPurchases
              .filter((p) => p.purchaseDate >= from && p.purchaseDate <= to)
              .map((p) => ({
                purchaseNumber: p.purchaseNumber,
                purchaseDate: p.purchaseDate,
                supplierName: supMap.get(p.supplierId)?.name ?? '',
                referenceNumber: p.referenceNumber,
                totalAmountPaisa: p.totalAmountPaisa,
              }))
          );
          return;
        }
        case 'raw-material-stock': {
          res.json(
            allMats.map((m) => ({
              code: m.code,
              name: m.name,
              category: m.category,
              unit: m.unit,
              currentQty: m.currentQtyMilli / MILLI_SCALE,
              reorderLevel: m.reorderLevelMilli / MILLI_SCALE,
              totalValuePaisa: m.totalValuePaisa,
              weightedAvgRateRupees:
                m.currentQtyMilli > 0
                  ? (m.totalValuePaisa / 100) / (m.currentQtyMilli / MILLI_SCALE)
                  : m.openingRatePaisa / 100,
              status: m.currentQtyMilli <= m.reorderLevelMilli ? 'Low Stock' : 'Healthy',
            }))
          );
          return;
        }
        case 'finished-goods-stock': {
          res.json(
            allProducts.map((p) => {
              const s = fgMap.get(p.id);
              const qty = s?.currentQtyPackets ?? 0;
              return {
                code: p.code,
                name: p.name,
                packSize: p.packSizeLabel,
                currentQtyPackets: qty,
                avgCostPaisa: s?.avgCostPaisa ?? 0,
                sellingPricePaisa: p.sellingPricePaisa,
                stockValuePaisa: qty * (s?.avgCostPaisa ?? 0),
              };
            })
          );
          return;
        }
        case 'stock-ledger': {
          res.json(
            allLedger.filter((l) => {
              const d = l.createdAt.toISOString().slice(0, 10);
              return d >= from && d <= to;
            })
          );
          return;
        }
        case 'production-report': {
          res.json(
            allRuns
              .filter((r) => r.completionDate >= from && r.completionDate <= to)
              .map((r) => ({
                runNumber: r.runNumber,
                completionDate: r.completionDate,
                productName: prodMap.get(r.productId)?.name ?? '',
                expectedOutputPackets: r.expectedOutputPackets,
                actualGoodPackets: r.actualGoodPackets,
                damagedPouches: r.damagedPouches,
                yieldVarianceBps: r.yieldVarianceBps,
                efficiencyBps: r.efficiencyBps,
                status: r.status,
              }))
          );
          return;
        }
        case 'consumption-variance': {
          const validRunIds = new Set(
            allRuns
              .filter((r) => r.completionDate >= from && r.completionDate <= to)
              .map((r) => r.id)
          );
          res.json(
            allConsumptions
              .filter((c) => validRunIds.has(c.productionRunId))
              .map((c) => ({
                runNumber: runMap.get(c.productionRunId)?.runNumber ?? '',
                materialName: matMap.get(c.materialId)?.name ?? '',
                unit: c.unit,
                plannedQty: c.plannedQtyMilli / MILLI_SCALE,
                actualQty: c.actualQtyMilli / MILLI_SCALE,
                varianceQty: c.varianceQtyMilli / MILLI_SCALE,
                varianceBps: c.varianceBps,
                totalCostPaisa: c.totalCostPaisa,
                hasAlert: c.hasAlert,
              }))
          );
          return;
        }
        case 'yield-wastage': {
          res.json(
            allRuns
              .filter((r) => r.completionDate >= from && r.completionDate <= to)
              .map((r) => ({
                runNumber: r.runNumber,
                productName: prodMap.get(r.productId)?.name ?? '',
                expectedOutputPackets: r.expectedOutputPackets,
                actualGoodPackets: r.actualGoodPackets,
                damagedPouches: r.damagedPouches,
                cartonsUsed: r.cartonsUsed,
                yieldVarianceBps: r.yieldVarianceBps,
                efficiencyBps: r.efficiencyBps,
              }))
          );
          return;
        }
        case 'production-costing': {
          res.json(
            allRuns
              .filter((r) => r.status === 'posted' && r.completionDate >= from && r.completionDate <= to)
              .map((r) => {
                const prod = prodMap.get(r.productId);
                return {
                  runNumber: r.runNumber,
                  productName: prod?.name ?? '',
                  actualGoodPackets: r.actualGoodPackets,
                  rawMaterialCostPaisa: r.rawMaterialCostPaisa,
                  packagingCostPaisa: r.packagingCostPaisa,
                  labourCostPaisa: r.labourCostPaisa,
                  powerGasCostPaisa: r.powerGasCostPaisa,
                  totalCostPaisa: r.totalCostPaisa,
                  costPerGoodPacketPaisa: r.costPerGoodPacketPaisa,
                  sellingPricePaisa: prod?.sellingPricePaisa ?? 0,
                };
              })
          );
          return;
        }
        case 'customer-payments': {
          res.json(
            allPayments
              .filter((p) => p.paymentDate >= from && p.paymentDate <= to)
              .map((p) => ({
                receiptNumber: p.receiptNumber,
                paymentDate: p.paymentDate,
                customerName: custMap.get(p.customerId)?.name ?? '',
                invoiceNumber: invMap.get(p.invoiceId)?.invoiceNumber ?? '',
                paymentMode: p.paymentMode,
                referenceNo: p.referenceNo ?? '',
                amountPaisa: p.amountPaisa,
              }))
          );
          return;
        }
        case 'outstanding-receivables': {
          const todayMs = Date.now();
          res.json(
            allInvoices
              .filter((i) => i.status !== 'reversed' && i.outstandingPaisa > 0)
              .map((i) => {
                const days = Math.max(
                  0,
                  Math.floor((todayMs - new Date(i.invoiceDate).getTime()) / (1000 * 60 * 60 * 24))
                );
                const bucket = days <= 30 ? '0-30 days' : days <= 60 ? '31-60 days' : '60+ days';
                return {
                  invoiceNumber: i.invoiceNumber,
                  invoiceDate: i.invoiceDate,
                  customerName: custMap.get(i.customerId)?.name ?? '',
                  totalAmountPaisa: i.totalAmountPaisa,
                  paidAmountPaisa: i.paidAmountPaisa,
                  outstandingPaisa: i.outstandingPaisa,
                  ageDays: days,
                  ageingBucket: bucket,
                };
              })
          );
          return;
        }
        default:
          res.status(404).json({ error: 'Unknown report type' });
      }
    } catch (err) {
      handleError(res, err);
    }
  });

  // ==================== AUDIT TRAIL ====================
  app.get(
    '/api/audit-logs',
    requireAuth,
    requireRole(['accountant_auditor', 'factory_admin', 'owner']),
    async (_req, res) => {
      try {
        const logs = await db.select().from(auditLogs).orderBy(desc(auditLogs.id)).limit(300);
        res.json(logs);
      } catch (err) {
        handleError(res, err);
      }
    }
  );

  // ==================== USER MANAGEMENT ====================
  app.get('/api/users', requireAuth, async (req: AuthRequest, res: Response) => {
    try {
      const list = await db
        .select({
          id: users.id,
          email: users.email,
          name: users.name,
          role: users.role,
          isActive: users.isActive,
          createdAt: users.createdAt,
        })
        .from(users)
        .orderBy(users.id);

      // Non-owners/admins only see basic salesman directory if needed
      if (!['owner', 'factory_admin', 'accountant_auditor'].includes(req.user!.role)) {
        res.json(list.filter((u) => u.role === 'salesman'));
        return;
      }
      res.json(list);
    } catch (err) {
      handleError(res, err);
    }
  });

  app.post(
    '/api/users',
    requireAuth,
    requireRole(['owner']),
    async (req: AuthRequest, res: Response) => {
      try {
        const body = z
          .object({
            email: z.string().email(),
            name: z.string().min(2),
            role: z.enum(ROLES),
            password: z.string().min(6),
          })
          .parse(req.body);

        const [created] = await db.transaction(async (tx) => {
          const rows = await tx
            .insert(users)
            .values({
              uid: `local-${Date.now()}`,
              email: body.email.toLowerCase().trim(),
              name: body.name,
              role: body.role,
              passwordHash: hashPassword(body.password),
              isActive: true,
            })
            .returning({
              id: users.id,
              email: users.email,
              name: users.name,
              role: users.role,
              isActive: users.isActive,
            });
          await recordAuditLog(tx, req.user!, 'CREATE_USER', 'user', rows[0].email, null, rows[0]);
          return rows;
        });

        res.status(201).json(created);
      } catch (err) {
        handleError(res, err);
      }
    }
  );

  app.patch(
    '/api/users/:id',
    requireAuth,
    requireRole(['owner']),
    async (req: AuthRequest, res: Response) => {
      try {
        const id = Number(req.params.id);
        const body = z
          .object({
            name: z.string().min(2).optional(),
            role: z.enum(ROLES).optional(),
            isActive: z.boolean().optional(),
          })
          .parse(req.body);

        const [prev] = await db.select().from(users).where(eq(users.id, id)).limit(1);
        if (!prev) {
          res.status(404).json({ error: 'User not found' });
          return;
        }
        const [updated] = await db.transaction(async (tx) => {
          const rows = await tx
            .update(users)
            .set(body)
            .where(eq(users.id, id))
            .returning({
              id: users.id,
              email: users.email,
              name: users.name,
              role: users.role,
              isActive: users.isActive,
            });
          await recordAuditLog(tx, req.user!, 'UPDATE_USER', 'user', prev.email, { role: prev.role, isActive: prev.isActive }, rows[0]);
          return rows;
        });
        res.json(updated);
      } catch (err) {
        handleError(res, err);
      }
    }
  );

  // ==================== SETTINGS & BENCHMARK CONTROLS ====================
  app.get('/api/settings', requireAuth, async (_req, res) => {
    try {
      const [settings] = await db.select().from(companySettings).limit(1);
      res.json(settings);
    } catch (err) {
      handleError(res, err);
    }
  });

  app.patch(
    '/api/settings',
    requireAuth,
    requireRole(['owner', 'factory_admin']),
    async (req: AuthRequest, res: Response) => {
      try {
        const body = z
          .object({
            companyName: z.string().min(2).optional(),
            legalName: z.string().min(2).optional(),
            gstin: z.string().min(5).optional(),
            address: z.string().min(5).optional(),
            phone: z.string().min(5).optional(),
            email: z.string().email().optional(),
            varianceAlertThresholdBps: z.number().int().min(50).max(5000).optional(),
          })
          .parse(req.body);

        const [existing] = await db.select().from(companySettings).limit(1);
        if (!existing) {
          res.status(404).json({ error: 'Settings not initialized' });
          return;
        }
        const [updated] = await db.transaction(async (tx) => {
          const rows = await tx
            .update(companySettings)
            .set({ ...body, updatedAt: new Date() })
            .where(eq(companySettings.id, existing.id))
            .returning();
          await recordAuditLog(tx, req.user!, 'UPDATE_SETTINGS', 'company_settings', existing.id, existing, rows[0]);
          return rows;
        });
        res.json(updated);
      } catch (err) {
        handleError(res, err);
      }
    }
  );

  app.post(
    '/api/settings/reset-opening',
    requireAuth,
    requireRole(['owner', 'factory_admin']),
    async (_req, res) => {
      try {
        await seedOpeningBenchmarkState(true);
        res.json({ message: 'Database reset to clean benchmark opening stock.' });
      } catch (err) {
        handleError(res, err);
      }
    }
  );

  app.post(
    '/api/settings/run-benchmark',
    requireAuth,
    requireRole(['owner', 'factory_admin']),
    async (_req, res) => {
      try {
        await runFullBenchmarkScenario();
        res.json({ message: 'Full 16-step benchmark scenario executed and verified.' });
      } catch (err) {
        handleError(res, err);
      }
    }
  );

  return app;
}

async function startServer() {
  const app = createApp();
  const isProd = process.env.NODE_ENV === 'production';

  if (!isProd) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(__dirname, 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  const PORT = Number(process.env.PORT || 3000);
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`SnackFlow ERP server listening on http://0.0.0.0:${PORT}`);
  });
}

// Only bind HTTP listener when executed as entrypoint (not when imported by Vitest)
const isDirectRun =
  process.argv[1] &&
  (process.argv[1].endsWith('server.ts') || process.argv[1].endsWith('server.js'));

if (isDirectRun) {
  startServer().catch((err) => {
    console.error('Failed to start server:', err);
    process.exit(1);
  });
}
