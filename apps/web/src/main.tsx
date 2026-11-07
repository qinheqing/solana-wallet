import { Buffer } from "buffer";
import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router-dom";

import "./index.css";
import { AppProvider } from "./lib/AppContext";
import { Layout } from "./components/Layout";
import { DashboardPage } from "./modules/dashboard/DashboardPage";
import { WalletPage } from "./modules/wallet/WalletPage";
import { TransferPage } from "./modules/transfer/TransferPage";
import { TokenPage } from "./modules/token/TokenPage";
import { MultisigPage } from "./modules/multisig/MultisigPage";

// @solana/web3.js expects a Node-like Buffer global in the browser.
(globalThis as unknown as { Buffer: typeof Buffer }).Buffer ??= Buffer;

export const WEB_VERSION = "0.1.0";

const root = document.getElementById("root");
if (!root) throw new Error("#root element not found");

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <AppProvider>
      <BrowserRouter>
        <Routes>
          <Route element={<Layout />}>
            <Route index element={<DashboardPage />} />
            <Route path="/wallet" element={<WalletPage />} />
            <Route path="/transfer" element={<TransferPage />} />
            <Route path="/token" element={<TokenPage />} />
            <Route path="/multisig" element={<MultisigPage />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </AppProvider>
  </React.StrictMode>,
);
