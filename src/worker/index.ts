import {
  ConfigError,
  loadDotEnv,
  schedulerConfig,
  workerConfig,
} from "@/lib/config/env";
import { closeWorker, startWorker } from "@/lib/queue/worker";
import { closeRedis } from "@/lib/server/redis";
import { startScheduler } from "@/lib/server/scheduler";

/**
 * KLYZ worker process.
 *
 * Consumes the execution queue, runs workflows through the engine and
 * reconciles stranded executions. Started with `npm run worker` (or
 * `npm run dev:all`, which runs it beside the app).
 */

loadDotEnv();

async function main(): Promise<void> {
  const config = workerConfig();

  if (config.driver !== "redis") {
    console.error(
      "[worker] KLYZ_QUEUE_DRIVER=memory is set. The worker consumes Redis/BullMQ jobs — unset it to run this process.",
    );
    process.exit(1);
  }

  console.log(
    `[worker] queue=${config.queue} concurrency=${config.concurrency} attempts=${config.attempts} timeout=${config.executionTimeoutMs}ms`,
  );

  await startWorker({ concurrency: config.concurrency });
  console.log("[worker] ready — waiting for jobs");

  /* Schedule triggers run here, in the same process that runs
     executions: one loop, one queue, one place to turn off. */
  const scheduler = schedulerConfig();
  const schedulerHandle = scheduler.enabled
    ? startScheduler({ intervalMs: scheduler.intervalMs, batch: scheduler.batch })
    : null;
  console.log(
    scheduler.enabled
      ? `[worker] scheduler enabled — every ${scheduler.intervalMs}ms, batch ${scheduler.batch}`
      : "[worker] scheduler disabled (KLYZ_SCHEDULER_ENABLED=false)",
  );

  let closing = false;
  const shutdown = (signal: string): void => {
    if (closing) return;
    closing = true;
    console.log(`[worker] ${signal} — draining`);
    schedulerHandle?.stop();
    void (async () => {
      try {
        await closeWorker();
        await closeRedis();
      } finally {
        process.exit(0);
      }
    })();
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((error) => {
  if (error instanceof ConfigError) {
    console.error("[worker] configuration error:");
    for (const issue of error.issues) console.error(`  - ${issue}`);
  } else {
    console.error("[worker] failed to start:", error);
  }
  process.exit(1);
});
