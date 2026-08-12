import { env } from "../config/env.js";
import * as birdeye from "./birdeye.js";
import * as geckoterminal from "./geckoterminal.js";
import type { OhlcvCandle, TokenOverview, TopTradedToken } from "./types.js";

/**
 * The active price/OHLCV data provider, selected by PRICE_PROVIDER. Every
 * other module imports these four functions from here, never directly from
 * birdeye.ts or geckoterminal.ts, so switching providers is a one-line env
 * change rather than a code change.
 */
const provider = env.PRICE_PROVIDER === "geckoterminal" ? geckoterminal : birdeye;

export const getOhlcv: (address: string, swingLookbackHours: number, timeFrom: number, timeTo: number) => Promise<OhlcvCandle[]> =
  provider.getOhlcv;
export const getTokenOverview: (address: string) => Promise<TokenOverview> = provider.getTokenOverview;
export const getMultiPrice: (addresses: string[]) => Promise<Map<string, number>> = provider.getMultiPrice;
export const getTopTradedTokens: (count: number, minLiquidityUsd: number, minTokenAgeHours: number) => Promise<TopTradedToken[]> =
  provider.getTopTradedTokens;
