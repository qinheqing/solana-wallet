// Must stay the first import: installs the Buffer global before any
// module that touches it at top level is evaluated (see polyfills.ts).
import "./polyfills";
import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router-dom";

import "./index.css";
import { AppProvider } from "./lib/AppContext";
import { I18nProvider } from "./lib/i18n";
import { Layout } from "./components/Layout";
import { DashboardPage } from "./modules/dashboard/DashboardPage";
import { WalletPage } from "./modules/wallet/WalletPage";
import { TransferPage } from "./modules/transfer/TransferPage";
import { TokenPage } from "./modules/token/TokenPage";
import { MultisigPage } from "./modules/multisig/MultisigPage";
import { InspectPage } from "./modules/inspect/InspectPage";

export const WEB_VERSION = "0.1.0";

const root = document.getElementById("root");
if (!root) throw new Error("#root element not found");

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <I18nProvider>
      <AppProvider>
        <BrowserRouter>
          <Routes>
            <Route element={<Layout />}>
              <Route index element={<DashboardPage />} />
              <Route path="/wallet" element={<WalletPage />} />
              <Route path="/transfer" element={<TransferPage />} />
              <Route path="/token" element={<TokenPage />} />
              <Route path="/multisig" element={<MultisigPage />} />
              <Route path="/inspect" element={<InspectPage />} />
            </Route>
          </Routes>
        </BrowserRouter>
      </AppProvider>
    </I18nProvider>
  </React.StrictMode>,
);
