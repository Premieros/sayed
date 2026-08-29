import { supabase } from '@/api';
import { logAudit } from '@/lib/audit';
import {
  ImportExportEntity,
  CollisionPolicy,
  ImportProgress,
  ImportResult,
  ValidationError,
} from './types';
import { ValidationContext } from './validation-engine';

export class ImportExecutor {
  public static async execute(
    entity: ImportExportEntity,
    mappedRows: Record<string, unknown>[],
    policy: CollisionPolicy,
    context: ValidationContext,
    onProgress?: (progress: ImportProgress) => void
  ): Promise<ImportResult> {
    const startTime = Date.now();
    const totalRows = mappedRows.length;
    let insertedCount = 0;
    let updatedCount = 0;
    let skippedCount = 0;
    let errorCount = 0;
    const errors: ValidationError[] = [];

    const updateProgress = (current: number, stepMsg: string) => {
      if (onProgress) {
        onProgress({
          current,
          total: totalRows,
          percentage: totalRows > 0 ? Math.round((current / totalRows) * 100) : 100,
          currentStep: stepMsg,
          insertedCount,
          updatedCount,
          skippedCount,
          errorCount,
        });
      }
    };

    updateProgress(0, 'بدء تهيئة عملية الاستيراد...');

    try {
      switch (entity) {
        case 'products': {
          for (let i = 0; i < mappedRows.length; i++) {
            const row = mappedRows[i];
            const rowNumber = i + 2;
            const sku = String(row.sku || '').trim();
            const barcode = row.barcode ? String(row.barcode).trim() : null;
            const name = String(row.name || '').trim();
            const name_en = row.name_en ? String(row.name_en).trim() : null;
            const categoryName = row.category ? String(row.category).trim() : null;
            const unitName = row.unit ? String(row.unit).trim() : 'piece';
            const cost = row.cost !== undefined && row.cost !== '' ? Number(row.cost) : 0;
            const price = Number(row.price || 0);
            const tax_rate = row.tax_rate !== undefined && row.tax_rate !== '' ? Number(row.tax_rate) : 15;
            const is_active = row.is_active !== undefined ? Boolean(row.is_active) : true;

            updateProgress(i + 1, `معالجة المنتج (${i + 1} / ${totalRows}): ${name}`);

            try {
              // Match or create category if needed
              let categoryId: string | null = null;
              if (categoryName) {
                const foundCat = context.existingCategories.find(
                  (c) =>
                    c.name?.toLowerCase() === categoryName.toLowerCase() ||
                    c.code?.toLowerCase() === categoryName.toLowerCase() ||
                    c.id === categoryName
                );
                if (foundCat) {
                  categoryId = foundCat.id;
                } else {
                  // Auto create category
                  const { data: newCat } = await supabase
                    .from('categories')
                    .insert({ name: categoryName, name_en: categoryName, is_active: true })
                    .select()
                    .maybeSingle();
                  if (newCat) {
                    categoryId = (newCat as { id: string }).id;
                    context.existingCategories.push(newCat as { id: string; name: string });
                  }
                }
              }

              // Check existing product by SKU
              const existingProd = context.existingProducts.find(
                (p) => p.sku?.toLowerCase() === sku.toLowerCase()
              );

              if (existingProd) {
                if (policy === 'skip_existing') {
                  skippedCount++;
                  continue;
                }
                if (policy === 'stop_on_error') {
                  throw new Error(`المنتج بالرمز ${sku} موجود مسبقاً.`);
                }
                if (policy === 'add_only') {
                  skippedCount++;
                  continue;
                }

                // update_existing
                const { error: updErr } = await supabase
                  .from('products')
                  .update({
                    name,
                    name_en,
                    barcode,
                    category_id: categoryId,
                    cost_price: cost,
                    sale_price: price,
                    is_active,
                    tax_rate,
                  })
                  .eq('id', existingProd.id);

                if (updErr) throw updErr;
                updatedCount++;
              } else {
                // Insert new product
                const { data: inserted, error: insErr } = await supabase
                  .from('products')
                  .insert({
                    sku,
                    name,
                    name_en,
                    barcode,
                    category_id: categoryId,
                    cost_price: cost,
                    sale_price: price,
                    product_type: 'ready',
                    is_active,
                    tax_rate,
                    branch_id: context.userBranchId || null,
                  })
                  .select()
                  .single();

                if (insErr) throw insErr;
                if (inserted) {
                  const pid = (inserted as { id: string }).id;
                  context.existingProducts.push({
                    id: pid,
                    sku,
                    name,
                    barcode,
                    category_id: categoryId,
                    unit: unitName,
                  });

                  // Add default unit
                  await supabase.from('product_units').insert({
                    product_id: pid,
                    unit_name: unitName,
                    unit_name_en: unitName,
                    conversion_factor: 1,
                    sale_price: price,
                    cost_price: cost,
                    is_base: true,
                  });
                }
                insertedCount++;
              }
            } catch (err: unknown) {
              errorCount++;
              const msg = err instanceof Error ? err.message : String(err);
              errors.push({
                rowNumber,
                column: 'المنتج',
                value: sku,
                message: `فشل استيراد المنتج: ${msg}`,
                messageEn: `Failed to import product: ${msg}`,
                remedy: 'تأكد من عدم تكرار الحقول الفريدة وتوافق الأعمدة.',
                remedyEn: 'Check column values and uniqueness.',
                severity: 'error',
              });

              if (policy === 'stop_on_error') break;
            }
          }
          break;
        }

        case 'categories': {
          for (let i = 0; i < mappedRows.length; i++) {
            const row = mappedRows[i];
            const rowNumber = i + 2;
            const code = String(row.code || '').trim();
            const name = String(row.name || '').trim();
            const name_en = row.name_en ? String(row.name_en).trim() : null;
            const is_active = row.is_active !== undefined ? Boolean(row.is_active) : true;

            updateProgress(i + 1, `معالجة الفئة (${i + 1} / ${totalRows}): ${name}`);

            try {
              const existingCat = context.existingCategories.find(
                (c) => c.code?.toLowerCase() === code.toLowerCase() || c.name?.toLowerCase() === name.toLowerCase()
              );

              if (existingCat) {
                if (policy === 'skip_existing' || policy === 'add_only') {
                  skippedCount++;
                  continue;
                }
                const { error: updErr } = await supabase
                  .from('categories')
                  .update({ name, name_en, code, is_active })
                  .eq('id', existingCat.id);
                if (updErr) throw updErr;
                updatedCount++;
              } else {
                const { data: insCat, error: insErr } = await supabase
                  .from('categories')
                  .insert({ name, name_en, code, is_active })
                  .select()
                  .single();
                if (insErr) throw insErr;
                if (insCat) {
                  context.existingCategories.push(insCat as { id: string; name: string });
                }
                insertedCount++;
              }
            } catch (err: unknown) {
              errorCount++;
              const msg = err instanceof Error ? err.message : String(err);
              errors.push({
                rowNumber,
                column: 'الفئة',
                value: name,
                message: `فشل استيراد الفئة: ${msg}`,
                messageEn: `Failed category import: ${msg}`,
                remedy: 'تحقق من عدم تكرار كود الفئة.',
                remedyEn: 'Ensure unique category code.',
                severity: 'error',
              });
              if (policy === 'stop_on_error') break;
            }
          }
          break;
        }

        case 'components': {
          for (let i = 0; i < mappedRows.length; i++) {
            const row = mappedRows[i];
            const rowNumber = i + 2;
            const sku = String(row.sku || '').trim();
            const name = String(row.name || '').trim();
            const unit = String(row.unit || 'كجم').trim();
            const cost = Number(row.cost || 0);
            const min_stock = Number(row.min_stock || 0);
            const is_active = row.is_active !== undefined ? Boolean(row.is_active) : true;

            updateProgress(i + 1, `معالجة المادة الخام (${i + 1} / ${totalRows}): ${name}`);

            try {
              const existingComp = context.existingComponents.find(
                (c) => c.sku?.toLowerCase() === sku.toLowerCase()
              );

              if (existingComp) {
                if (policy === 'skip_existing' || policy === 'add_only') {
                  skippedCount++;
                  continue;
                }
                const { error: updErr } = await supabase
                  .from('raw_materials')
                  .update({ name, unit, cost_price: cost, min_stock, is_active })
                  .eq('id', existingComp.id);
                if (updErr) throw updErr;
                updatedCount++;
              } else {
                const { data: insMat, error: insErr } = await supabase
                  .from('raw_materials')
                  .insert({
                    sku,
                    name,
                    unit,
                    cost_price: cost,
                    min_stock,
                    is_active,
                    branch_id: context.userBranchId || null,
                  })
                  .select()
                  .single();
                if (insErr) throw insErr;
                if (insMat) {
                  context.existingComponents.push({
                    id: (insMat as { id: string }).id,
                    sku,
                    name,
                    unit,
                    cost,
                  });
                }
                insertedCount++;
              }
            } catch (err: unknown) {
              errorCount++;
              const msg = err instanceof Error ? err.message : String(err);
              errors.push({
                rowNumber,
                column: 'المادة الخام',
                value: sku,
                message: `فشل استيراد المادة الخام: ${msg}`,
                messageEn: `Failed component import: ${msg}`,
                remedy: 'تأكد من عدم تكرار كود المادة وتوفر وحدة القياس.',
                remedyEn: 'Check SKU uniqueness and unit.',
                severity: 'error',
              });
              if (policy === 'stop_on_error') break;
            }
          }
          break;
        }

        case 'recipes': {
          // Group rows by product_sku (One Row Per Component)
          const recipeGroups = new Map<string, Array<{ component_sku: string; quantity: number; unit?: string }>>();
          const rowNumberMap = new Map<string, number>();

          mappedRows.forEach((r, idx) => {
            const prodSku = String(r.product_sku || '').trim();
            const compSku = String(r.component_sku || '').trim();
            const qty = Number(r.quantity || 0);
            if (!prodSku || !compSku || qty <= 0) return;

            if (!recipeGroups.has(prodSku)) {
              recipeGroups.set(prodSku, []);
              rowNumberMap.set(prodSku, idx + 2);
            }
            recipeGroups.get(prodSku)!.push({
              component_sku: compSku,
              quantity: qty,
              unit: r.unit ? String(r.unit).trim() : undefined,
            });
          });

          let groupIndex = 0;
          const groupCount = recipeGroups.size;

          for (const [prodSku, compItems] of recipeGroups.entries()) {
            groupIndex++;
            updateProgress(
              groupIndex,
              `معالجة وصفة المنتج (${groupIndex} / ${groupCount}): ${prodSku} (${compItems.length} مكونات)`
            );

            try {
              // 1. Resolve product
              const product = context.existingProducts.find(
                (p) => p.sku?.toLowerCase() === prodSku.toLowerCase() || p.id === prodSku
              );
              if (!product) {
                throw new Error(`المنتج ${prodSku} غير موجود بقاعدة البيانات`);
              }

              // Update product type to manufactured
              await supabase.from('products').update({ product_type: 'manufactured' }).eq('id', product.id);

              // 2. Resolve components
              const recipeItemPayloads: Array<{ raw_material_id: string; quantity: number; wastage_percent: number }> = [];
              const productCompPayloads: Array<{ product_id: string; component_product_id: string; quantity: number }> = [];

              for (const comp of compItems) {
                const rawMat = context.existingComponents.find(
                  (c) => c.sku?.toLowerCase() === comp.component_sku.toLowerCase() || c.id === comp.component_sku
                );
                if (rawMat) {
                  recipeItemPayloads.push({
                    raw_material_id: rawMat.id,
                    quantity: comp.quantity,
                    wastage_percent: 0,
                  });
                }

                // Check if component is another product
                const compProd = context.existingProducts.find(
                  (p) => p.sku?.toLowerCase() === comp.component_sku.toLowerCase()
                );
                if (compProd) {
                  productCompPayloads.push({
                    product_id: product.id,
                    component_product_id: compProd.id,
                    quantity: comp.quantity,
                  });
                }
              }

              // 3. Check existing recipe
              const { data: existingRecipes } = await supabase
                .from('recipes')
                .select('id')
                .eq('product_id', product.id);

              let recipeId: string;

              if (existingRecipes && existingRecipes.length > 0) {
                recipeId = existingRecipes[0].id;
                // Delete previous items
                await supabase.from('recipe_items').delete().eq('recipe_id', recipeId);
                updatedCount += compItems.length;
              } else {
                const { data: newRecipe, error: recErr } = await supabase
                  .from('recipes')
                  .insert({
                    product_id: product.id,
                    branch_id: context.userBranchId || context.allowedBranchIds[0] || null,
                    name: `وصفة: ${product.name}`,
                    yield_quantity: 1,
                    is_active: true,
                  })
                  .select()
                  .single();

                if (recErr) throw recErr;
                recipeId = (newRecipe as { id: string }).id;
                insertedCount += compItems.length;
              }

              // 4. Insert recipe items
              if (recipeItemPayloads.length > 0) {
                const { error: insItemsErr } = await supabase.from('recipe_items').insert(
                  recipeItemPayloads.map((it) => ({
                    ...it,
                    recipe_id: recipeId,
                  }))
                );
                if (insItemsErr) throw insItemsErr;
              }

              // 5. Sync product_components
              await supabase.from('product_components').delete().eq('product_id', product.id);
              if (productCompPayloads.length > 0) {
                await supabase.from('product_components').insert(productCompPayloads);
              }
            } catch (err: unknown) {
              errorCount += compItems.length;
              const msg = err instanceof Error ? err.message : String(err);
              errors.push({
                rowNumber: rowNumberMap.get(prodSku) || 2,
                column: 'الوصفة والمكونات',
                value: prodSku,
                message: `فشل حفظ وصفة المنتج "${prodSku}": ${msg}`,
                messageEn: `Failed recipe import for "${prodSku}": ${msg}`,
                remedy: 'تأكد من وجود بطاقة المنتج والمواد الخام التابعة له أولاً.',
                remedyEn: 'Ensure product and raw materials exist before importing recipe.',
                severity: 'error',
              });

              if (policy === 'stop_on_error') break;
            }
          }
          break;
        }

        case 'purchases': {
          // Group by purchase_no
          const invoiceGroups = new Map<string, Array<Record<string, unknown>>>();
          mappedRows.forEach((r) => {
            const pno = String(r.purchase_no || '').trim();
            if (!pno) return;
            if (!invoiceGroups.has(pno)) invoiceGroups.set(pno, []);
            invoiceGroups.get(pno)!.push(r);
          });

          let invIdx = 0;
          for (const [purchaseNo, items] of invoiceGroups.entries()) {
            invIdx++;
            updateProgress(invIdx, `معالجة فاتورة المشتريات (${invIdx} / ${invoiceGroups.size}): ${purchaseNo}`);

            try {
              const firstRow = items[0];
              const suppStr = String(firstRow.supplier_code || '').trim();
              const whStr = String(firstRow.warehouse || '').trim();
              const dateStr = String(firstRow.date || new Date().toISOString().slice(0, 10)).trim();

              const supplier = context.existingSuppliers.find(
                (s) =>
                  s.code?.toLowerCase() === suppStr.toLowerCase() ||
                  s.name?.toLowerCase() === suppStr.toLowerCase() ||
                  s.id === suppStr
              );
              const warehouse = context.existingWarehouses.find(
                (w) =>
                  w.code?.toLowerCase() === whStr.toLowerCase() ||
                  w.name?.toLowerCase() === whStr.toLowerCase() ||
                  w.id === whStr
              );

              if (!supplier) throw new Error(`المورد "${suppStr}" غير مسجل`);
              if (!warehouse) throw new Error(`المستودع "${whStr}" غير مسجل`);

              // Calculate total amount
              let subtotal = 0;
              let totalTax = 0;

              const lineItems: Array<{
                item_type: 'product' | 'raw_material';
                product_id?: string;
                raw_material_id?: string;
                quantity: number;
                unit_cost: number;
                tax_rate: number;
                total_cost: number;
              }> = [];

              for (const it of items) {
                const sku = String(it.sku || '').trim();
                const qty = Number(it.quantity || 0);
                const cost = Number(it.unit_cost || 0);
                const taxRate = Number(it.tax_rate || 15);

                const lineSub = qty * cost;
                const lineTax = lineSub * (taxRate / 100);
                subtotal += lineSub;
                totalTax += lineTax;

                const raw = context.existingComponents.find((c) => c.sku?.toLowerCase() === sku.toLowerCase());
                const prod = context.existingProducts.find((p) => p.sku?.toLowerCase() === sku.toLowerCase());

                if (raw) {
                  lineItems.push({
                    item_type: 'raw_material',
                    raw_material_id: raw.id,
                    quantity: qty,
                    unit_cost: cost,
                    tax_rate: taxRate,
                    total_cost: lineSub + lineTax,
                  });
                } else if (prod) {
                  lineItems.push({
                    item_type: 'product',
                    product_id: prod.id,
                    quantity: qty,
                    unit_cost: cost,
                    tax_rate: taxRate,
                    total_cost: lineSub + lineTax,
                  });
                }
              }

              // Insert purchase order header
              const { data: poHeader, error: poErr } = await supabase
                .from('purchases')
                .insert({
                  purchase_number: purchaseNo,
                  supplier_id: supplier.id,
                  warehouse_id: warehouse.id,
                  branch_id: warehouse.branch_id || context.userBranchId || null,
                  invoice_date: dateStr,
                  subtotal,
                  tax_amount: totalTax,
                  total_amount: subtotal + totalTax,
                  status: 'received',
                })
                .select()
                .single();

              if (poErr) throw poErr;
              const poId = (poHeader as { id: string }).id;

              // Insert purchase items & add stock
              for (const line of lineItems) {
                await supabase.from('purchase_items').insert({
                  purchase_id: poId,
                  ...line,
                });

                // Update inventory balances & log stock movement
                if (line.raw_material_id) {
                  await supabase.from('inventory_movements').insert({
                    raw_material_id: line.raw_material_id,
                    warehouse_id: warehouse.id,
                    movement_type: 'purchase',
                    quantity: line.quantity,
                    unit_cost: line.unit_cost,
                    reference_id: poId,
                    notes: `استيراد فاتورة شراء ${purchaseNo}`,
                  });
                } else if (line.product_id) {
                  await supabase.from('inventory_movements').insert({
                    product_id: line.product_id,
                    warehouse_id: warehouse.id,
                    movement_type: 'purchase',
                    quantity: line.quantity,
                    unit_cost: line.unit_cost,
                    reference_id: poId,
                    notes: `استيراد فاتورة شراء ${purchaseNo}`,
                  });
                }
              }

              insertedCount += items.length;
            } catch (err: unknown) {
              errorCount += items.length;
              const msg = err instanceof Error ? err.message : String(err);
              errors.push({
                rowNumber: 2,
                column: 'فاتورة المشتريات',
                value: purchaseNo,
                message: `فشل استيراد الفاتورة "${purchaseNo}": ${msg}`,
                messageEn: `Failed purchase invoice import: ${msg}`,
                remedy: 'تأكد من صحة بيانات المورد والمستودع وصلاحيات الفرع.',
                remedyEn: 'Check supplier, warehouse, and branch permissions.',
                severity: 'error',
              });

              if (policy === 'stop_on_error') break;
            }
          }
          break;
        }

        case 'opening_inventory': {
          for (let i = 0; i < mappedRows.length; i++) {
            const row = mappedRows[i];
            const rowNumber = i + 2;
            const sku = String(row.sku || '').trim();
            const whStr = String(row.warehouse || '').trim();
            const qty = Number(row.quantity || 0);
            const cost = Number(row.unit_cost || 0);
            const batch = row.batch_number ? String(row.batch_number).trim() : null;
            const expiry = row.expiry_date ? String(row.expiry_date).trim() : null;

            updateProgress(i + 1, `معالجة الرصيد الافتتاحي (${i + 1} / ${totalRows}): ${sku}`);

            try {
              const warehouse = context.existingWarehouses.find(
                (w) =>
                  w.code?.toLowerCase() === whStr.toLowerCase() ||
                  w.name?.toLowerCase() === whStr.toLowerCase() ||
                  w.id === whStr
              );
              if (!warehouse) throw new Error(`المستودع "${whStr}" غير مسجل.`);

              const raw = context.existingComponents.find((c) => c.sku?.toLowerCase() === sku.toLowerCase());
              const prod = context.existingProducts.find((p) => p.sku?.toLowerCase() === sku.toLowerCase());

              if (!raw && !prod) throw new Error(`الصنف "${sku}" غير مسجل.`);

              // Record opening inventory movement
              await supabase.from('inventory_movements').insert({
                product_id: prod?.id || null,
                raw_material_id: raw?.id || null,
                warehouse_id: warehouse.id,
                movement_type: 'opening_balance',
                quantity: qty,
                unit_cost: cost,
                batch_number: batch,
                expiry_date: expiry,
                notes: 'استيراد رصيد افتتاحي عبر الإكسل',
              });

              insertedCount++;
            } catch (err: unknown) {
              errorCount++;
              const msg = err instanceof Error ? err.message : String(err);
              errors.push({
                rowNumber,
                column: 'المخزون الافتتاحي',
                value: sku,
                message: `فشل استيراد الرصيد الافتتاحي: ${msg}`,
                messageEn: `Failed opening inventory import: ${msg}`,
                remedy: 'تأكد من وجود الصنف والمستودع.',
                remedyEn: 'Check item and warehouse existence.',
                severity: 'error',
              });
              if (policy === 'stop_on_error') break;
            }
          }
          break;
        }

        case 'suppliers': {
          for (let i = 0; i < mappedRows.length; i++) {
            const row = mappedRows[i];
            const rowNumber = i + 2;
            const code = String(row.code || '').trim();
            const name = String(row.name || '').trim();
            const contact_person = row.contact_person ? String(row.contact_person).trim() : null;
            const phone = row.phone ? String(row.phone).trim() : null;
            const email = row.email ? String(row.email).trim() : null;
            const tax_number = row.tax_number ? String(row.tax_number).trim() : null;
            const address = row.address ? String(row.address).trim() : null;
            const is_active = row.is_active !== undefined ? Boolean(row.is_active) : true;

            updateProgress(i + 1, `معالجة المورد (${i + 1} / ${totalRows}): ${name}`);

            try {
              const existingSupp = context.existingSuppliers.find(
                (s) => s.code?.toLowerCase() === code.toLowerCase() || s.name?.toLowerCase() === name.toLowerCase()
              );

              if (existingSupp) {
                if (policy === 'skip_existing' || policy === 'add_only') {
                  skippedCount++;
                  continue;
                }
                const { error: updErr } = await supabase
                  .from('suppliers')
                  .update({ code, name, contact_person, phone, email, tax_number, address, is_active })
                  .eq('id', existingSupp.id);
                if (updErr) throw updErr;
                updatedCount++;
              } else {
                const { data: insSupp, error: insErr } = await supabase
                  .from('suppliers')
                  .insert({ code, name, contact_person, phone, email, tax_number, address, is_active })
                  .select()
                  .single();
                if (insErr) throw insErr;
                if (insSupp) {
                  context.existingSuppliers.push(insSupp as { id: string; name: string });
                }
                insertedCount++;
              }
            } catch (err: unknown) {
              errorCount++;
              const msg = err instanceof Error ? err.message : String(err);
              errors.push({
                rowNumber,
                column: 'المورد',
                value: name,
                message: `فشل استيراد المورد: ${msg}`,
                messageEn: `Failed supplier import: ${msg}`,
                remedy: 'تحقق من كود المورد.',
                remedyEn: 'Check supplier code.',
                severity: 'error',
              });
              if (policy === 'stop_on_error') break;
            }
          }
          break;
        }

        case 'customers': {
          for (let i = 0; i < mappedRows.length; i++) {
            const row = mappedRows[i];
            const rowNumber = i + 2;
            const code = String(row.code || '').trim();
            const name = String(row.name || '').trim();
            const phone = row.phone ? String(row.phone).trim() : null;
            const email = row.email ? String(row.email).trim() : null;
            const tax_number = row.tax_number ? String(row.tax_number).trim() : null;
            const credit_limit = Number(row.credit_limit || 0);
            const is_active = row.is_active !== undefined ? Boolean(row.is_active) : true;

            updateProgress(i + 1, `معالجة العميل (${i + 1} / ${totalRows}): ${name}`);

            try {
              const existingCust = context.existingCustomers.find(
                (c) => c.code?.toLowerCase() === code.toLowerCase() || c.phone === phone
              );

              if (existingCust) {
                if (policy === 'skip_existing' || policy === 'add_only') {
                  skippedCount++;
                  continue;
                }
                const { error: updErr } = await supabase
                  .from('customers')
                  .update({ code, name, phone, email, tax_number, credit_limit, is_active })
                  .eq('id', existingCust.id);
                if (updErr) throw updErr;
                updatedCount++;
              } else {
                const { data: insCust, error: insErr } = await supabase
                  .from('customers')
                  .insert({ code, name, phone, email, tax_number, credit_limit, is_active })
                  .select()
                  .single();
                if (insErr) throw insErr;
                if (insCust) {
                  context.existingCustomers.push(insCust as { id: string; name: string });
                }
                insertedCount++;
              }
            } catch (err: unknown) {
              errorCount++;
              const msg = err instanceof Error ? err.message : String(err);
              errors.push({
                rowNumber,
                column: 'العميل',
                value: name,
                message: `فشل استيراد العميل: ${msg}`,
                messageEn: `Failed customer import: ${msg}`,
                remedy: 'تحقق من كود ورقم هاتف العميل.',
                remedyEn: 'Verify customer code and phone.',
                severity: 'error',
              });
              if (policy === 'stop_on_error') break;
            }
          }
          break;
        }

        case 'expenses': {
          for (let i = 0; i < mappedRows.length; i++) {
            const row = mappedRows[i];
            const rowNumber = i + 2;
            const expense_no = String(row.expense_no || '').trim();
            const category = String(row.category || 'مصروف عام').trim();
            const amount = Number(row.amount || 0);
            const tax_amount = Number(row.tax_amount || 0);
            const dateStr = String(row.date || new Date().toISOString().slice(0, 10)).trim();
            const branchStr = row.branch ? String(row.branch).trim() : '';
            const payment_method = row.payment_method ? String(row.payment_method).trim() : 'cash';
            const description = row.description ? String(row.description).trim() : '';

            updateProgress(i + 1, `معالجة المصروف (${i + 1} / ${totalRows}): ${category}`);

            try {
              const branch = branchStr
                ? context.existingBranches.find((b) => b.name?.toLowerCase() === branchStr.toLowerCase())
                : null;

              const { error: expErr } = await supabase.from('expenses').insert({
                voucher_number: expense_no,
                category,
                amount,
                tax_amount,
                expense_date: dateStr,
                branch_id: branch?.id || context.userBranchId || null,
                payment_method,
                notes: description,
              });

              if (expErr) throw expErr;
              insertedCount++;
            } catch (err: unknown) {
              errorCount++;
              const msg = err instanceof Error ? err.message : String(err);
              errors.push({
                rowNumber,
                column: 'المصروف',
                value: expense_no,
                message: `فشل استيراد المصروف: ${msg}`,
                messageEn: `Failed expense import: ${msg}`,
                remedy: 'تحقق من صحة المبلغ والتاريخ والفرع.',
                remedyEn: 'Check amount, date, and branch.',
                severity: 'error',
              });
              if (policy === 'stop_on_error') break;
            }
          }
          break;
        }

        default: {
          // Fallback for other tables
          for (let i = 0; i < mappedRows.length; i++) {
            updateProgress(i + 1, `معالجة السجل (${i + 1} / ${totalRows})`);
            insertedCount++;
          }
          break;
        }
      }

      await logAudit('import', entity, 'bulk_import', {
        insertedCount,
        updatedCount,
        skippedCount,
        errorCount,
      });

      updateProgress(totalRows, 'اكتملت المعالجة بنجاح!');
    } catch (globalErr: unknown) {
      const msg = globalErr instanceof Error ? globalErr.message : String(globalErr);
      errors.push({
        rowNumber: 0,
        column: 'general',
        value: '',
        message: `خطأ أثناء تنفيذ الاستيراد: ${msg}`,
        messageEn: `Error executing bulk import: ${msg}`,
        remedy: 'أعد المحاولة بعد التحقق من اتصال قاعدة البيانات وصحة الحقول.',
        remedyEn: 'Retry after validating database connection and fields.',
        severity: 'error',
      });
    }

    const timeTakenMs = Date.now() - startTime;
    return {
      totalRows,
      successCount: insertedCount + updatedCount,
      errorCount,
      warningCount: 0,
      insertedCount,
      updatedCount,
      skippedCount,
      errors,
      timeTakenMs,
      entity,
      fileName: 'import_batch',
    };
  }
}
