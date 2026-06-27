import { useCallback, useEffect, useMemo, useState } from "react";
import EmberCanvas from "./components/EmberCanvas.jsx";
import TopBar from "./components/TopBar.jsx";
import MarketStrip from "./components/MarketStrip.jsx";
import Chart from "./components/Chart.jsx";
import PositionsTable from "./components/PositionsTable.jsx";
import OrdersTable from "./components/OrdersTable.jsx";
import VaultPanel from "./components/VaultPanel.jsx";
import OrderTicket from "./components/OrderTicket.jsx";
import FaucetModal from "./components/FaucetModal.jsx";
import TpSlModal from "./components/TpSlModal.jsx";
import TradeStatus from "./components/TradeStatus.jsx";
import { useWallet } from "./hooks/useWallet.js";
import { useTrade } from "./hooks/useTrade.js";
import { useMarkets } from "./hooks/useMarkets.js";
import { usePrices } from "./hooks/usePrices.js";
import { useLiveFeed } from "./hooks/useLiveFeed.js";
import { useVault } from "./hooks/useVault.js";
import { usePositions } from "./hooks/usePositions.js";
import { useOrders } from "./hooks/useOrders.js";
import { useBalances } from "./hooks/useBalances.js";
import { useRpcHealth } from "./hooks/useRpcHealth.js";
import { addressesConfigured } from "./config.js";
import { liqPrice } from "./lib/engine.js";

export default function App() {
  const wallet = useWallet();
  const { account, wrongChain } = wallet;
  const { supported, states, error: marketsError, loading: marketsLoading } = useMarkets();

  const supportedSymbols = useMemo(() => (supported ? supported.map((m) => m.symbol) : []), [supported]);
  const { marks, series, startedAt } = usePrices(supportedSymbols);
  // Fast DISPLAY feed (public exchanges, ~1.5s) — drives the shown price, the chart's
  // current price, and position PnL so they tick smoothly. RedStone `marks` stay the
  // labeled "mark · execution" reference (what trades actually settle against).
  const { live, source: liveSource } = useLiveFeed(supportedSymbols);
  const { data: vault, yourDeposit } = useVault(account);
  const { positions, refresh: refreshPositions } = usePositions(account, supported);
  const balances = useBalances(account);
  const rpcDegraded = useRpcHealth();

  const [selected, setSelected] = useState(null);
  const [tab, setTab] = useState("pos");
  const [modalOpen, setModalOpen] = useState(false);
  const [tpslFor, setTpslFor] = useState(null); // position getting a TP/SL, or null
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

  const orders = useOrders({ account, supported, toast: showToast });

  const onTraded = useCallback(() => {
    refreshPositions();
    balances.refresh();
    orders.refresh();
  }, [refreshPositions, balances, orders]);

  const trade = useTrade({
    account,
    getSigner: wallet.getSigner,
    wrongChain,
    toast: showToast,
    onTraded,
    addOrderId: orders.addOrderId,
    positions,
  });

  const meta = supported && selected ? supported.find((m) => m.symbol === selected) : null;
  const configured = addressesConfigured();

  // Chart overlays for the selected market: a liq line per open position (priced off the
  // live snapshot incl. accrued fees) and a trigger line per resting order. Kept as the
  // chart's liq/trigger overlays regardless of candle vs live-line fallback.
  const liqLines = useMemo(
    () =>
      (positions || [])
        .filter((p) => p.symbol === selected && p.sizeUsd > 0)
        .map((p) => ({
          price: liqPrice(
            { collateral: p.collateral, sizeUsd: p.sizeUsd, entryPrice: p.entryPrice, isLong: p.isLong },
            p.borrowFee,
            p.fundingOwed,
          ),
          label: `LIQ ${p.isLong ? "long" : "short"}`,
        }))
        .filter((l) => l.price > 0),
    [positions, selected],
  );
  const trigLines = useMemo(
    () =>
      (orders.orders || [])
        .filter((o) => o.symbol === selected && o.triggerPrice > 0)
        .map((o) => ({ price: o.triggerPrice, label: (o.typeLabel || "TRIGGER").toUpperCase() })),
    [orders.orders, selected],
  );

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
        onDisconnect={wallet.disconnect}
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
          <MarketStrip supported={supported} selected={selected} onSelect={setSelected} marks={marks} live={live} liveSource={liveSource} states={states} />

          <div className="grid">
            <div className="col-main">
              <Chart
                symbol={selected}
                series={series[selected]}
                mark={marks[selected]}
                live={live[selected]}
                liveSource={liveSource}
                startedAt={startedAt}
                liqLines={liqLines}
                trigLines={trigLines}
              />

              <div className="lower">
                <div className="tabs">
                  <button className={tab === "pos" ? "on" : ""} onClick={() => setTab("pos")}>
                    Positions <span className="count">{positions ? positions.length : account ? "…" : 0}</span>
                  </button>
                  <button className={tab === "orders" ? "on" : ""} onClick={() => setTab("orders")}>
                    Orders <span className="count">{orders.orders ? orders.orders.length : account ? "…" : 0}</span>
                  </button>
                  <button className={tab === "vault" ? "on" : ""} onClick={() => setTab("vault")}>
                    Liquidity vault
                  </button>
                </div>

                {tab === "pos" ? (
                  <PositionsTable
                    account={account}
                    positions={positions}
                    marks={marks}
                    live={live}
                    orders={orders.orders}
                    trade={trade}
                    wrongChain={wrongChain}
                    onAddTpSl={setTpslFor}
                  />
                ) : tab === "orders" ? (
                  <OrdersTable account={account} orders={orders.orders} readiness={orders.readiness} trade={trade} wrongChain={wrongChain} />
                ) : (
                  <VaultPanel vault={vault} yourDeposit={yourDeposit} account={account} />
                )}
              </div>
            </div>

            <OrderTicket
              meta={meta}
              mark={marks[selected]}
              state={states[selected]}
              musdBalance={balances.musd}
              nativeBalance={balances.native}
              positions={positions}
              orders={orders.orders}
              trade={trade}
              account={account}
              wrongChain={wrongChain}
              onConnect={wallet.connect}
              onSwitch={wallet.switchChain}
              onFaucet={() => setModalOpen(true)}
            />
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

      {tpslFor && <TpSlModal position={tpslFor} mark={marks[tpslFor.symbol] && !marks[tpslFor.symbol].error ? marks[tpslFor.symbol].price : null} trade={trade} onClose={() => setTpslFor(null)} />}

      <TradeStatus
        flow={trade.flow}
        cancelDelay={trade.CANCEL_DELAY}
        onExecute={trade.executeNow}
        onCancel={trade.cancelPending}
        onDismiss={trade.dismiss}
      />

      {rpcDegraded && (
        <div className="rpc-reconnect" role="status" aria-live="polite" title="The RPC is throttling — retrying. Showing the last good data.">
          <span className="dot" aria-hidden="true" />
          reconnecting…
        </div>
      )}

      <div className={"toast" + (toast.show ? " show" : "") + (toast.err ? " err" : "")}>{toast.msg}</div>
      <div className="demo-tag">
        <b>TachyonFi</b> · live on LiteForge 4441
        {account && balances.native != null ? ` · ${balances.native.toFixed(3)} zkLTC` : ""}
      </div>
    </>
  );
}
