import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { getDbUrl, openDb } from './db';
import type pg from 'pg';

// Integration coverage for migration 074 (P0 item 2 — Product Costing):
//
//   product_cost_history table + track_product_cost_history trigger, and the
//   branch-scoped SECURITY DEFINER RPCs get_costing_overview,
//   get_product_costing_detail, get_cost_history, get_order_margin and
//   get_supplier_price_impact.
//
// Costing is product-only after the manufacturing removal: unit_cost comes
// from the inventory_batches weighted average (_product_wavg_cost) and the
// theoretical/actual cost from the product_components BOM (_product_bom_cost).
// recipe_items is always [] — the recipes subsystem is gone.
//
// Every RPC is branch-scoped: non-admins are locked to their own branch via
// is_pos_admin(), admins may pass NULL (all branches) or a specific branch.
//
// Runs inside a single BEGIN..ROLLBACK transaction — safe against a live DB.
//
//   Run:  SUPABASE_DB_URL=postgresql://postgres:postgres@127.0.0.1:55432/postgres npm run test:integration

const dbUrl = getDbUrl();
const skip = !dbUrl;

describe.skipIf(skip)('product costing RPCs (074)', () => {
  let client: pg.Client;
  const branchA = randomUUID();
  const branchB = randomUUID();
  const whId = randomUUID();
  const prodId = randomUUID();
  const prodNoBom = randomUUID();
  const compProd = randomUUID();
  const adminId = randomUUID();
  const managerId = randomUUID();
  const managerBId = randomUUID();
  const supplierA = randomUUID();
  let saleId = '';

  async function asUser<T>(userId: string, fn: () => Promise<T>): Promise<T> {
    await client.query(`SELECT set_config('app.user_id', $1, true)`, [userId]);
    await client.query(`SET LOCAL ROLE authenticated`);
    try {
      return await fn();
    } finally {
      await client.query('RESET ROLE').catch(() => {});
      await client.query('RESET app.user_id').catch(() => {});
    }
  }

  const rows = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> =>
    (await client.query(sql, params)).rows as T[];

  beforeAll(async () => {
    client = openDb(dbUrl!);
    await client.connect();
    await client.query('BEGIN');

    await client.query(`ALTER TABLE public.users DISABLE TRIGGER trg_users_role_guard`);

    const orgId = randomUUID();
    await client.query(`INSERT INTO public.organizations (id, name, slug) VALUES ($1, $2, $3)`, [orgId, 'PC Org', `pc-${randomUUID().slice(0, 8)}`]);
    await client.query(`INSERT INTO public.branches (id, name, organization_id) VALUES ($1, $2, $3), ($4, $5, $6)`, [branchA, 'Cost A', orgId, branchB, 'Cost B', orgId]);
    await client.query(`INSERT INTO public.warehouses (id, name, branch_id, is_active) VALUES ($1, $2, $3, true)`, [whId, 'Cost WH', branchA]);
    await client.query(`INSERT INTO public.products (id, name, branch_id, sale_price, cost_price, is_active) VALUES ($1, $2, $3, 100, 30, true), ($4, $5, $6, 80, 20, true), ($7, $8, $9, 20, 5, false)`, [prodId, 'Cost Product', branchA, prodNoBom, 'Cost NoBom', branchA, compProd, 'Cost Component', branchA]);
    await client.query(`INSERT INTO public.product_components (product_id, component_product_id, quantity) VALUES ($1, $2, 1)`, [prodId, compProd]);
    // compProd already carries a 10 @ 20 opening batch -> wavg 20; prodId a 5 @ 30 -> wavg 30.
    await client.query(`INSERT INTO public.inventory_batches (product_id, warehouse_id, branch_id, quantity, unit_cost, source_type) VALUES ($1, $2, $3, 10, 20, 'opening')`, [compProd, whId, branchA]);
    await client.query(`INSERT INTO public.inventory_batches (product_id, warehouse_id, branch_id, quantity, unit_cost, source_type) VALUES ($1, $2, $3, 5, 30, 'opening')`, [prodId, whId, branchA]);
    await client.query(`INSERT INTO public.suppliers (id, name, branch_id, balance) VALUES ($1, $2, $3, 0)`, [supplierA, 'Cost Supplier', branchA]);

    const mkUser = async (id: string, role: string, branch: string | null) => {
      const uname = `costu-${randomUUID().slice(0, 8)}`;
      await client.query(
        `INSERT INTO public.users (id, email, username, full_name, role, branch_id, is_active) VALUES ($1, $2, $3, $4, $5, $6, true)`,
        [id, `cost-${randomUUID()}@test.local`, uname, 'Cost User', role, branch],
      );
    };
    await mkUser(adminId, 'super_admin', null);
    await mkUser(managerId, 'branch_manager', branchA);
    await mkUser(managerBId, 'branch_manager', branchB);
    await client.query(`INSERT INTO public.organization_members (organization_id, user_id, membership_role, is_active) VALUES ($1, $2, 'owner', true), ($1, $3, 'member', true), ($1, $4, 'member', true)`, [orgId, adminId, managerId, managerBId]);
  });

  afterAll(async () => {
    if (client) {
      await client.query('ROLLBACK').catch(() => {});
      await client.end();
    }
  });

  it('get_costing_overview: BOM cost math (component wavg x qty), recipe leg is gone', async () => {
    const overview = await asUser(adminId, async () =>
      rows<{ product_id: string; actual_cost: string; theoretical_cost: string; unit_cost: string; sale_price: string; component_count: string; recipe_item_count: string }>(
        `SELECT product_id, actual_cost, theoretical_cost, unit_cost, sale_price, component_count, recipe_item_count FROM public.get_costing_overview(NULL) WHERE product_id = $1`, [prodId],
      ),
    );
    expect(overview.length).toBe(1);
    expect(Number(overview[0].unit_cost)).toBe(30); // product's own batch wavg
    expect(Number(overview[0].actual_cost)).toBe(20); // 1 x component wavg
    expect(Number(overview[0].theoretical_cost)).toBe(20);
    expect(Number(overview[0].sale_price)).toBe(100);
    expect(Number(overview[0].component_count)).toBe(1);
    expect(Number(overview[0].recipe_item_count)).toBe(0);

    // Product without a BOM has zero component cost and a 0 component count.
    const noBom = await asUser(adminId, async () =>
      rows<{ product_id: string; actual_cost: string; component_count: string }>(
        `SELECT product_id, actual_cost, component_count FROM public.get_costing_overview(NULL) WHERE product_id = $1`, [prodNoBom],
      ),
    );
    expect(Number(noBom[0].actual_cost)).toBe(0);
    expect(Number(noBom[0].component_count)).toBe(0);
  });

  it('_product_wavg_cost returns the batch weighted average (0 with no batches)', async () => {
    const wavg = await client.query<{ wavg: string }>(
      `SELECT round(public._product_wavg_cost($1, $2), 2) AS wavg`, [compProd, branchA],
    );
    expect(Number(wavg.rows[0].wavg)).toBe(20); // from the seeded opening batch

    // A product with no batches has no weighted-average cost.
    const noBatches = await client.query<{ wavg: string }>(
      `SELECT round(public._product_wavg_cost($1, $2), 2) AS wavg`, [prodNoBom, branchA],
    );
    expect(Number(noBatches.rows[0].wavg)).toBe(0);
  });

  it('get_costing_overview: branch isolation for non-admins', async () => {
    // Branch A manager sees only branch-A products even with p_branch_id = NULL.
    const inBranch = await asUser(managerId, async () =>
      rows<{ product_id: string }>(`SELECT product_id FROM public.get_costing_overview(NULL)`),
    );
    expect(inBranch.some((r) => r.product_id === prodId)).toBe(true);
    expect(inBranch.length).toBe(2); // both active seeded products live in branch A

    // Branch B manager sees neither product.
    const outBranch = await asUser(managerBId, async () =>
      rows<{ product_id: string }>(`SELECT product_id FROM public.get_costing_overview(NULL)`),
    );
    expect(outBranch.length).toBe(0);

    // Admin may scope to a specific branch (none of the products are in B).
    const adminB = await asUser(adminId, async () =>
      rows<{ product_id: string }>(`SELECT product_id FROM public.get_costing_overview($1)`, [branchB]),
    );
    expect(adminB.length).toBe(0);
  });

  it('get_product_costing_detail: component lines, batch-cost and error on missing product', async () => {
    const detail = await asUser(managerId, async () =>
      rows<{ r: { success: boolean; product_name: string; actual_cost: number; components: Array<{ component_name: string; unit_cost: number; line_cost: number }>; recipe_items: unknown[] } }>(
        `SELECT public.get_product_costing_detail($1, NULL) AS r`, [prodId],
      ),
    );
    expect(detail[0].r.success).toBe(true);
    expect(detail[0].r.product_name).toBe('Cost Product');
    expect(Number(detail[0].r.actual_cost)).toBe(20);
    expect(detail[0].r.components.length).toBe(1);
    expect(detail[0].r.components[0].component_name).toBe('Cost Component');
    expect(Number(detail[0].r.components[0].unit_cost)).toBe(20);
    expect(Number(detail[0].r.components[0].line_cost)).toBe(20);
    expect(detail[0].r.recipe_items).toHaveLength(0);

    const missing = await asUser(managerId, async () =>
      rows<{ r: { success: boolean; error: string } }>(
        `SELECT public.get_product_costing_detail($1, NULL) AS r`, [randomUUID()],
      ),
    );
    expect(missing[0].r.success).toBe(false);
    expect(missing[0].r.error).toBe('PRODUCT_NOT_FOUND');
  });

  it('track_product_cost_history trigger records cost changes; get_cost_history returns them', async () => {
    await client.query(`UPDATE public.products SET cost_price = 45 WHERE id = $1`, [prodId]);

    const history = await asUser(adminId, async () =>
      rows<{ old_cost: string; new_cost: string; source: string }>(
        `SELECT old_cost, new_cost, source FROM public.get_cost_history($1, 50)`, [prodId],
      ),
    );
    expect(history.length).toBeGreaterThan(0);
    expect(Number(history[0].old_cost)).toBe(30);
    expect(Number(history[0].new_cost)).toBe(45);
    expect(history[0].source).toBe('auto');

    const table = await client.query<{ c: string }>(
      `SELECT COUNT(*)::text AS c FROM public.product_cost_history WHERE product_id = $1`, [prodId],
    );
    expect(Number(table.rows[0].c)).toBe(1);
  });

  it('get_order_margin: COGS from the inventory ledger sale rows', async () => {
    const sale = await client.query<{ id: string }>(
      `INSERT INTO public.sales (id, invoice_number, branch_id, warehouse_id, subtotal, discount_amount, tax_amount, total, paid_amount, payment_method, status)
       VALUES ($1, 'COSTINV', $2, $3, 0, 0, 0, 200, 200, 'cash', 'completed') RETURNING id`,
      [randomUUID(), branchA, whId],
    );
    saleId = sale.rows[0].id;
    await client.query(
      `INSERT INTO public.inventory_ledger (product_id, branch_id, warehouse_id, quantity, unit_cost, total_cost, entry_type, reference_type, reference_id, reference_number)
       VALUES ($1, $2, $3, -2, 25, -50, 'sale', 'sale', $4, 'COSTINV')`,
      [prodId, branchA, whId, saleId],
    );

    const margins = await asUser(adminId, async () =>
      rows<{ sale_id: string; invoice_number: string; total: string; cogs: string; gross_margin: string }>(
        `SELECT sale_id, invoice_number, total, cogs, gross_margin FROM public.get_order_margin($1, NULL, NULL) WHERE sale_id = $2`, [branchA, saleId],
      ),
    );
    expect(margins.length).toBe(1);
    expect(Number(margins[0].total)).toBe(200);
    expect(Number(margins[0].cogs)).toBe(50);
    expect(Number(margins[0].gross_margin)).toBe(150);

    // Branch B manager cannot see branch A's order.
    const out = await asUser(managerBId, async () =>
      rows<{ sale_id: string }>(`SELECT sale_id FROM public.get_order_margin(NULL, NULL, NULL) WHERE sale_id = $1`, [saleId]),
    );
    expect(out.length).toBe(0);
  });

  it('get_supplier_price_impact returns product price history for the branch', async () => {
    await client.query(
      `INSERT INTO public.purchases (id, invoice_number, supplier_id, branch_id, warehouse_id, subtotal, discount_amount, tax_amount, total, paid_amount, payment_method, status)
       VALUES ($1, 'COSTPO', $2, $3, $4, 0, 0, 0, 0, 0, 'cash', 'completed')`,
      [randomUUID(), supplierA, branchA, whId],
    );
    const purch = await client.query<{ id: string }>(
      `SELECT id FROM public.purchases WHERE supplier_id = $1 AND branch_id = $2 ORDER BY created_at DESC LIMIT 1`, [supplierA, branchA],
    );
    await client.query(
      `INSERT INTO public.purchase_items (purchase_id, product_id, unit_name, quantity, unit_cost, total)
       VALUES ($1, $2, 'piece', 5, 18, 90)`,
      [purch.rows[0].id, prodId],
    );

    const impact = await asUser(managerId, async () =>
      rows<{ item_id: string; item_type: string; first_cost: string; last_cost: string; avg_cost: string; purchase_count: string }>(
        `SELECT item_id, item_type, first_cost, last_cost, avg_cost, purchase_count FROM public.get_supplier_price_impact($1) WHERE item_id = $2`, [supplierA, prodId],
      ),
    );
    expect(impact.length).toBe(1);
    expect(impact[0].item_type).toBe('product');
    expect(Number(impact[0].first_cost)).toBe(18);
    expect(Number(impact[0].last_cost)).toBe(18);
    expect(Number(impact[0].avg_cost)).toBe(18);
    expect(Number(impact[0].purchase_count)).toBe(1);
  });
});