import {
  syncFinalOrderTelegramState,
  type FinalOrderStatus,
} from "../src/order/telegramFinalStatus.js";

type Args = {
  status: FinalOrderStatus;
  orderIds: string[];
  skipStatusChats: boolean;
};

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}

function parseArgs(argv: string[]): Args {
  const orderIds: string[] = [];
  let status: FinalOrderStatus = "cancelled";
  let skipStatusChats = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? "";
    if (arg === "--status") {
      const next = argv[i + 1] ?? "";
      if (next !== "cancelled" && next !== "done") {
        throw new Error("Usage: --status cancelled|done");
      }
      status = next;
      i += 1;
      continue;
    }

    if (arg === "--skip-status-chats") {
      skipStatusChats = true;
      continue;
    }

    if (arg.startsWith("-")) {
      throw new Error(`Unknown flag: ${arg}`);
    }

    if (!isUuid(arg)) {
      throw new Error(`Invalid order id: ${arg}`);
    }
    orderIds.push(arg);
  }

  if (orderIds.length === 0) {
    throw new Error(
      "Usage: pnpm -C apps/api exec tsx scripts/sync-final-order-status.ts [--status cancelled|done] [--skip-status-chats] <order-id> [...order-id]",
    );
  }

  return { status, orderIds, skipStatusChats };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  for (const orderId of args.orderIds) {
    console.log(`Syncing ${args.status} for ${orderId}...`);
    await syncFinalOrderTelegramState({
      orderId,
      status: args.status,
      skipStatusChats: args.skipStatusChats,
    });
  }

  console.log(`Done. Synced ${args.orderIds.length} order(s) with status ${args.status}.`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
