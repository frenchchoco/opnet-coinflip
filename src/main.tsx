import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { WalletConnectProvider } from '@btc-vision/walletconnect';
import App from './App';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <WalletConnectProvider theme="dark">
        <App />
      </WalletConnectProvider>
    </BrowserRouter>
  </StrictMode>
);
