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
            <Route path="/orders" element={<OrdersList />} />
            <Route
              path="/orders/new"
              element={
                <ProtectedRoute roles={["OWNER", "SALES"]}>
                  <OrderNew />
                </ProtectedRoute>
              }
            />
            <Route path="/orders/:id" element={<OrderDetail />} />
            <Route
              path="/picking"
              element={
                <ProtectedRoute roles={["OWNER", "WAREHOUSE"]} allowScanAccess>
                  <Picking />
                </ProtectedRoute>
              }
            />
            <Route
              path="/picking/:orderId"
              element={
                <ProtectedRoute roles={["OWNER", "WAREHOUSE"]} allowScanAccess>
                  <PickingSession />
                </ProtectedRoute>
              }
            />
            <Route
              path="/receiving"
              element={
                <ProtectedRoute roles={["OWNER"]} allowScanAccess allowInwardEntryAccess>
                  <Receiving />
                </ProtectedRoute>
              }
            />
            <Route
              path="/pricing"
              element={
                <ProtectedRoute roles={["OWNER", "ACCOUNTANT"]}>
                  <Pricing />
                </ProtectedRoute>
              }
            />
            <Route path="/reports" element={<Reports />} />
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
