import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { AuthProvider, useAuth } from "./auth/AuthContext";
import { ProtectedRoute } from "./components/ProtectedRoute";
import Layout from "./components/Layout";
import Login from "./pages/Login";
import Dashboard from "./pages/Dashboard";
import SkusPage from "./pages/Skus";
import LocationsPage from "./pages/Locations";
import OrdersList from "./pages/OrdersList";
import OrderNew from "./pages/OrderNew";
import OrderDetail from "./pages/OrderDetail";
import Picking from "./pages/Picking";
import PickingSession from "./pages/PickingSession";
import Receiving from "./pages/Receiving";
import Pricing from "./pages/Pricing";
import Reports from "./pages/Reports";
import Users from "./pages/Users";
import Security from "./pages/Security";
import MyTasks from "./pages/MyTasks";
import StockLookup from "./pages/StockLookup";
import StockTransfer from "./pages/StockTransfer";
import PutBacks from "./pages/PutBacks";
import SettingsPage from "./pages/Settings";

function LoginRoute() {
  const { user, loading } = useAuth();
  if (loading) return null;
  if (user) return <Navigate to="/" replace />;
  return <Login />;
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<LoginRoute />} />
          <Route
            element={
              <ProtectedRoute>
                <Layout />
              </ProtectedRoute>
            }
          >
            <Route path="/" element={<Dashboard />} />
            <Route path="/skus" element={<SkusPage />} />
            <Route path="/locations" element={<LocationsPage />} />
            <Route
              path="/orders"
              element={
                <ProtectedRoute roles={["OWNER", "ACCOUNTANT", "SALES"]}>
                  <OrdersList />
                </ProtectedRoute>
              }
            />
            <Route
              path="/orders/new"
              element={
                <ProtectedRoute permission="orders.createDraft">
                  <OrderNew />
                </ProtectedRoute>
              }
            />
            <Route
              path="/orders/:id"
              element={
                <ProtectedRoute roles={["OWNER", "ACCOUNTANT", "SALES"]}>
                  <OrderDetail />
                </ProtectedRoute>
              }
            />
            <Route
              path="/picking"
              element={
                <ProtectedRoute permission="inventory.scanPutaway">
                  <Picking />
                </ProtectedRoute>
              }
            />
            <Route
              path="/picking/:orderId"
              element={
                <ProtectedRoute permission="inventory.scanPutaway">
                  <PickingSession />
                </ProtectedRoute>
              }
            />
            <Route
              path="/receiving"
              element={
                <ProtectedRoute anyPermission={["inventory.scanPutaway", "inventory.logInwardEntry"]}>
                  <Receiving />
                </ProtectedRoute>
              }
            />
            <Route
              path="/pricing"
              element={
                <ProtectedRoute anyPermission={["pricing.manageInvoiceReference", "pricing.managePI"]}>
                  <Pricing />
                </ProtectedRoute>
              }
            />
            <Route
              path="/stock-lookup"
              element={
                <ProtectedRoute permission="inventory.viewStockFull">
                  <StockLookup />
                </ProtectedRoute>
              }
            />
            <Route
              path="/stock-transfer"
              element={
                <ProtectedRoute permission="inventory.transferStock">
                  <StockTransfer />
                </ProtectedRoute>
              }
            />
            <Route
              path="/put-backs"
              element={
                <ProtectedRoute permission="inventory.scanPutaway">
                  <PutBacks />
                </ProtectedRoute>
              }
            />
            <Route
              path="/settings"
              element={
                <ProtectedRoute permission="admin.configureSettings">
                  <SettingsPage />
                </ProtectedRoute>
              }
            />
            <Route path="/reports" element={<Reports />} />
            <Route path="/security" element={<Security />} />
            <Route
              path="/my-tasks"
              element={
                <ProtectedRoute anyPermission={["inventory.scanPutaway", "inventory.logInwardEntry"]}>
                  <MyTasks />
                </ProtectedRoute>
              }
            />
            <Route
              path="/users"
              element={
                <ProtectedRoute roles={["OWNER"]}>
                  <Users />
                </ProtectedRoute>
              }
            />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}
