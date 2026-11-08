import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  type ReactNode,
} from "react";
import { Keypair } from "@solana/web3.js";
import {
  ClusterConnection,
  createConnection,
  decryptJson,
  encryptJson,
  parseKeypairJson,
  type EncryptedKeystoreV1,
} from "@solwallet/core";

import { genId, loadSettings, loadWallets, saveSettings, saveWallets } from "./storage";
import type { ClusterName, KeypairBytes, StoredWalletRecord } from "./types";

interface State {
  wallets: StoredWalletRecord[];
  cluster: ClusterName;
  customRpcUrl: string;
  currentWalletId: string | null;
  /** In-memory only — never persisted. */
  unlockedKeypair: Keypair | null;
  mainnetAck: boolean;
}

type Action =
  | { type: "SET_WALLETS"; wallets: StoredWalletRecord[] }
  | { type: "SET_CLUSTER"; cluster: ClusterName }
  | { type: "SET_CUSTOM_RPC"; url: string }
  | { type: "SET_CURRENT"; id: string | null }
  | { type: "UNLOCK"; keypair: Keypair | null }
  | { type: "SET_MAINNET_ACK"; ack: boolean };

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "SET_WALLETS":
      return { ...state, wallets: action.wallets };
    case "SET_CLUSTER":
      return { ...state, cluster: action.cluster, mainnetAck: false };
    case "SET_CUSTOM_RPC":
      return { ...state, customRpcUrl: action.url };
    case "SET_CURRENT":
      return { ...state, currentWalletId: action.id, unlockedKeypair: null };
    case "UNLOCK":
      return { ...state, unlockedKeypair: action.keypair };
    case "SET_MAINNET_ACK":
      return { ...state, mainnetAck: action.ack };
    default:
      return state;
  }
}

function init(): State {
  const settings = loadSettings();
  return {
    wallets: loadWallets(),
    cluster: settings.cluster,
    customRpcUrl: settings.customRpcUrl,
    currentWalletId: settings.currentWalletId,
    unlockedKeypair: null,
    mainnetAck: false,
  };
}

export interface AppApi {
  state: State;
  connection: ClusterConnection;
  currentWallet: StoredWalletRecord | null;
  setCluster: (cluster: ClusterName) => void;
  setCustomRpc: (url: string) => void;
  setMainnetAck: (ack: boolean) => void;
  addWallet: (name: string, keypair: Keypair, password?: string) => Promise<void>;
  removeWallet: (id: string) => void;
  selectWallet: (id: string | null) => void;
  /** Decrypt (if needed) and load the keypair for the given wallet into memory. */
  unlockWallet: (id: string, password?: string) => Promise<Keypair>;
  lock: () => void;
}

const AppCtx = createContext<AppApi | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, undefined, init);

  useEffect(() => {
    saveWallets(state.wallets);
  }, [state.wallets]);

  useEffect(() => {
    saveSettings({
      cluster: state.cluster,
      customRpcUrl: state.customRpcUrl,
      currentWalletId: state.currentWalletId,
    });
  }, [state.cluster, state.customRpcUrl, state.currentWalletId]);

  const connection = useMemo(() => {
    if (state.cluster === "localnet") {
      // Same-origin proxy (see vite.config.ts); websocket must be explicit
      // because web3.js would otherwise guess "port + 1".
      const origin = window.location.origin;
      return createConnection(`${origin}/rpc`, {
        allowMainnet: state.mainnetAck,
        wsEndpoint: `${origin.replace(/^http/, "ws")}/rpc-ws`,
      });
    }
    const target = state.cluster === "custom" ? state.customRpcUrl || "devnet" : state.cluster;
    try {
      return createConnection(target, { allowMainnet: state.mainnetAck });
    } catch {
      return createConnection("devnet");
    }
  }, [state.cluster, state.customRpcUrl, state.mainnetAck]);

  const currentWallet = useMemo(
    () => state.wallets.find((w) => w.id === state.currentWalletId) ?? null,
    [state.wallets, state.currentWalletId],
  );

  const addWallet = useCallback(
    async (name: string, keypair: Keypair, password?: string) => {
      const secretBytes = Array.from(keypair.secretKey) as KeypairBytes;
      let record: StoredWalletRecord;
      if (password) {
        const encrypted: EncryptedKeystoreV1 = await encryptJson(
          { secretKey: secretBytes },
          password,
        );
        record = {
          id: genId(),
          name,
          address: keypair.publicKey.toBase58(),
          createdAt: Date.now(),
          encrypted: true,
          payload: encrypted,
        };
      } else {
        record = {
          id: genId(),
          name,
          address: keypair.publicKey.toBase58(),
          createdAt: Date.now(),
          encrypted: false,
          payload: secretBytes,
        };
      }
      dispatch({ type: "SET_WALLETS", wallets: [...state.wallets, record] });
      dispatch({ type: "SET_CURRENT", id: record.id });
      dispatch({ type: "UNLOCK", keypair });
    },
    [state.wallets],
  );

  const removeWallet = useCallback(
    (id: string) => {
      dispatch({ type: "SET_WALLETS", wallets: state.wallets.filter((w) => w.id !== id) });
      if (state.currentWalletId === id) {
        dispatch({ type: "SET_CURRENT", id: null });
      }
    },
    [state.wallets, state.currentWalletId],
  );

  const selectWallet = useCallback((id: string | null) => {
    dispatch({ type: "SET_CURRENT", id });
  }, []);

  const unlockWallet = useCallback(
    async (id: string, password?: string): Promise<Keypair> => {
      const record = state.wallets.find((w) => w.id === id);
      if (!record) throw new Error("Wallet not found");
      let keypair: Keypair;
      if (record.encrypted) {
        if (!password) throw new Error("Password required for this wallet");
        const decrypted = await decryptJson<{ secretKey: KeypairBytes }>(
          record.payload as EncryptedKeystoreV1,
          password,
        );
        keypair = parseKeypairJson(decrypted.secretKey);
      } else {
        keypair = parseKeypairJson(record.payload as KeypairBytes);
      }
      dispatch({ type: "SET_CURRENT", id });
      dispatch({ type: "UNLOCK", keypair });
      return keypair;
    },
    [state.wallets],
  );

  const lock = useCallback(() => dispatch({ type: "UNLOCK", keypair: null }), []);

  const api: AppApi = {
    state,
    connection,
    currentWallet,
    setCluster: (cluster) => dispatch({ type: "SET_CLUSTER", cluster }),
    setCustomRpc: (url) => dispatch({ type: "SET_CUSTOM_RPC", url }),
    setMainnetAck: (ack) => dispatch({ type: "SET_MAINNET_ACK", ack }),
    addWallet,
    removeWallet,
    selectWallet,
    unlockWallet,
    lock,
  };

  return <AppCtx.Provider value={api}>{children}</AppCtx.Provider>;
}

export function useApp(): AppApi {
  const ctx = useContext(AppCtx);
  if (!ctx) throw new Error("useApp must be used within AppProvider");
  return ctx;
}
