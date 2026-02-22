import { createContext, useContext, type ReactNode } from 'react';
import { useWallet, type WalletState } from '../hooks/useWallet';

const WalletContext = createContext<WalletState | null>(null);

export const WalletContextProvider = ({ children }: { children: ReactNode }) => (
  <WalletContext.Provider value={useWallet()}>{children}</WalletContext.Provider>
);

export const useWalletContext = () => {
  const context = useContext(WalletContext);
  if (!context) throw new Error('useWalletContext must be used within a WalletContextProvider');
  return context;
};

/** Optional wallet context — returns null if outside WalletContextProvider (e.g. public pages) */
export const useOptionalWalletContext = (): WalletState | null => useContext(WalletContext);
