import { WalletContextProvider } from './contexts/WalletContext';
import { CoinFlipGame } from './components/CoinFlipGame';
import './styles/global.css';

function App() {
  return (
    <WalletContextProvider>
      <div className="app">
        <CoinFlipGame />
      </div>
    </WalletContextProvider>
  );
}

export default App;
