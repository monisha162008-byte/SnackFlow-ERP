# SnackFlow ERP — System Design Note

**Project:** Smart Manufacturing & Audit Management System (NIT Tiruchirappalli — CDI Internship)

---

## 1. Entity-Relationship Data Model

```
+--------------+       +------------------+       +--------------------+
|    users     |1-----*|   sales_orders   |*-----1|     customers      |
+--------------+       +------------------+       +--------------------+
| id, uid,     |       | id, order_number |       | id, code, name     |
| email, role, |       | customer_id,     |       | customer_type      |
| password_hash|       | salesman_id,     |       | state, gstin       |
+--------------+       | status, totals   |       | assigned_salesman  |
       |               +------------------+       +--------------------+
       |                  |1         |1
       |                  |          |1
       |                  |*         v
       |          +---------------+  +----------------+     +------------+
       |          |  dispatches   |  |  gst_invoices  |1---*|  payments  |
       |          +---------------+  +----------------+     +------------+
       |                                     |
       v                                     |1
+--------------+                             v
|  audit_logs  |                     +-------------------+
+--------------+                     | gst_invoice_items |
                                     +-------------------+

+--------------+       +------------------+       +--------------------+
|   suppliers  |1-----*|    purchases     |1-----*|   purchase_items   |
+--------------+       +------------------+       +--------------------+
                                                            |
                                                            |*
+--------------+       +------------------+       +--------------------+
|     boms     |1-----*|    bom_items     |*-----1|   raw_materials    |
+--------------+       +------------------+       +--------------------+
       |                                                    ^
       |1                                                   |*
       v                                          +-----------------------+
+--------------+       +------------------+       | production_consumptions|
|   products   |1-----*| production_runs  |1-----*|-----------------------+
+--------------+       +------------------+
       |1
       |----1 [ finished_goods_stock ]
       |----* [ stock_ledger ] <-------* [ raw_materials ]
```

---

## 2. Immutable Stock Ledger & Transactional Integrity

1. **Separated Pools:** Raw materials (`category = 'raw_material'`), packaging (`category = 'packaging'`), and finished goods (`finished_goods_stock`) are tracked separately.
2. **Append-Only Ledger:** Every physical quantity change writes an immutable row into `stock_ledger` containing `item_type`, `qty_delta_milli`, `balance_after_milli`, `unit_cost_paisa`, `total_value_paisa`, `movement_type` (`opening_stock`, `purchase_receipt`, `production_issue`, `production_receipt`, `dispatch`, `wastage`, `adjustment`, `return`), `source_doc_type`, `source_doc_id`, `user_id`, and `remarks`.
3. **Zero Direct Overwrite:** No API endpoint allows overwriting stock counts directly. Manual corrections require `/api/inventory/adjustments` with mandatory audit remarks.
4. **Atomic ACID Postings:** Every purchase, production post, dispatch, and stock adjustment runs inside a single PostgreSQL `db.transaction`. Negative stock is rejected unless an explicitly authorized admin adjustment permits it.
5. **Duplicate Prevention:**
   - Production posting performs an atomic conditional update `WHERE id = $1 AND status = 'draft'` returning `409 Conflict` if already posted.
   - `gst_invoices.order_id` has a database `UNIQUE` constraint preventing double billing.
   - Dispatches validate `qtyToDispatch <= (ordered - alreadyDispatched)` inside the transaction.

---

## 3. BOM Consumption, Unit Conversions & Pack-Variant Scaling

- **Exact Integer Milli-Units:** Quantities are stored in milli-units (`1 kg = 1,000 g`, `1 litre = 1,000 ml`, `1 piece = 1,000 milli-pieces`) to eliminate floating-point rounding drift.
- **Shared BOM Across Variants:** A `boms` master defines `base_pack_grams` (e.g., `200g`) and `expected_yield_packets` (`200`). Each `bom_items` line declares a `scaling_rule`:
  - `proportional_to_weight`: Scales raw ingredients by `(product.packSizeGrams / bom.basePackGrams)`. Thus a **500g** Murukku pack sharing the **200g** BOM automatically scales flour (`40 kg → 100 kg`), oil (`10 L → 25 L`), and spice (`1.2 kg → 3.0 kg`) by `2.5x`.
  - `per_packet`: Scales 1:1 with target packet count (`pouches`).
  - `per_carton`: Scales by `ceil(plannedPackets / product.packetsPerCarton)`.
- **Variance Monitoring:** Planned vs. actual variance (`((actual - planned) / planned) * 10000` bps) and yield variance trigger automatic alerts whenever `|variance| > 300 bps` (`±3.0%`).

---

## 4. Weighted-Average Costing Method

1. **Running Stock Valuation:** Each `raw_materials` record maintains `current_qty_milli` and `total_value_paisa`.
2. **Purchase Receipt:** Receiving `Q_in` at rate `R` adds `Q_in` to `current_qty_milli` and `(Q_in * R) / 1000` to `total_value_paisa`.
3. **Production Issue:** Issuing `Q_out` computes exact issue cost using integer division:
   $$\text{Issue Cost (paisa)} = \text{round}\left(\frac{Q_{\text{out}} \times \text{Total Value}}{\text{Current Qty}}\right)$$
   For the benchmark: `(100 × ₹42 + 60 × ₹45) / 160 = ₹43.125/kg`, so `40 kg` issues at exactly `₹1,725.00`.
4. **Full Absorption & Unit Cost:** Total run cost sums actual raw materials (`₹3,435`), actual packaging including damaged pouches (`₹620`), labour (`₹1,200`), and power/gas (`₹600`) = `₹5,855`. Dividing by `188` good packets yields `₹31.14 / good packet`.
