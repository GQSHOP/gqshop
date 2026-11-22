import { Navigate, Route, Routes } from "react-router-dom";

import { hasAdminSession } from "./api.js";
import Layout from "./Layout.js";
import Aftersale from "./pages/Aftersale.js";
import Blog from "./pages/Blog.js";
import Dashboard from "./pages/Dashboard.js";
import Discount from "./pages/Discount.js";
import Goods from "./pages/Goods.js";
import Groups from "./pages/Groups.js";
import Templates from "./pages/Templates.js";
import Plugins from "./pages/Plugins.js";
import Physical from "./pages/Physical.js";
import Stock from "./pages/Stock.js";
import Stations from "./pages/Stations.js";
import Orders from "./pages/Orders.js";
import Login from "./pages/Login.js";

function RequireKey({ children }: { children: React.ReactNode }) {
  if (!hasAdminSession()) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route
        path="/"
        element={
          <RequireKey>
            <Layout />
          </RequireKey>
        }
      >
        <Route index element={<Dashboard />} />
        <Route path="goods" element={<Goods />} />
        <Route path="discount" element={<Discount />} />
        <Route path="stock" element={<Stock />} />
        <Route path="orders" element={<Orders />} />
        <Route path="aftersale" element={<Aftersale />} />
        <Route path="stations" element={<Stations />} />
        <Route path="physical" element={<Physical />} />
        <Route path="blog" element={<Blog />} />
        <Route path="groups" element={<Groups />} />
        <Route path="templates" element={<Templates />} />
        <Route path="plugins" element={<Plugins />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
