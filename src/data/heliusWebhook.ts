import { env } from "../config/env.js";
import { createKeyedSerializer } from "../utils/async.js";

const BASE_URL = "https://api.helius.xyz/v0";

// Keyed by webhookId -- addAddressToWebhook/removeAddressFromWebhook each
// do a read-then-full-replace against Helius's webhook config with no
// server-side locking, so two near-simultaneous calls for the SAME webhook
// could otherwise both read the same pre-update address list and the
// second PUT would silently overwrite the first's change. Serializing the
// whole read-modify-write per webhookId closes that race.
const serializeWebhookUpdate = createKeyedSerializer<string>();

/**
 * Shape of Helius's webhook object, per their public docs. Unverified from
 * this sandbox (no live network access here) -- same caveat as the
 * enhanced-transaction webhook payload in tail/webhook.ts. If a real PUT
 * call fails with an unexpected 4xx, the response body is included in the
 * thrown error to make that debuggable without guessing.
 */
export interface HeliusWebhookConfig {
  webhookID: string;
  webhookURL: string;
  transactionTypes: string[];
  accountAddresses: string[];
  webhookType: string;
  authHeader?: string;
  txnStatus?: string;
}

export async function getWebhook(webhookId: string): Promise<HeliusWebhookConfig> {
  if (!env.HELIUS_API_KEY) throw new Error("HELIUS_API_KEY is not set");

  const url = `${BASE_URL}/webhooks/${webhookId}?api-key=${env.HELIUS_API_KEY}`;
  const res = await fetch(url);
  const body = await res.json().catch(() => undefined);
  if (!res.ok) throw new Error(`Helius getWebhook failed (${res.status}): ${JSON.stringify(body)}`);
  return body as HeliusWebhookConfig;
}

/**
 * Replaces a webhook's accountAddresses list. Helius's PUT replaces the
 * whole webhook config, not just the one field, so this reads the current
 * config first and re-sends it with only accountAddresses changed -- adding
 * a wallet should never accidentally reset the webhook's URL, auth header,
 * or transaction types.
 */
export async function updateWebhookAddresses(webhookId: string, accountAddresses: string[]): Promise<void> {
  if (!env.HELIUS_API_KEY) throw new Error("HELIUS_API_KEY is not set");

  const current = await getWebhook(webhookId);
  const url = `${BASE_URL}/webhooks/${webhookId}?api-key=${env.HELIUS_API_KEY}`;
  const res = await fetch(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      webhookURL: current.webhookURL,
      transactionTypes: current.transactionTypes,
      accountAddresses,
      webhookType: current.webhookType,
      authHeader: current.authHeader,
      txnStatus: current.txnStatus,
    }),
  });
  const body = await res.json().catch(() => undefined);
  if (!res.ok) throw new Error(`Helius updateWebhook failed (${res.status}): ${JSON.stringify(body)}`);
}

/**
 * Adds a single address to the configured webhook's watch list, if it
 * isn't already there. Returns whether a call was actually needed (false =
 * already present, no-op).
 */
export async function addAddressToWebhook(webhookId: string, address: string): Promise<boolean> {
  return serializeWebhookUpdate(webhookId, async () => {
    const current = await getWebhook(webhookId);
    if (current.accountAddresses.includes(address)) return false;
    await updateWebhookAddresses(webhookId, [...current.accountAddresses, address]);
    return true;
  });
}

/** Removes a single address from the configured webhook's watch list, if present. Returns whether a call was actually needed. */
export async function removeAddressFromWebhook(webhookId: string, address: string): Promise<boolean> {
  return serializeWebhookUpdate(webhookId, async () => {
    const current = await getWebhook(webhookId);
    if (!current.accountAddresses.includes(address)) return false;
    await updateWebhookAddresses(
      webhookId,
      current.accountAddresses.filter((a) => a !== address),
    );
    return true;
  });
}
