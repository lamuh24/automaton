import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { evaluateEarningsGate, type VerifiedEarning } from "../src/opportunities/earnings-gate.js";

type Asset = "BTC" | "ETH" | "SOL" | "AAPL" | "MSFT" | "TSLA";
type Side = "buy" | "sell";

interface Position { quantity: number; costBasisUsd: number; }
interface Trade {
  id: string;
  simulated: true;
  timestamp: string;
  side: Side;
  asset: Asset;
  quantity: number;
  priceUsd: number;
  notionalUsd: number;
  feeUsd: number;
  rationale: string;
}
interface Portfolio {
  schemaVersion: 1;
  mode: "paper-learning-only";
  baseCurrency: "USD";
  startingCashUsd: number;
  cashUsd: number;
  positions: Partial<Record<Asset, Position>>;
  riskLimits: {
    maxSingleTradeUsd: number;
    maxAssetAllocationPct: number;
    maxTotalExposurePct: number;
    maxTradesPerDay: number;
    feeRateBps: number;
    allowLeverage: false;
    allowShorting: false;
  };
  performance: { equityUsd: number; realizedPnlUsd: number; unrealizedPnlUsd: number; };
  disclaimer: string;
  lastUpdated: string;
}

const root = process.env.AUTOMATON_PAPER_TRADING_ROOT || path.join(os.homedir(), ".automaton", "paper-trading");
const portfolioPath = path.join(root, "portfolio.json");
const tradesPath = path.join(root, "trades.jsonl");
const rationalePath = path.join(root, "rationale.jsonl");
const snapshotPath = path.join(root, "market-snapshot.json");
const historyPath = path.join(root, "portfolio-history.jsonl");
const opportunityRoot = process.env.AUTOMATON_OPPORTUNITY_ROOT || path.join(os.homedir(), ".automaton", "opportunity-first");
const earningsPath = path.join(opportunityRoot, "earnings.jsonl");
const assets: Asset[] = ["BTC", "ETH", "SOL", "AAPL", "MSFT", "TSLA"];
const cryptoAssets: Asset[] = ["BTC", "ETH", "SOL"];
const stockAssets: Asset[] = ["AAPL", "MSFT", "TSLA"];
const pairs: Record<"BTC" | "ETH" | "SOL", string> = { BTC: "XXBTZUSD", ETH: "XETHZUSD", SOL: "SOLUSD" };
const marketUrl = "https://api.kraken.com/0/public/Ticker?pair=XBTUSD,ETHUSD,SOLUSD";
const disclaimer = "Educational paper-trading simulation only. No real-money orders, exchange accounts, API keys, transfers, leverage, shorting, or financial advice.";

function writeJson(filePath: string, value: unknown): void {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
}

function ensureInitialized(): Portfolio {
  if (!fs.existsSync(portfolioPath)) throw new Error("Paper portfolio is not initialized. Run: paper-trading initialize");
  return readJson<Portfolio>(portfolioPath);
}

function initialPortfolio(): Portfolio {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    mode: "paper-learning-only",
    baseCurrency: "USD",
    startingCashUsd: 10_000,
    cashUsd: 10_000,
    positions: {},
    riskLimits: {
      maxSingleTradeUsd: 2_000,
      maxAssetAllocationPct: 20,
      maxTotalExposurePct: 40,
      maxTradesPerDay: 3,
      feeRateBps: 10,
      allowLeverage: false,
      allowShorting: false,
    },
    performance: { equityUsd: 10_000, realizedPnlUsd: 0, unrealizedPnlUsd: 0 },
    disclaimer,
    lastUpdated: now,
  };
}

async function refreshMarket(): Promise<Record<Asset, number>> {
  const response = await fetch(marketUrl, { method: "GET", signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`Public market-data request failed (${response.status})`);
  const payload = await response.json() as { error?: string[]; result?: Record<string, { c?: string[] }> };
  if (payload.error?.length) throw new Error(`Public market-data source returned: ${payload.error.join(", ")}`);
  const cryptoPrices = Object.fromEntries(cryptoAssets.map((asset) => {
    const price = Number(payload.result?.[pairs[asset]]?.c?.[0]);
    if (!Number.isFinite(price) || price <= 0) throw new Error(`Missing public price for ${asset}`);
    return [asset, price];
  })) as Record<"BTC" | "ETH" | "SOL", number>;
  const stockResults = await Promise.all(stockAssets.map(async (asset) => {
    const stockResponse = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${asset}?interval=1d&range=1d`, { method: "GET", signal: AbortSignal.timeout(20_000) });
    if (!stockResponse.ok) throw new Error(`Public stock-data request failed for ${asset} (${stockResponse.status})`);
    const stockPayload = await stockResponse.json() as { chart?: { result?: Array<{ meta?: { regularMarketPrice?: number } }> } };
    const price = stockPayload.chart?.result?.[0]?.meta?.regularMarketPrice;
    if (!Number.isFinite(price) || !price || price <= 0) throw new Error(`Missing public stock price for ${asset}`);
    return [asset, price] as const;
  }));
  const prices = { ...cryptoPrices, ...Object.fromEntries(stockResults) } as Record<Asset, number>;
  writeJson(snapshotPath, {
    source: "Kraken Spot REST public ticker + Yahoo Finance public chart endpoints (read-only; no account or API key)",
    endpoints: [marketUrl, ...stockAssets.map((asset) => `https://query1.finance.yahoo.com/v8/finance/chart/${asset}?interval=1d&range=1d`)],
    fetchedAt: new Date().toISOString(),
    pricesUsd: prices,
    disclaimer,
  });
  return prices;
}

function readTrades(): Trade[] {
  if (!fs.existsSync(tradesPath)) return [];
  return fs.readFileSync(tradesPath, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as Trade);
}

function enforceOpportunityFirstGate(): void {
  const earnings: VerifiedEarning[] = fs.existsSync(earningsPath)
    ? fs.readFileSync(earningsPath, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as VerifiedEarning)
    : [];
  const gate = evaluateEarningsGate(earnings);
  if (!gate.cryptoResearchUnlocked) {
    throw new Error(
      "Trading is locked by opportunity-first policy. Record at least $20 in creator-verified non-trading earnings on each of the last 7 days, then provide the separate creator approval phrase. See OPPORTUNITY_FIRST.md.",
    );
  }
}

function writeTrade(trade: Trade): void {
  fs.appendFileSync(tradesPath, `${JSON.stringify(trade)}\n`, "utf8");
}

function updatePerformance(portfolio: Portfolio, prices: Record<Asset, number>): void {
  let marketValue = 0;
  let unrealized = 0;
  for (const asset of assets) {
    const position = portfolio.positions[asset];
    if (!position) continue;
    const value = position.quantity * prices[asset];
    marketValue += value;
    unrealized += value - position.costBasisUsd;
  }
  portfolio.performance.equityUsd = portfolio.cashUsd + marketValue;
  portfolio.performance.unrealizedPnlUsd = unrealized;
}

function recordHistory(portfolio: Portfolio, prices: Record<Asset, number>, event: "initialize" | "snapshot" | "trade"): void {
  fs.appendFileSync(historyPath, `${JSON.stringify({
    timestamp: new Date().toISOString(),
    event,
    cashUsd: portfolio.cashUsd,
    equityUsd: portfolio.performance.equityUsd,
    realizedPnlUsd: portfolio.performance.realizedPnlUsd,
    unrealizedPnlUsd: portfolio.performance.unrealizedPnlUsd,
    pricesUsd: prices,
  })}\n`, "utf8");
}

function parseAsset(value: string | undefined): Asset {
  const asset = value?.toUpperCase() as Asset;
  if (!assets.includes(asset)) throw new Error("Asset must be BTC, ETH, SOL, AAPL, MSFT, or TSLA");
  return asset;
}

async function simulateTrade(side: Side, asset: Asset, amount: number, rationale: string): Promise<void> {
  enforceOpportunityFirstGate();
  if (!rationale.trim()) throw new Error("A written rationale is required for every simulated trade");
  const portfolio = ensureInitialized();
  const prices = await refreshMarket();
  const trades = readTrades();
  const today = new Date().toISOString().slice(0, 10);
  if (trades.filter((trade) => trade.timestamp.startsWith(today)).length >= portfolio.riskLimits.maxTradesPerDay) {
    throw new Error("Daily simulated trade limit reached");
  }
  const priceUsd = prices[asset];
  const feeRate = portfolio.riskLimits.feeRateBps / 10_000;
  let quantity: number;
  let notionalUsd: number;
  if (side === "buy") {
    notionalUsd = amount;
    if (!Number.isFinite(notionalUsd) || notionalUsd <= 0 || notionalUsd > portfolio.riskLimits.maxSingleTradeUsd) {
      throw new Error("Simulated buy amount exceeds the paper risk limit");
    }
    const feeUsd = notionalUsd * feeRate;
    if (notionalUsd + feeUsd > portfolio.cashUsd) throw new Error("Insufficient virtual cash");
    const existing = portfolio.positions[asset];
    const newValue = (existing?.quantity || 0) * priceUsd + notionalUsd;
    if (newValue > portfolio.performance.equityUsd * (portfolio.riskLimits.maxAssetAllocationPct / 100)) {
      throw new Error("Simulated buy exceeds the per-asset allocation limit");
    }
    const currentExposure = portfolio.performance.equityUsd - portfolio.cashUsd;
    if (currentExposure + notionalUsd > portfolio.performance.equityUsd * (portfolio.riskLimits.maxTotalExposurePct / 100)) {
      throw new Error("Simulated buy exceeds the total exposure limit");
    }
    quantity = notionalUsd / priceUsd;
    portfolio.cashUsd -= notionalUsd + feeUsd;
    portfolio.positions[asset] = {
      quantity: (existing?.quantity || 0) + quantity,
      costBasisUsd: (existing?.costBasisUsd || 0) + notionalUsd + feeUsd,
    };
    const trade: Trade = { id: randomUUID(), simulated: true, timestamp: new Date().toISOString(), side, asset, quantity, priceUsd, notionalUsd, feeUsd, rationale: rationale.trim() };
    writeTrade(trade);
  } else {
    quantity = amount;
    const existing = portfolio.positions[asset];
    if (!existing || !Number.isFinite(quantity) || quantity <= 0 || quantity > existing.quantity) throw new Error("Cannot short or sell more than the virtual position");
    notionalUsd = quantity * priceUsd;
    const feeUsd = notionalUsd * feeRate;
    const costSold = existing.costBasisUsd * (quantity / existing.quantity);
    portfolio.cashUsd += notionalUsd - feeUsd;
    portfolio.performance.realizedPnlUsd += notionalUsd - feeUsd - costSold;
    existing.quantity -= quantity;
    existing.costBasisUsd -= costSold;
    if (existing.quantity < 1e-12) delete portfolio.positions[asset];
    const trade: Trade = { id: randomUUID(), simulated: true, timestamp: new Date().toISOString(), side, asset, quantity, priceUsd, notionalUsd, feeUsd, rationale: rationale.trim() };
    writeTrade(trade);
  }
  updatePerformance(portfolio, prices);
  portfolio.lastUpdated = new Date().toISOString();
  writeJson(portfolioPath, portfolio);
  recordHistory(portfolio, prices, "trade");
  console.log(JSON.stringify({ mode: portfolio.mode, simulated: true, portfolio }, null, 2));
}

async function main(): Promise<void> {
  const [command, assetArg, amountArg, ...rationaleParts] = process.argv.slice(2);
  fs.mkdirSync(root, { recursive: true });
  if (command === "initialize") {
    if (fs.existsSync(portfolioPath)) throw new Error(`Paper portfolio already exists at ${portfolioPath}`);
    const portfolio = initialPortfolio();
    writeJson(portfolioPath, portfolio);
    fs.writeFileSync(tradesPath, "", "utf8");
    fs.writeFileSync(historyPath, "", "utf8");
    fs.appendFileSync(rationalePath, `${JSON.stringify({ timestamp: portfolio.lastUpdated, event: "initialize", rationale: "Observe public market data before making any simulated allocation.", disclaimer })}\n`, "utf8");
    const prices = await refreshMarket();
    updatePerformance(portfolio, prices);
    writeJson(portfolioPath, portfolio);
    recordHistory(portfolio, prices, "initialize");
    console.log(JSON.stringify({ status: "initialized", root, portfolio, pricesUsd: prices }, null, 2));
    return;
  }
  if (command === "snapshot") {
    const portfolio = ensureInitialized();
    const prices = await refreshMarket();
    updatePerformance(portfolio, prices);
    portfolio.lastUpdated = new Date().toISOString();
    writeJson(portfolioPath, portfolio);
    recordHistory(portfolio, prices, "snapshot");
    console.log(JSON.stringify({ status: "snapshotted", portfolio, pricesUsd: prices }, null, 2));
    return;
  }
  if (command === "status") {
    const portfolio = ensureInitialized();
    const snapshot = fs.existsSync(snapshotPath) ? readJson(snapshotPath) : null;
    console.log(JSON.stringify({ root, portfolio, tradeCount: readTrades().length, marketSnapshot: snapshot }, null, 2));
    return;
  }
  if (command === "simulate-buy" || command === "simulate-sell") {
    await simulateTrade(command === "simulate-buy" ? "buy" : "sell", parseAsset(assetArg), Number(amountArg), rationaleParts.join(" "));
    return;
  }
  throw new Error("Usage: paper-trading initialize | snapshot | status | simulate-buy BTC 100 \"rationale\" | simulate-sell AAPL 1 \"rationale\"");
}

main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
