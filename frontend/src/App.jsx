import { useCallback, useEffect, useMemo, useState } from "react";
import EmberCanvas from "./components/EmberCanvas.jsx";
import TopBar from "./components/TopBar.jsx";
import MarketStrip from "./components/MarketStrip.jsx";
import Chart from "./components/Chart.jsx";
import PositionsTable from "./components/PositionsTable.jsx";
import VaultPanel from "./components/VaultPanel.jsx";
import OrderTicket from "./components/OrderTicket.jsx";
import FaucetModal from "./components/FaucetModal.jsx";
import { useWallet } from "./hooks/useWallet.js";
import { useMarkets } from "./hooks/useMarkets.js";
import { usePrices } from "./hooks/usePrices.js";
import { useVault } from "./hooks/useVault.js";
import { usePositions } from "./hooks/usePositions.js";
import { useBalances } from "./hooks/useBalances.js";
import { addressesConfigured } from "./config.js";

export default function App() {
  const wallet = useWallet();
  const { account, wrongChain } = wallet;
  const { supported, states, error: marketsError, loading: marketsLoading } = useMarkets();

  const supportedSymbols = useMemo(() => (supported ? supported.map((m) => m.symbol) : []), [supported]);
  const { marks, series, startedAt } = usePrices(supportedSymbols);
  const { data: vault, yourDeposit } = useVault(account);
  const { positions } = usePositions(account, supported);
  const balances = useBalances(account);

  const [selected, setSelected] = useState(null);
  const [tab, setTab] = useState("pos");
  const [modalOpen, setModalOpen] = useState(false);
  const [toast, setToast] = useState({ msg: "", err: false, show: false });

  // Pick the first supported market once discovered; keep selection valid.
  useEffect(() => {
    if (!supported || !supported.length) return;
    if (!selected || !supported.some((m) => m.symbol === selected)) setSelected(supported[0].symbol);
  }, [supported, selected]);

  const showToast = useCallback((msg, err = false) => {
    setToast({ msg, err, show: true });
    setTimeout(() => setToast((t) => ({ ...t, show: false })), 2600);
  }, []);

  const meta = supported && selected ? supported.find((m) => m.symbol === selected) : null;
  const configured = addressesConfigured();

  return (
    <>
      <EmberCanvas />
      <div className="firebase" aria-hidden="true"></div>

      <TopBar
        account={account}
        wrongChain={wrongChain}
        connecting={wallet.connecting}
        hasWallet={wallet.hasWallet}
        onConnect={wallet.connect}
        onSwitch={wallet.switchChain}
        onFaucet={() => setModalOpen(true)}
      />

      {!configured && (
        <div className="banner err">
          Contract addresses are not set. Copy <code>.env.example</code> → <code>.env</code> and fill the VITE_ addresses.
        </div>
      )}
      {wrongChain && (
        <div className="banner warn">
          Wallet is on the wrong network. Switch to LiteForge (4441) to read your balances & positions.
          <button className="btn warnchain" onClick={wallet.switchChain}>
            Switch
          </button>
        </div>
      )}
      {marketsError && configured && <div className="banner err">Market read failed: {marketsError}</div>}

      {meta ? (
        <>
          <MarketStrip supported={supported} selected={selected} onSelect={setSelected} marks={marks} states={states} />

          <div className="grid">
            <div className="col-main">
              <Chart symbol={selected} series={series[selected]} mark={marks[selected]} startedAt={startedAt} />

              <div className="lower">
                <div className="tabs">
                  <button className={tab === "pos" ? "on" : ""} onClick={() => setTab("pos")}>
                    Positions <span className="count">{positions ? positions.length : account ? "…" : 0}</span>
                  </button>
                  <button className={tab === "vault" ? "on" : ""} onClick={() => setTab("vault")}>
                    Liquidity vault
                  </button>
                </div>

                {tab === "pos" ? (
                  <PositionsTable account={account} positions={positions} marks={marks} />
                ) : (
                  <VaultPanel vault={vault} yourDeposit={yourDeposit} account={account} />
                )}
              </div>
            </div>

            <OrderTicket meta={meta} mark={marks[selected]} state={states[selected]} musdBalance={balances.musd} />
          </div>
        </>
      ) : (
        <div className="banner">
          {marketsLoading ? "Discovering supported markets on chain 4441…" : "No supported markets found on-chain."}
        </div>
      )}

      <FaucetModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        account={account}
        hasWallet={wallet.hasWallet}
        wrongChain={wrongChain}
        connecting={wallet.connecting}
        onConnect={wallet.connect}
        onSwitch={wallet.switchChain}
        faucetAvailableAt={balances.faucetAvailableAt}
        getSigner={wallet.getSigner}
        onClaimed={balances.refresh}
        toast={showToast}
      />

      <div className={"toast" + (toast.show ? " show" : "") + (toast.err ? " err" : "")}>{toast.msg}</div>
      <div className="demo-tag">
        Read-only · <b>TachyonFi</b> · live on LiteForge 4441
        {account && balances.native != null ? ` · ${balances.native.toFixed(3)} zkLTC` : ""}
      </div>
    </>
  );
}
