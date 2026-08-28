#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { privateKeyToAccount } from "viem/accounts";
import { z } from "zod";
const API_URL = (process.env.CRON402_API_URL ?? "https://cron402-api.user-defaults.workers.dev").replace(/\/$/, "");
const NETWORK = process.env.CRON402_NETWORK ?? "eip155:8453";
const PRIVATE_KEY = process.env.CRON402_PRIVATE_KEY;
if (!PRIVATE_KEY) {
    console.error("cron402-mcp: CRON402_PRIVATE_KEY is required (fund it with USDC on Base)");
    process.exit(1);
}
const account = privateKeyToAccount(PRIVATE_KEY);
const client = new x402Client();
registerExactEvmScheme(client, { signer: account });
const paidFetch = wrapFetchWithPayment(globalThis.fetch, client);
function out(data) {
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}
function manageHeaders(action, jobId) {
    const timestamp = Date.now();
    const signature = account.signTypedData({
        domain: { name: "cron402", version: "1" },
        types: {
            EIP712Domain: [
                { name: "name", type: "string" },
                { name: "version", type: "string" },
            ],
            ManageJob: [
                { name: "action", type: "string" },
                { name: "jobId", type: "string" },
                { name: "timestamp", type: "uint256" },
            ],
        },
        primaryType: "ManageJob",
        message: { action, jobId, timestamp: BigInt(timestamp) },
    });
    return signature.then((sig) => ({
        "x-cron402-timestamp": String(timestamp),
        "x-cron402-signature": sig,
    }));
}
async function manage(action, jobId) {
    if (!/^[0-9a-fA-F-]{36}$/.test(jobId))
        return out({ error: "jobId must be a UUID" });
    const headers = await manageHeaders(action, jobId);
    const res = await fetch(action === "delete" ? `${API_URL}/v1/crons/${jobId}` : `${API_URL}/v1/crons/${jobId}/${action}`, { method: action === "delete" ? "DELETE" : "POST", headers });
    return out(await res.json());
}
const server = new McpServer({ name: "cron402", version: "0.1.0" });
server.tool("create_cron", "Create a scheduled webhook job on cron402. Costs $0.008 USDC on Base via x402 (includes 1 run credit). Returns the job id.", {
    schedule: z
        .string()
        .describe("Cron expression, UTC, min interval 1 minute, e.g. '*/5 * * * *'"),
    url: z.string().url().describe("Webhook URL to call on each fire"),
    method: z.enum(["GET", "POST"]).optional().default("POST"),
    body: z.string().max(16384).optional().describe("Request body for POST"),
    headers: z.record(z.string()).optional(),
    notifyUrl: z
        .string()
        .url()
        .optional()
        .describe("Receives a POST with the result after every execution"),
}, async ({ schedule, url, method, body, headers, notifyUrl }) => {
    const res = await paidFetch(`${API_URL}/v1/crons`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ schedule, target: { url, method, headers, body }, notifyUrl }),
    });
    return out(await res.json());
});
server.tool("topup_cron", "Add prepaid run credits to a job ($0.008/run via x402). Reactivates exhausted or paused jobs.", {
    jobId: z.string().uuid(),
    pack: z
        .union([z.literal(1), z.literal(10), z.literal(100)])
        .describe("Credit pack size ($0.008 per run)"),
}, async ({ jobId, pack }) => {
    const res = await paidFetch(`${API_URL}/v1/crons/topup/${pack}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jobId }),
    });
    return out(await res.json());
});
server.tool("get_cron", "Fetch job status, credits, and last 20 executions (free).", { jobId: z.string().uuid() }, async ({ jobId }) => {
    const res = await fetch(`${API_URL}/v1/crons/${jobId}`);
    return out(await res.json());
});
server.tool("pause_cron", "Pause a cron job (signs an EIP-712 authorization with your key).", { jobId: z.string().uuid() }, async ({ jobId }) => manage("pause", jobId));
server.tool("resume_cron", "Resume a paused job (requires credits; signs EIP-712).", { jobId: z.string().uuid() }, async ({ jobId }) => manage("resume", jobId));
server.tool("delete_cron", "Permanently delete a job (signs an EIP-712 authorization with your key).", { jobId: z.string().uuid() }, async ({ jobId }) => manage("delete", jobId));
await server.connect(new StdioServerTransport());
console.error(`cron402-mcp ready — wallet ${account.address} on ${NETWORK} → ${API_URL}`);
