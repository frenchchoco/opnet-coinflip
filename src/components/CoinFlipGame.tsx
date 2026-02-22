import React, { useState, useEffect, useCallback } from 'react';
import { useWalletContext } from '../contexts/WalletContext';
import { getBlockHeight, getExplorerUrl } from '../services/opnetProvider';
import { flipCoin, getPlayerStats, getGlobalStats, type FlipResult, type PlayerStats, type GlobalStats } from '../services/coinflipService';
import { getDefaultFeeRate } from '../services/feeService';
import './CoinFlipGame.css';

type CoinSide = 'heads' | 'tails';
type GamePhase = 'idle' | 'flipping' | 'result';

interface GameResult {
  won: boolean;
  choice: CoinSide;
  result: CoinSide;
  blockHeight: number;
  txId: string;
}

export const CoinFlipGame: React.FC = () => {
  const { isConnected, addressObject, taprootAddress, getSigner, address, connectToWallet, availableWallets, disconnect } = useWalletContext();

  const [choice, setChoice] = useState<CoinSide | null>(null);
  const [gamePhase, setGamePhase] = useState<GamePhase>('idle');
  const [gameResult, setGameResult] = useState<GameResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [flipAngle, setFlipAngle] = useState(0);
  const [gameHistory, setGameHistory] = useState<GameResult[]>([]);
  const [currentBlock, setCurrentBlock] = useState<number>(0);
  const [playerStats, setPlayerStats] = useState<PlayerStats>({ totalFlips: 0, totalWins: 0 });
  const [globalStats, setGlobalStats] = useState<GlobalStats>({ totalFlips: 0, totalHeads: 0, totalTails: 0 });

  // Load current block height
  useEffect(() => {
    const fetchBlock = async () => {
      try { setCurrentBlock(await getBlockHeight()); } catch { /* ignore */ }
    };
    fetchBlock();
    const interval = setInterval(fetchBlock, 30000);
    return () => clearInterval(interval);
  }, []);

  // Load player stats
  const loadStats = useCallback(async () => {
    if (addressObject) {
      const stats = await getPlayerStats(addressObject);
      setPlayerStats(stats);
    }
    const global = await getGlobalStats();
    setGlobalStats(global);
  }, [addressObject]);

  useEffect(() => { loadStats(); }, [loadStats]);

  // === THE FLIP ===
  const handleFlip = async () => {
    setError(null); setGameResult(null);

    if (!isConnected || !addressObject) { setError('Connect your wallet first'); return; }
    if (!choice) { setError('Pick Heads or Tails!'); return; }

    setGamePhase('flipping');

    // Animate coin flip
    const flipDuration = 2500;
    const startTime = Date.now();
    const animateFlip = () => {
      const elapsed = Date.now() - startTime;
      if (elapsed < flipDuration) {
        setFlipAngle(prev => prev + 25);
        requestAnimationFrame(animateFlip);
      }
    };
    requestAnimationFrame(animateFlip);

    try {
      const signer = getSigner();
      const userAddr = taprootAddress || address || '';

      const result: FlipResult = await flipCoin(
        choice, signer, userAddr, addressObject, getDefaultFeeRate()
      );

      // Wait for flip animation to finish
      const remaining = flipDuration - (Date.now() - startTime);
      if (remaining > 0) await new Promise(r => setTimeout(r, remaining));

      if (!result.success) {
        setError(result.error || 'Transaction failed');
        setGamePhase('idle');
        return;
      }

      const gameRes: GameResult = {
        won: result.won!,
        choice,
        result: result.coinResult!,
        blockHeight: result.blockHeight!,
        txId: result.txId!,
      };

      setGameResult(gameRes);
      setGamePhase('result');
      setGameHistory(prev => [gameRes, ...prev].slice(0, 10));

      // Refresh stats
      setTimeout(() => loadStats(), 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Transaction failed');
      setGamePhase('idle');
    }
  };

  const resetGame = () => {
    setGamePhase('idle'); setGameResult(null); setChoice(null); setError(null);
  };

  const sessionWins = gameHistory.filter(g => g.won).length;
  const sessionLosses = gameHistory.length - sessionWins;

  return (
    <div className="game-container">
      {/* Header */}
      <div className="game-header">
        <div className="game-badge">Bitcoin L1 Smart Contract Game</div>
        <h1 className="game-title">Coin <span className="gradient-text">Flip</span></h1>
        <p className="game-subtitle">Flip a coin on-chain. Your choice is sent to a real OPNet smart contract via OP_WALLET. Block parity decides the outcome.</p>
        {currentBlock > 0 && <div className="block-ticker">Block #{currentBlock.toLocaleString()}</div>}
      </div>

      {/* Global Stats */}
      {globalStats.totalFlips > 0 && (
        <div className="game-card stats-card">
          <div className="card-label">Global Stats (On-Chain)</div>
          <div className="stats-row">
            <div className="stat-item"><span className="stat-value">{globalStats.totalFlips}</span><span className="stat-label">Total Flips</span></div>
            <div className="stat-item"><span className="stat-value">{globalStats.totalHeads}</span><span className="stat-label">Heads</span></div>
            <div className="stat-item"><span className="stat-value">{globalStats.totalTails}</span><span className="stat-label">Tails</span></div>
          </div>
        </div>
      )}

      {/* Player Stats */}
      {isConnected && playerStats.totalFlips > 0 && (
        <div className="game-card stats-card">
          <div className="card-label">Your On-Chain Stats</div>
          <div className="stats-row">
            <div className="stat-item"><span className="stat-value">{playerStats.totalFlips}</span><span className="stat-label">Flips</span></div>
            <div className="stat-item"><span className="stat-value">{playerStats.totalWins}</span><span className="stat-label">Wins</span></div>
            <div className="stat-item"><span className="stat-value">{playerStats.totalFlips > 0 ? Math.round((playerStats.totalWins / playerStats.totalFlips) * 100) : 0}%</span><span className="stat-label">Win Rate</span></div>
          </div>
        </div>
      )}

      {/* Game Area */}
      <div className="game-card game-area">
        {/* Coin */}
        <div className="coin-stage">
          <div className={`coin ${gamePhase === 'flipping' ? 'spinning' : ''} ${gameResult ? (gameResult.result === 'heads' ? 'show-heads' : 'show-tails') : ''}`}
            style={gamePhase === 'flipping' ? { transform: `rotateY(${flipAngle}deg)` } : undefined}>
            <div className="coin-face coin-heads">H</div>
            <div className="coin-face coin-tails">T</div>
          </div>
          {gameResult && (
            <div className={`result-banner ${gameResult.won ? 'win' : 'lose'}`}>
              {gameResult.won ? 'YOU WIN!' : 'YOU LOSE'}
            </div>
          )}
        </div>

        {/* Pick Side */}
        {gamePhase !== 'result' && (
          <div className="pick-section">
            <div className="card-label">Pick Your Side</div>
            <div className="side-buttons">
              <button className={`side-btn ${choice === 'heads' ? 'active heads' : ''}`}
                onClick={() => { setChoice('heads'); setError(null); }}
                disabled={gamePhase === 'flipping'}>
                <span className="side-icon">H</span>
                <span>Heads</span>
                <span className="side-hint">Even block</span>
              </button>
              <button className={`side-btn ${choice === 'tails' ? 'active tails' : ''}`}
                onClick={() => { setChoice('tails'); setError(null); }}
                disabled={gamePhase === 'flipping'}>
                <span className="side-icon">T</span>
                <span>Tails</span>
                <span className="side-hint">Odd block</span>
              </button>
            </div>
          </div>
        )}

        {/* Result Details */}
        {gameResult && (
          <div className="result-details">
            <div className="result-row"><span>Your pick</span><span className="result-val">{gameResult.choice === 'heads' ? 'Heads (even)' : 'Tails (odd)'}</span></div>
            <div className="result-row"><span>Block #{gameResult.blockHeight}</span><span className="result-val">{gameResult.result === 'heads' ? 'Heads (even)' : 'Tails (odd)'}</span></div>
            <div className="result-row">
              <span>Transaction</span>
              <a className="result-val tx-link" href={getExplorerUrl(gameResult.txId)} target="_blank" rel="noopener noreferrer">
                {gameResult.txId.slice(0, 10)}...{gameResult.txId.slice(-6)}
              </a>
            </div>
          </div>
        )}

        {/* Error */}
        {error && <div className="game-error">{error}</div>}

        {/* Action Buttons */}
        <div className="action-area">
          {!isConnected ? (
            <div className="wallet-connect-section">
              <div className="card-label">Connect Wallet to Play</div>
              <div className="wallet-buttons">
                {availableWallets.filter(w => w.isInstalled).map(w => (
                  <button key={w.name} className="game-btn connect" onClick={() => connectToWallet(w.name)}>
                    {w.name === 'OP_WALLET' ? 'OP_WALLET' : w.name === 'UNISAT' ? 'UniSat' : w.name}
                  </button>
                ))}
                {availableWallets.filter(w => w.isInstalled).length === 0 && (
                  <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', textAlign: 'center' }}>
                    No compatible wallet detected. Install <a href="https://opwallet.org" target="_blank" rel="noopener noreferrer">OP_WALLET</a> or <a href="https://unisat.io" target="_blank" rel="noopener noreferrer">UniSat</a>.
                  </p>
                )}
              </div>
            </div>
          ) : gamePhase === 'result' ? (
            <button className="game-btn primary" onClick={resetGame}>Play Again</button>
          ) : (
            <button className="game-btn primary" disabled={gamePhase === 'flipping' || !choice}
              onClick={handleFlip}>
              {gamePhase === 'flipping' ? <><div className="spinner-small white" /> Flipping...</> : 'Flip!'}
            </button>
          )}
        </div>
      </div>

      {/* Session History */}
      {gameHistory.length > 0 && (
        <div className="game-card history-card">
          <div className="history-header">
            <h3>Session History</h3>
            <div className="score">
              <span className="score-win">{sessionWins}W</span> / <span className="score-lose">{sessionLosses}L</span>
            </div>
          </div>
          <div className="history-list">
            {gameHistory.map((g, i) => (
              <div key={i} className={`history-item ${g.won ? 'win' : 'lose'}`}>
                <span className="history-result">{g.won ? 'W' : 'L'}</span>
                <span className="history-detail">
                  Picked {g.choice}, got {g.result} (block #{g.blockHeight})
                </span>
                <a className="history-tx" href={getExplorerUrl(g.txId)} target="_blank" rel="noopener noreferrer">
                  tx
                </a>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* How It Works */}
      <div className="game-card info-card">
        <h3>How It Works</h3>
        <div className="info-steps">
          <div className="info-step"><div className="info-step-num">1</div><div><strong>Connect OP_WALLET</strong> — Your Bitcoin wallet signs all transactions</div></div>
          <div className="info-step"><div className="info-step-num">2</div><div><strong>Pick Heads or Tails</strong> — Even block = Heads, Odd block = Tails</div></div>
          <div className="info-step"><div className="info-step-num">3</div><div><strong>Flip!</strong> — A real <code>flip()</code> call is sent to the CoinFlip smart contract via OP_WALLET</div></div>
          <div className="info-step"><div className="info-step-num">4</div><div><strong>Result</strong> — The contract reads the Bitcoin block height and determines the outcome. Stats stored on-chain!</div></div>
        </div>
        <p className="disclaimer">This is a demo game. The CoinFlip smart contract runs on OPNet (Bitcoin L1). All interactions are real on-chain transactions.</p>
      </div>
    </div>
  );
};
