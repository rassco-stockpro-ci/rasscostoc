import { Switch, Route, useLocation } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AuthProvider, useAuth } from "@/lib/auth";
import { LanguageProvider, useTranslation } from "@/lib/language";
import { NeoShellLayout } from "@/components/layout/neo-shell-layout";
import { Loader2 } from "lucide-react";
import { hasRoleOrAbove, ROLES } from "@shared/roles";
import { lazy, Suspense, useEffect, type ComponentType } from "react";

const LandingPage = lazy(() => import("@/pages/landing"));
const Login = lazy(() => import("@/pages/login"));
const NotFound = lazy(() => import("@/pages/not-found"));
const Dashboard = lazy(() => import("@/pages/dashboard"));
const AdminPage = lazy(() => import("@/pages/admin"));
const TransactionHistoryPage = lazy(() =>
  import("@/pages/transaction-history").then((m) => ({ default: m.TransactionHistoryPage })),
);
const WithdrawnDevicesPage = lazy(() => import("./pages/withdrawn-devices"));
const WithdrawnDevicesManagementPage = lazy(() => import("./pages/withdrawn-devices-management"));
const WithdrawnDevicesAllPage = lazy(() => import("./pages/withdrawn-devices-all"));
const WithdrawnDeviceDetailsPage = lazy(() => import("@/pages/WithdrawnDeviceDetails"));
const ReceivedDevicesSubmit = lazy(() => import("@/pages/ReceivedDevicesSubmit"));
const ReceivedDevicesReview = lazy(() => import("@/pages/ReceivedDevicesReview"));
const ReceivedDeviceDetails = lazy(() => import("./pages/ReceivedDeviceDetails"));
const UsersPage = lazy(() => import("@/pages/users"));
const FixedInventoryDashboard = lazy(() => import("@/pages/fixed-inventory-dashboard"));
const MyFixedInventory = lazy(() => import("@/pages/my-fixed-inventory"));
const MyMovingInventory = lazy(() => import("@/pages/my-moving-inventory"));
const AdminInventoryOverview = lazy(() => import("@/pages/admin-inventory-overview"));
const WarehousesPage = lazy(() => import("@/pages/warehouses"));
const WarehouseDetailsPage = lazy(() => import("@/pages/warehouse-details"));
const TransferDetailsPage = lazy(() => import("@/pages/transfer-details"));
const OperationsPage = lazy(() => import("@/pages/operations"));
const OperationDetailsPage = lazy(() => import("@/pages/operation-details"));
const OperationsSearchPage = lazy(() => import("@/pages/operations-search"));
const NotificationsPage = lazy(() => import("@/pages/notifications"));
const ProductsManagementPage = lazy(() => import("./pages/products-management"));
const ProductDetailsPage = lazy(() => import("./pages/product-details"));
const ProductSmartAddPage = lazy(() => import("@/pages/product-smart-add"));
const ProfilePage = lazy(() => import("@/pages/profile"));
const TechnicianDetailsPage = lazy(() => import("@/pages/technician-details"));
const VerificationPage = lazy(() => import("@/pages/verification"));
const TechnicianItemDetailsPage = lazy(() => import("@/pages/technician-item-details"));
const EmployeeDetailedProfileTemplatePage = lazy(() => import("@/pages/employee-detailed-profile-template"));
const EmployeeEditProfileTemplatePage = lazy(() => import("@/pages/employee-edit-profile-template"));
const SystemLogsPage = lazy(() => import("@/pages/system-logs"));
const BackupManagementPage = lazy(() => import("@/pages/backup-management"));
const ItemTypesManagement = lazy(() => import("@/pages/item-types-management"));
const ItemTypeDetailsPage = lazy(() => import("@/pages/item-type-details"));
const AccountingDashboardPage = lazy(() => import("@/pages/accounting-dashboard"));
const CourierDashboardPage = lazy(() => import("@/pages/courier/courier-dashboard"));
const CourierRawDataPage = lazy(() => import("@/pages/courier/courier-raw-data"));
const CourierRequestsPage = lazy(() => import("@/pages/courier/courier-requests"));
const CourierRequestDetailPage = lazy(() => import("@/pages/courier/courier-request-detail"));
const CourierPdfUploadPage = lazy(() => import("@/pages/courier/courier-pdf-upload"));
const CourierPdfReviewPage = lazy(() => import("@/pages/courier/courier-pdf-review"));
const CourierReportsPage = lazy(() => import("@/pages/courier/courier-reports"));
const CourierExportPage = lazy(() => import("@/pages/courier/courier-export"));
const CourierAiMonitorPage = lazy(() => import("@/pages/courier/courier-ai-monitor"));
const CourierAuditLogPage = lazy(() => import("@/pages/courier/courier-audit-log"));
const CourierSettingsPage = lazy(() => import("@/pages/courier/courier-settings"));
const CourierObservabilityPage = lazy(() => import("@/pages/courier/courier-observability"));
const AiReviewWorkspacePage = lazy(() => import("@/pages/ai-review/ai-review-workspace-page"));
const AiEngineSettingsPage = lazy(() => import("@/pages/admin/ai-engine-settings"));
const PermissionsCenterPage = lazy(() => import("@/pages/admin/permissions-center"));
const LeadDiscoveryAuditPage = lazy(() => import("@/pages/lead-discovery-audit"));

function PageLoader() {
  return (
    <div className="min-h-[40vh] flex items-center justify-center">
      <Loader2 className="h-6 w-6 animate-spin text-[#18B2B0]" />
    </div>
  );
}

function Redirect({ to }: { to: string }) {
  const [, setLocation] = useLocation();

  useEffect(() => {
    setLocation(to);
  }, [to, setLocation]);

  return null;
}

function AuthenticatedRouter() {
  const { user } = useAuth();

  const withShell = (
    Component: ComponentType,
    titleKey: string,
  ) => () => (
    <NeoShellLayout titleKey={titleKey}>
      <Suspense fallback={<PageLoader />}>
        <Component />
      </Suspense>
    </NeoShellLayout>
  );

  return (
    <Suspense fallback={<PageLoader />}>
    <Switch>
      <Route path="/" component={() => <Redirect to="/home" />} />
      <Route path="/devices" component={() => <Redirect to="/home" />} />
      <Route path="/stock" component={LandingPage} />
      <Route path="/home" component={withShell(Dashboard, "titles.home")} />
      <Route path="/transactions" component={withShell(TransactionHistoryPage, "titles.transactions")} />
      <Route path="/operations-search" component={withShell(OperationsSearchPage, "titles.operations_search")} />
      <Route path="/withdrawn-devices" component={withShell(WithdrawnDevicesPage, "titles.withdrawn_devices")} />
      <Route path="/withdrawn-devices/management" component={withShell(WithdrawnDevicesManagementPage, "titles.withdrawn_management")} />
      <Route path="/withdrawn-devices/all" component={withShell(WithdrawnDevicesAllPage, "titles.withdrawn_all")} />
      <Route path="/withdrawn-devices/:id" component={withShell(WithdrawnDeviceDetailsPage, "titles.withdrawn_details")} />
      <Route path="/received-devices/submit" component={withShell(ReceivedDevicesSubmit, "titles.received_submit")} />
      <Route path="/received-devices/review" component={withShell(ReceivedDevicesReview, "titles.received_review")} />
      <Route path="/received-devices/:id" component={withShell(ReceivedDeviceDetails, "titles.received_details")} />
      <Route path="/notifications" component={withShell(NotificationsPage, "titles.notifications")} />
      <Route path="/products-management" component={withShell(ProductsManagementPage, "titles.products")} />
      <Route path="/products-management/:id/details" component={withShell(ProductDetailsPage, "titles.product_details")} />
      <Route path="/products-management/:id/smart-add" component={withShell(ProductSmartAddPage, "titles.product_smart_add")} />
      <Route path="/profile" component={withShell(ProfilePage, "titles.profile")} />
      <Route path="/technician-details/:id" component={withShell(TechnicianDetailsPage, "titles.technician_details")} />
      <Route path="/technician-details/:technicianId/item/:itemTypeId" component={withShell(TechnicianItemDetailsPage, "titles.product_details")} />
      <Route path="/employee-detailed-profile-template" component={withShell(EmployeeDetailedProfileTemplatePage, "titles.employee_profile")} />
      <Route path="/employee-edit-profile-template" component={withShell(EmployeeEditProfileTemplatePage, "titles.employee_edit")} />
      <Route path="/system-logs" component={withShell(SystemLogsPage, "titles.system_logs")} />
      {user?.role === "technician" && (
        <>
          <Route path="/my-fixed-inventory" component={withShell(MyFixedInventory, "titles.my_fixed")} />
          <Route path="/my-moving-inventory" component={withShell(MyMovingInventory, "titles.my_moving")} />
        </>
      )}
      {hasRoleOrAbove(user?.role || "", ROLES.SUPERVISOR) && (
        <>
          <Route path="/verification" component={withShell(VerificationPage, "titles.verification")} />
          <Route path="/admin-inventory-overview" component={withShell(AdminInventoryOverview, "titles.admin_inventory")} />
          <Route path="/warehouses" component={withShell(WarehousesPage, "titles.warehouses")} />
          <Route path="/warehouses/:id" component={withShell(WarehouseDetailsPage, "titles.warehouse_details")} />
          <Route path="/transfer-details/:id" component={withShell(TransferDetailsPage, "titles.transfer_details")} />
          <Route path="/operations" component={withShell(OperationsPage, "titles.operations")} />
          <Route path="/operation-details/:groupId" component={withShell(OperationDetailsPage, "titles.operation_details")} />
          <Route path="/leads-audit" component={withShell(LeadDiscoveryAuditPage, "titles.leads_audit")} />
        </>
      )}
      <Route path="/accounting" component={withShell(AccountingDashboardPage, "titles.accounting")} />

      {user?.role === "admin" && (
        <>
          <Route path="/courier" component={withShell(CourierDashboardPage, "titles.courier")} />
          <Route path="/courier/raw-data" component={withShell(CourierRawDataPage, "titles.courier_raw")} />
          <Route path="/courier/requests" component={withShell(CourierRequestsPage, "titles.courier_requests")} />
          <Route path="/courier/requests/:id" component={withShell(CourierRequestDetailPage, "titles.courier_request_detail")} />
          <Route path="/courier/pdf" component={withShell(CourierPdfUploadPage, "titles.courier_pdf")} />
          <Route path="/courier/pdf/:id" component={withShell(CourierPdfReviewPage, "titles.courier_pdf_review")} />
          <Route path="/courier/reports" component={withShell(CourierReportsPage, "titles.courier_reports")} />
          <Route path="/courier/export" component={withShell(CourierExportPage, "titles.courier_export")} />
          <Route path="/courier/ai-monitor" component={withShell(CourierAiMonitorPage, "titles.courier_ai")} />
          <Route path="/courier/audit-log" component={withShell(CourierAuditLogPage, "titles.courier_audit")} />
          <Route path="/courier/settings" component={withShell(CourierSettingsPage, "titles.courier_settings")} />
          <Route path="/courier/observability" component={withShell(CourierObservabilityPage, "titles.courier_observability")} />
          <Route path="/ai-review" component={withShell(AiReviewWorkspacePage, "titles.ai_review")} />
        </>
      )}
      {user?.role === "admin" && (
        <>
          <Route path="/admin" component={withShell(AdminPage, "titles.admin")} />
          <Route path="/users" component={withShell(UsersPage, "titles.users")} />
          <Route path="/fixed-inventory" component={withShell(FixedInventoryDashboard, "titles.fixed_inventory")} />
          <Route path="/backup" component={withShell(BackupManagementPage, "titles.backup")} />
          <Route path="/item-types" component={withShell(ItemTypesManagement, "titles.item_types")} />
          <Route path="/item-types/:id/details" component={withShell(ItemTypeDetailsPage, "titles.item_type_details")} />
          <Route path="/ai-engine/settings" component={withShell(AiEngineSettingsPage, "titles.ai_engine_settings")} />
          <Route path="/admin/permissions" component={withShell(PermissionsCenterPage, "titles.permissions_center")} />
        </>
      )}
      <Route component={NotFound} />
    </Switch>
    </Suspense>
  );
}

function AppContent() {
  const { isAuthenticated, isLoading } = useAuth();
  const { t, dir } = useTranslation();

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50" dir={dir}>
        <div className="flex items-center gap-2 text-rassco-text font-semibold">
          <Loader2 className="h-6 w-6 animate-spin text-rassco" />
          <span>{t("messages.loading")}</span>
        </div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return (
      <Suspense fallback={<PageLoader />}>
        <Switch>
          <Route path="/" component={() => <Redirect to="/login" />} />
          <Route path="/stock" component={LandingPage} />
          <Route path="/login" component={Login} />
          <Route component={() => <Redirect to="/login" />} />
        </Switch>
      </Suspense>
    );
  }

  return <AuthenticatedRouter />;
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <LanguageProvider>
        <AuthProvider>
          <TooltipProvider>
            <Toaster />
            <AppContent />
          </TooltipProvider>
        </AuthProvider>
      </LanguageProvider>
    </QueryClientProvider>
  );
}

export default App;
