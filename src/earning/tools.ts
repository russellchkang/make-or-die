/**
 * Earning Tools — the agent-facing surface for selling services via x402.
 *
 * These tools let the automaton define paid services, run the storefront,
 * and watch revenue. Registered alongside the built-in tools in
 * src/agent/tools.ts.
 */

import type { AutomatonTool } from "../types.js";

export function createEarningTools(): AutomatonTool[] {
  return [
    {
      name: "create_paid_service",
      description:
        "Create or update a paid service that other agents and humans can buy from you via x402 USDC payments. " +
        "You define a system prompt; buyers pay per call and POST an input; your inference produces the output. " +
        "Price it ABOVE your per-call inference cost or you lose money on every sale. " +
        "After creating a service, run start_earning_server and expose_port to go live, " +
        "then update_agent_card so discover_agents can find your services.",
      category: "financial",
      riskLevel: "caution",
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "URL-safe slug (lowercase letters, digits, hyphens). Becomes the endpoint /svc/<name>.",
          },
          description: {
            type: "string",
            description: "What the service does — shown in your public directory.",
          },
          price_usd: {
            type: "number",
            description: "Price per call in USD (min 0.01).",
          },
          prompt: {
            type: "string",
            description: "System prompt defining the service. Buyer input arrives as the user message.",
          },
        },
        required: ["name", "description", "price_usd", "prompt"],
      },
      execute: async (args, ctx) => {
        const price = args.price_usd as number;
        const prompt = args.prompt as string;

        // ── Economics guard: refuse prices that lose money per sale ──
        const { estimateServiceCost, suggestPrice, MIN_MARGIN_MULTIPLE } =
          await import("./pricing.js");
        const model = ctx.inference.getDefaultModel();
        const est = estimateServiceCost(ctx.db, model, prompt);
        if (price < est.floorUsd) {
          return [
            `REFUSED: $${price.toFixed(2)}/call would lose money.`,
            `Serving one call on ${model} costs up to $${est.costUsd.toFixed(4)}` +
              (est.known ? "" : " (model unknown — assumed worst-case rates)") + ".",
            `Minimum viable price (${MIN_MARGIN_MULTIPLE}x cost, covering gas and your own thinking): $${est.floorUsd.toFixed(4)}.`,
            `Suggested price: $${suggestPrice(est.floorUsd).toFixed(2)}. Re-run with a higher price_usd, a shorter prompt, or a cheaper model.`,
          ].join("\n");
        }

        const { saveService } = await import("./services.js");
        const error = saveService(ctx.db, {
          name: args.name as string,
          description: args.description as string,
          priceUsd: price,
          prompt,
        });
        if (error) return `Failed to save service: ${error}`;
        const { getEarningServerStatus } = await import("./server.js");
        const status = getEarningServerStatus();
        const margin = price - est.costUsd;
        return [
          `Paid service "${args.name}" saved at $${price.toFixed(2)}/call.`,
          `Worst-case margin: $${margin.toFixed(4)}/sale on ${model} (cost ≤ $${est.costUsd.toFixed(4)}).`,
          status.running
            ? `Live now at /svc/${args.name} on port ${status.port}.`
            : `Not yet reachable — run start_earning_server to open your storefront.`,
        ].join(" ");
      },
    },
    {
      name: "list_paid_services",
      description: "List the paid services you currently offer, with prices.",
      category: "financial",
      riskLevel: "safe",
      parameters: { type: "object", properties: {} },
      execute: async (_args, ctx) => {
        const { listServices } = await import("./services.js");
        const services = listServices(ctx.db);
        if (services.length === 0) {
          return "No paid services defined. Use create_paid_service to start selling.";
        }
        const { getEarningServerStatus } = await import("./server.js");
        const status = getEarningServerStatus();
        const lines = services.map(
          (s) => `- ${s.name}: $${s.priceUsd.toFixed(2)}/call — ${s.description}`,
        );
        lines.push(
          status.running
            ? `Storefront: RUNNING on port ${status.port}`
            : "Storefront: NOT RUNNING (start_earning_server to go live)",
        );
        return lines.join("\n");
      },
    },
    {
      name: "remove_paid_service",
      description: "Remove a paid service from your storefront.",
      category: "financial",
      riskLevel: "caution",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Service name to remove." },
        },
        required: ["name"],
      },
      execute: async (args, ctx) => {
        const { removeService } = await import("./services.js");
        const removed = removeService(ctx.db, args.name as string);
        return removed
          ? `Service "${args.name}" removed.`
          : `No service named "${args.name}".`;
      },
    },
    {
      name: "start_earning_server",
      description:
        "Start your x402 storefront: an HTTP server that sells your paid services for USDC. " +
        "Payments settle on-chain into your wallet (you pay sub-cent Base gas per sale). " +
        "Automatically exposes the port so buyers can reach you. " +
        "Earned USDC is auto-converted to compute credits by your heartbeat when you run low.",
      category: "financial",
      riskLevel: "caution",
      parameters: {
        type: "object",
        properties: {
          port: {
            type: "number",
            description: "Port to listen on (default 4021).",
          },
        },
      },
      execute: async (args, ctx) => {
        if (ctx.identity.chainType === "solana") {
          return "Earning server requires an EVM wallet: x402 settlement uses EIP-3009 USDC authorizations on Base.";
        }
        const { startEarningServer, getEarningServerStatus, DEFAULT_EARNING_PORT } =
          await import("./server.js");
        const { listServices } = await import("./services.js");

        const existing = getEarningServerStatus();
        if (existing.running) {
          return `Earning server already running on port ${existing.port}.`;
        }
        const services = listServices(ctx.db);
        if (services.length === 0) {
          return "No paid services defined yet — create one with create_paid_service first.";
        }

        const port = (args.port as number) || DEFAULT_EARNING_PORT;
        const started = await startEarningServer(
          { db: ctx.db, identity: ctx.identity, inference: ctx.inference },
          port,
        );
        // Remember intent so the heartbeat restarts the storefront after reboots.
        ctx.db.setKV(
          "earning.server",
          JSON.stringify({ desired: true, port: started.port }),
        );

        const lines = [
          `Earning server running on port ${started.port} with ${services.length} service(s).`,
        ];
        try {
          const portInfo = await ctx.conway.exposePort(started.port);
          lines.push(`Public URL: ${portInfo.publicUrl}`);
          lines.push(
            "Add this URL to your agent card (update_agent_card) so other agents can discover and buy your services.",
          );
        } catch (err: any) {
          lines.push(
            `Could not auto-expose the port (${err?.message || err}). Run expose_port ${started.port} to make it public.`,
          );
        }
        lines.push(
          "Note: on-chain settlement needs a little ETH on Base for gas (sub-cent per sale).",
        );
        return lines.join("\n");
      },
    },
    {
      name: "stop_earning_server",
      description: "Stop the x402 storefront. Existing services remain defined.",
      category: "financial",
      riskLevel: "caution",
      parameters: { type: "object", properties: {} },
      execute: async (_args, ctx) => {
        const { stopEarningServer } = await import("./server.js");
        const stopped = await stopEarningServer();
        ctx.db.setKV("earning.server", JSON.stringify({ desired: false }));
        return stopped
          ? "Earning server stopped."
          : "Earning server was not running.";
      },
    },
    {
      name: "check_earnings",
      description:
        "Check your revenue: total earned, recent sales, and storefront status.",
      category: "financial",
      riskLevel: "safe",
      parameters: { type: "object", properties: {} },
      execute: async (_args, ctx) => {
        const { getEarningServerStatus } = await import("./server.js");
        const status = getEarningServerStatus();

        const totals = ctx.db.raw
          .prepare(
            "SELECT COUNT(*) AS sales, COALESCE(SUM(amount_cents), 0) AS cents FROM earnings",
          )
          .get() as { sales: number; cents: number };
        const recent = ctx.db.raw
          .prepare(
            "SELECT service, payer, amount_cents, tx_hash, created_at FROM earnings ORDER BY created_at DESC LIMIT 10",
          )
          .all() as Array<{
          service: string;
          payer: string;
          amount_cents: number;
          tx_hash: string | null;
          created_at: string;
        }>;

        const lines = [
          `Total earned: $${(totals.cents / 100).toFixed(2)} across ${totals.sales} sale(s).`,
          status.running
            ? `Storefront: RUNNING on port ${status.port}.`
            : "Storefront: NOT RUNNING.",
        ];
        if (recent.length > 0) {
          lines.push("Recent sales:");
          for (const r of recent) {
            lines.push(
              `- ${r.created_at} ${r.service} $${(r.amount_cents / 100).toFixed(2)} from ${r.payer}${r.tx_hash ? ` (${r.tx_hash.slice(0, 14)}…)` : ""}`,
            );
          }
        }
        return lines.join("\n");
      },
    },
  ];
}
