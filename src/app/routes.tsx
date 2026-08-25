import { Suspense, lazy, type ReactNode } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { Layout } from '../components/Layout';
import { useCan, type Permission } from '../lib/permissions';
import { useFeatureAccess } from '../hooks/useFeatureAccess';
import { FeatureLocked } from '../components/subscription/FeatureLocked';
import { APP_ROUTES } from '@/core/navigation/routes';
const LoginPage = lazy(() => import('../features/auth/pages/LoginPage').then(m => ({ default: m.LoginPage })));
const RegisterPage = lazy(() => import('../features/auth/pages/RegisterPage').then(m => ({ default: m.RegisterPage })));
const SubscriptionPage = lazy(() => import('../features/subscription/pages/SubscriptionPage').then(m => ({ default: m.SubscriptionPage })));
const DashboardPage = lazy(() => import('../features/dashboard/pages/DashboardEnhancedPage').then(m => ({ default: m.DashboardEnhancedPage })));
const OperationsCenterPage = lazy(() => import('../features/operations/pages/OperationsCenterPage').then(m => ({ default: m.OperationsCenterPage })));
const InventoryCenterPage = lazy(() => import('../features/inventory/pages/InventoryCenterPage').then(m => ({ default: m.InventoryCenterPage })));
const ProcurementCenterPage = lazy(() => import('../features/trade/pages/ProcurementCenterPage').then(m => ({ default: m.ProcurementCenterPage })));
const PosWorkspacePage = lazy(() => import('../features/pos/pages/PosWorkspacePage').then(m => ({ default: m.PosWorkspacePage })));
const ActiveOrdersPage = lazy(() => import('../features/pos/pages/ActiveOrdersPage').then(m => ({ default: m.ActiveOrdersPage })));
const ProductsPage = lazy(() => import('../features/catalog/pages/ProductsPage').then(m => ({ default: m.ProductsPage })));
const ProductSetupWizardPage = lazy(() => import('../features/catalog/pages/ProductSetupWizardPage').then(m => ({ default: m.ProductSetupWizardPage })));
const CategoriesPage = lazy(() => import('../features/catalog/pages/CategoriesPage').then(m => ({ default: m.CategoriesPage })));
const ComponentsPage = lazy(() => import('../features/catalog/pages/ComponentsPage').then(m => ({ default: m.ComponentsPage })));
const InventoryPage = lazy(() => import('../features/inventory/pages/InventoryPage').then(m => ({ default: m.InventoryPage })));
const WarehousesPage = lazy(() => import('../features/inventory/pages/WarehousesPage').then(m => ({ default: m.WarehousesPage })));
const RawMaterialsPage = lazy(() => import('../features/manufacturing/pages/RawMaterialsPage').then(m => ({ default: m.RawMaterialsPage })));
const RecipesPage = lazy(() => import('../features/manufacturing/pages/RecipesPage').then(m => ({ default: m.RecipesPage })));
const UnitProductionPage = lazy(() => import('../features/manufacturing/pages/UnitProductionPage').then(m => ({ default: m.UnitProductionPage })));
const TransfersPage = lazy(() => import('../features/inventory/pages/TransfersPage').then(m => ({ default: m.TransfersPage })));
const InventoryLedgerPage = lazy(() => import('../features/inventory/pages/InventoryLedgerPage').then(m => ({ default: m.InventoryLedgerPage })));
const StockCountsPage = lazy(() => import('../features/inventory/pages/StockCountsPage').then(m => ({ default: m.StockCountsPage })));
const InventoryBatchesPage = lazy(() => import('../features/inventory/pages/InventoryBatchesPage').then(m => ({ default: m.InventoryBatchesPage })));
const StockValuationPage = lazy(() => import('../features/inventory/pages/StockValuationPage').then(m => ({ default: m.StockValuationPage })));
const LowStockAlertsPage = lazy(() => import('../features/inventory/pages/LowStockAlertsPage').then(m => ({ default: m.LowStockAlertsPage })));
const CostingCenterPage = lazy(() => import('../features/costing/pages/CostingCenterPage').then(m => ({ default: m.CostingCenterPage })));
const InventoryUnitsPage = lazy(() => import('../features/catalog/pages/InventoryUnitsPage').then(m => ({ default: m.InventoryUnitsPage })));
const WasteCenterPage = lazy(() => import('../features/inventory/pages/WasteCenterPage').then(m => ({ default: m.WasteCenterPage })));
const KitchenDisplayPage = lazy(() => import('../features/inventory/pages/KitchenDisplayPage').then(m => ({ default: m.KitchenDisplayPage })));
const KitchenStationsPage = lazy(() => import('../features/catalog/pages/KitchenStationsPage').then(m => ({ default: m.KitchenStationsPage })));
const ManufacturingCenterPage = lazy(() => import('../features/manufacturing/pages/ManufacturingCenterPage').then(m => ({ default: m.ManufacturingCenterPage })));
const BranchesPage = lazy(() => import('../features/admin/pages/BranchesPage').then(m => ({ default: m.BranchesPage })));
const PurchasesPage = lazy(() => import('../features/trade/pages/PurchasesPage').then(m => ({ default: m.PurchasesPage })));
const PurchaseRequestsPage = lazy(() => import('../features/trade/pages/PurchaseRequestsPage').then(m => ({ default: m.PurchaseRequestsPage })));
const RfqsPage = lazy(() => import('../features/trade/pages/RfqsPage').then(m => ({ default: m.RfqsPage })));
const ReceivingPage = lazy(() => import('../features/trade/pages/ReceivingPage').then(m => ({ default: m.ReceivingPage })));
const CustomersPage = lazy(() => import('../features/parties/pages/CustomersPage').then(m => ({ default: m.CustomersPage })));
const SuppliersPage = lazy(() => import('../features/parties/pages/SuppliersPage').then(m => ({ default: m.SuppliersPage })));
const ExpensesPage = lazy(() => import('../features/trade/pages/ExpensesPage').then(m => ({ default: m.ExpensesPage })));
const SalesPage = lazy(() => import('../features/trade/pages/SalesPage').then(m => ({ default: m.SalesPage })));
const ShiftsPage = lazy(() => import('../features/trade/pages/ShiftsPage').then(m => ({ default: m.ShiftsPage })));

const ReportsCenterPage = lazy(() => import('../features/reporting/pages/ReportsCenterPage').then(m => ({ default: m.ReportsCenterPage })));
const FinancialReportsPage = lazy(() => import('../features/accounting/pages/FinancialReportsPage').then(m => ({ default: m.FinancialReportsPage })));
const AccountsPage = lazy(() => import('../features/accounting/pages/AccountsPage').then(m => ({ default: m.AccountsPage })));
const PaymentsPage = lazy(() => import('../features/accounting/pages/PaymentsPage').then(m => ({ default: m.PaymentsPage })));
const JournalPage = lazy(() => import('../features/accounting/pages/JournalPage').then(m => ({ default: m.JournalPage })));
const TreasuryPage = lazy(() => import('../features/accounting/pages/TreasuryPage').then(m => ({ default: m.TreasuryPage })));
const ReconciliationPage = lazy(() => import('../features/accounting/pages/ReconciliationPage').then(m => ({ default: m.ReconciliationPage })));
const UsersPage = lazy(() => import('../features/admin/pages/UsersPage').then(m => ({ default: m.UsersPage })));
const AuditLogPage = lazy(() => import('../features/reporting/pages/AuditLogPage').then(m => ({ default: m.AuditLogPage })));
const SettingsControlCenterPage = lazy(() => import('../features/admin/pages/SettingsControlCenterPage').then(m => ({ default: m.SettingsControlCenterPage })));
const SubscriptionsAdminPage = lazy(() => import('../features/admin/pages/SubscriptionsAdminPage').then(m => ({ default: m.SubscriptionsAdminPage })));
const SuperAdminConsolePage = lazy(() => import('../features/admin/pages/SuperAdminConsolePage').then(m => ({ default: m.SuperAdminConsolePage })));
const SystemHealthPage = lazy(() => import('../features/admin/pages/SystemHealthPage').then(m => ({ default: m.SystemHealthPage })));
function PageLoader() { return <div className="min-h-screen flex items-center justify-center bg-ui-page"><div className="animate-spin rounded-full h-10 w-10 border-b-2 border-ui-primary" /></div>; }

function ProtectedRoute({
  children,
  permission,
  fullscreen,
  subscriptionGate = true,
  superAdminOnly = false,
  feature,
}: {
  children: ReactNode;
  permission?: Permission;
  fullscreen?: boolean;
  subscriptionGate?: boolean;
  superAdminOnly?: boolean;
  feature?: string;
}) {
  const { session, loading, user, subscription } = useAuth();
  const can = useCan();
  const featureAccess = useFeatureAccess(feature || '', user?.branch_id);

  if (loading) return <PageLoader />;
  if (!session) return <Navigate to={APP_ROUTES.login} replace />;
  if (superAdminOnly && user?.role !== 'super_admin') return <Navigate to={APP_ROUTES.dashboard} replace />;
  if (permission && !can(permission)) return <Navigate to={APP_ROUTES.dashboard} replace />;
  if (subscriptionGate && user && user.role !== 'super_admin' && user.branch_id && subscription?.expired) {
    return <Navigate to={APP_ROUTES.subscription} replace />;
  }

  // Feature gate check
  if (feature && user?.role !== 'super_admin' && !featureAccess.allowed) {
    if (fullscreen) {
      return (
        <FeatureLocked
          featureKey={feature}
          reason={featureAccess.reason}
          message={featureAccess.message}
        />
      );
    }
    return (
      <Layout>
        <FeatureLocked
          featureKey={feature}
          reason={featureAccess.reason}
          message={featureAccess.message}
        />
      </Layout>
    );
  }

  if (fullscreen) return <>{children}</>;
  return <Layout>{children}</Layout>;
}

function PublicRoute({ children }: { children: ReactNode }) {
  const { session, loading } = useAuth();
  if (loading) return null;
  if (session) return <Navigate to={APP_ROUTES.dashboard} replace />;
  return <>{children}</>;
}

export function AppRoutes() {
  return (
    <Suspense fallback={<PageLoader />}>
      <Routes>
        <Route path={APP_ROUTES.login} element={<PublicRoute><LoginPage /></PublicRoute>} />
        <Route path={APP_ROUTES.register} element={<PublicRoute><RegisterPage /></PublicRoute>} />
        <Route path={APP_ROUTES.subscription} element={<ProtectedRoute subscriptionGate={false}><SubscriptionPage /></ProtectedRoute>} />
        <Route path={APP_ROUTES.dashboard} element={<ProtectedRoute permission="dashboard.view"><DashboardPage /></ProtectedRoute>} />
        <Route path={APP_ROUTES.operationsCenter} element={<ProtectedRoute permission="dashboard.view"><OperationsCenterPage /></ProtectedRoute>} />
        <Route path={APP_ROUTES.inventoryCenter} element={<ProtectedRoute permission="inventory.view" feature="inventory"><InventoryCenterPage /></ProtectedRoute>} />
        <Route path={APP_ROUTES.procurementCenter} element={<ProtectedRoute permission="purchases.view" feature="purchases"><ProcurementCenterPage /></ProtectedRoute>} />
        <Route path={APP_ROUTES.manufacturingCenter} element={<ProtectedRoute permission="production.view" feature="manufacturing"><ManufacturingCenterPage /></ProtectedRoute>} />
        <Route path={APP_ROUTES.pos} element={<ProtectedRoute permission="pos.sell" feature="pos" fullscreen><PosWorkspacePage /></ProtectedRoute>} />
        <Route path={`${APP_ROUTES.pos}/:orderId`} element={<ProtectedRoute permission="pos.sell" feature="pos" fullscreen><PosWorkspacePage /></ProtectedRoute>} />
        <Route path={APP_ROUTES.floorPlan} element={<ProtectedRoute permission="floor_plan.view" feature="tables"><ActiveOrdersPage /></ProtectedRoute>} />
        <Route path="/kitchen" element={<Navigate to={APP_ROUTES.pos} replace />} />
        <Route path="/tables" element={<ProtectedRoute permission="floor_plan.view" feature="tables"><Navigate to={APP_ROUTES.floorPlan} replace /></ProtectedRoute>} />
        <Route path={APP_ROUTES.products} element={<ProtectedRoute permission="products.view"><ProductsPage /></ProtectedRoute>} />
        <Route path={`${APP_ROUTES.products}/setup`} element={<ProtectedRoute permission="products.manage"><ProductSetupWizardPage /></ProtectedRoute>} />
        <Route path={APP_ROUTES.categories} element={<ProtectedRoute permission="categories.view"><CategoriesPage /></ProtectedRoute>} />
        <Route path={APP_ROUTES.components} element={<ProtectedRoute permission="components.view"><ComponentsPage /></ProtectedRoute>} />
        <Route path={APP_ROUTES.inventoryUnits} element={<ProtectedRoute permission="raw_materials.view" feature="units"><InventoryUnitsPage /></ProtectedRoute>} />
        <Route path={APP_ROUTES.wasteCenter} element={<ProtectedRoute permission="production.waste" feature="waste_management"><WasteCenterPage /></ProtectedRoute>} />
        <Route path={APP_ROUTES.kitchenDisplay} element={<ProtectedRoute permission="pos.sell" feature="kds"><KitchenDisplayPage /></ProtectedRoute>} />
        <Route path={APP_ROUTES.kitchenStations} element={<ProtectedRoute permission="settings.manage" feature="kds"><KitchenStationsPage /></ProtectedRoute>} />
        <Route path={APP_ROUTES.inventory} element={<ProtectedRoute permission="inventory.view" feature="inventory"><InventoryPage /></ProtectedRoute>} />
        <Route path={APP_ROUTES.warehouses} element={<ProtectedRoute permission="warehouses.view" feature="warehouse_management"><WarehousesPage /></ProtectedRoute>} />
        <Route path={APP_ROUTES.rawMaterials} element={<ProtectedRoute permission="raw_materials.view" feature="inventory"><RawMaterialsPage /></ProtectedRoute>} />
        <Route path={APP_ROUTES.recipes} element={<ProtectedRoute permission="recipes.view" feature="recipes"><RecipesPage /></ProtectedRoute>} />
        <Route path={APP_ROUTES.production} element={<ProtectedRoute permission="production.view" feature="manufacturing"><UnitProductionPage /></ProtectedRoute>} />
        <Route path={APP_ROUTES.productionUnits} element={<ProtectedRoute permission="production.view" feature="manufacturing"><UnitProductionPage /></ProtectedRoute>} />
        <Route path={APP_ROUTES.transfers} element={<ProtectedRoute permission="inventory.transfers" feature="transfers"><TransfersPage /></ProtectedRoute>} />
        <Route path={APP_ROUTES.inventoryLedger} element={<ProtectedRoute permission="inventory.ledger.view" feature="inventory"><InventoryLedgerPage /></ProtectedRoute>} />
        <Route path={APP_ROUTES.stockCounts} element={<ProtectedRoute permission="inventory.manage" feature="stock_counts"><StockCountsPage /></ProtectedRoute>} />
        <Route path={APP_ROUTES.inventoryBatches} element={<ProtectedRoute permission="inventory.view" feature="inventory"><InventoryBatchesPage /></ProtectedRoute>} />
        <Route path={APP_ROUTES.stockValuation} element={<ProtectedRoute permission="inventory.ledger.view" feature="inventory"><StockValuationPage /></ProtectedRoute>} />
        <Route path={APP_ROUTES.lowStockAlerts} element={<ProtectedRoute permission="inventory.view" feature="inventory"><LowStockAlertsPage /></ProtectedRoute>} />
        <Route path={APP_ROUTES.costingCenter} element={<ProtectedRoute permission="reports.costing" feature="costing"><CostingCenterPage /></ProtectedRoute>} />
        <Route path={APP_ROUTES.branches} element={<ProtectedRoute permission="branches.manage" feature="multi_branch"><BranchesPage /></ProtectedRoute>} />
        <Route path={APP_ROUTES.purchases} element={<ProtectedRoute permission="purchases.view" feature="purchases"><PurchasesPage /></ProtectedRoute>} />
        <Route path={APP_ROUTES.purchaseRequests} element={<ProtectedRoute permission="purchases.requests" feature="purchases"><PurchaseRequestsPage /></ProtectedRoute>} />
        <Route path={APP_ROUTES.rfqs} element={<ProtectedRoute permission="purchases.rfq" feature="purchases"><RfqsPage /></ProtectedRoute>} />
        <Route path={APP_ROUTES.receiving} element={<ProtectedRoute permission="purchases.receiving" feature="purchases"><ReceivingPage /></ProtectedRoute>} />
        <Route path={APP_ROUTES.customers} element={<ProtectedRoute permission="customers.view" feature="customers"><CustomersPage /></ProtectedRoute>} />
        <Route path={APP_ROUTES.suppliers} element={<ProtectedRoute permission="suppliers.view" feature="suppliers"><SuppliersPage /></ProtectedRoute>} />
        <Route path={APP_ROUTES.expenses} element={<ProtectedRoute permission="expenses.view"><ExpensesPage /></ProtectedRoute>} />
        <Route path={APP_ROUTES.sales} element={<ProtectedRoute permission="sales.view"><SalesPage /></ProtectedRoute>} />
        <Route path={APP_ROUTES.shifts} element={<ProtectedRoute permission="shifts.view" feature="shift_management"><ShiftsPage /></ProtectedRoute>} />
        <Route path={APP_ROUTES.reports} element={<ProtectedRoute permission="reports.view" feature="reports"><ReportsCenterPage /></ProtectedRoute>} />
        <Route path={APP_ROUTES.financialReports} element={<ProtectedRoute permission="reports.financial" feature="accounting"><FinancialReportsPage /></ProtectedRoute>} />
        <Route path={APP_ROUTES.accounting} element={<ProtectedRoute permission="reports.financial" feature="accounting"><Navigate to={APP_ROUTES.financialReports} replace /></ProtectedRoute>} />
        <Route path={APP_ROUTES.accounts} element={<ProtectedRoute permission="accounts.view" feature="accounting"><AccountsPage /></ProtectedRoute>} />
        <Route path={APP_ROUTES.payments} element={<ProtectedRoute permission="accounts.view" feature="accounting"><PaymentsPage /></ProtectedRoute>} />
        <Route path={APP_ROUTES.journal} element={<ProtectedRoute permission="accounts.view" feature="accounting"><JournalPage /></ProtectedRoute>} />
        <Route path={APP_ROUTES.treasury} element={<ProtectedRoute permission="accounts.view" feature="accounting"><TreasuryPage /></ProtectedRoute>} />
        <Route path={APP_ROUTES.reconciliation} element={<ProtectedRoute permission="accounts.view" feature="accounting"><ReconciliationPage /></ProtectedRoute>} />
        <Route path={APP_ROUTES.users} element={<ProtectedRoute permission="users.view" feature="employees"><UsersPage /></ProtectedRoute>} />
        <Route path={APP_ROUTES.employees} element={<ProtectedRoute permission="users.view" feature="employees"><Navigate to={APP_ROUTES.users} replace /></ProtectedRoute>} />
        <Route path={APP_ROUTES.auditLog} element={<ProtectedRoute permission="audit.view" feature="audit_logs"><AuditLogPage /></ProtectedRoute>} />
        <Route path={APP_ROUTES.settings} element={<ProtectedRoute permission="settings.manage"><SettingsControlCenterPage /></ProtectedRoute>} />
        <Route path={APP_ROUTES.subscriptions} element={<ProtectedRoute superAdminOnly><SubscriptionsAdminPage /></ProtectedRoute>} />
        <Route path={APP_ROUTES.superAdmin} element={<ProtectedRoute superAdminOnly><SuperAdminConsolePage /></ProtectedRoute>} />
        <Route path={APP_ROUTES.basicSettings} element={<ProtectedRoute permission="settings.manage"><Navigate to={APP_ROUTES.settings} replace /></ProtectedRoute>} />
        <Route path={APP_ROUTES.systemHealth} element={<ProtectedRoute permission="settings.manage"><SystemHealthPage /></ProtectedRoute>} />
        <Route path="*" element={<Navigate to={APP_ROUTES.dashboard} replace />} />
      </Routes>
    </Suspense>
  );
}
