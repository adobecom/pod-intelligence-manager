import type { Command } from "commander";
import chalk from "chalk";
import type { Tunnel } from "@council/shared";
import { getBaseUrl, fetchJSON } from "../util.js";

export function registerTunnelCommands(program: Command) {
  const tunnel = program.command("tunnel").description("Manage dev tunnels");

  tunnel
    .command("start")
    .description("Register a dev tunnel for your local server")
    .requiredOption("-p, --pod <podId>", "Pod ID")
    .requiredOption("--port <port>", "Local server port")
    .requiredOption("-d, --dev <name>", "Developer name")
    .option("-b, --branch <branch>", "Branch name", "main")
    .action(async (opts) => {
      const base = getBaseUrl(program);
      const port = parseInt(opts.port, 10);

      const tunnel = await fetchJSON<Tunnel>(`${base}/api/pods/${opts.pod}/tunnels`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          dev_name: opts.dev,
          branch: opts.branch,
          port,
        }),
      });

      console.log(chalk.green("\n  Tunnel active!\n"));
      console.log(`  ${chalk.bold(opts.dev)}'s dev server → ${chalk.cyan(tunnel.url)}`);
      console.log(`  Pod:    ${opts.pod}`);
      console.log(`  Branch: ${opts.branch}`);
      console.log(`  ID:     ${tunnel.tunnel_id}`);
      console.log(chalk.dim("\n  Sending heartbeats every 60s. Press Ctrl+C to disconnect.\n"));

      // Heartbeat loop
      const heartbeat = setInterval(async () => {
        try {
          await fetch(`${base}/api/pods/${opts.pod}/tunnels/${tunnel.tunnel_id}/heartbeat`, {
            method: "PUT",
          });
        } catch {
          // Server may be down, keep trying
        }
      }, 60_000);

      // Graceful shutdown
      const cleanup = async () => {
        clearInterval(heartbeat);
        try {
          await fetch(`${base}/api/pods/${opts.pod}/tunnels/${tunnel.tunnel_id}/disconnect`, {
            method: "PUT",
          });
          console.log(chalk.yellow("\n  Tunnel disconnected.\n"));
        } catch {
          // Best effort
        }
        process.exit(0);
      };

      process.on("SIGINT", cleanup);
      process.on("SIGTERM", cleanup);

      // Keep the process alive
      await new Promise(() => {});
    });

  tunnel
    .command("list")
    .description("List tunnels for a pod")
    .requiredOption("-p, --pod <podId>", "Pod ID")
    .action(async (opts) => {
      const base = getBaseUrl(program);
      const tunnels = await fetchJSON<Tunnel[]>(`${base}/api/pods/${opts.pod}/tunnels`);

      if (tunnels.length === 0) {
        console.log(chalk.yellow("\n  No tunnels for this pod.\n"));
        return;
      }

      console.log(chalk.bold("\n  Tunnels\n"));
      for (const t of tunnels) {
        const icon =
          t.status === "active" ? chalk.green("active") :
          t.status === "idle" ? chalk.yellow("idle") :
          chalk.red("disconnected");
        console.log(`  ${t.dev_name.padEnd(12)} ${t.branch.padEnd(20)} ${chalk.cyan(t.url)}  ${icon}`);
      }
      console.log();
    });

  tunnel
    .command("stop")
    .description("Disconnect a tunnel")
    .requiredOption("-p, --pod <podId>", "Pod ID")
    .requiredOption("-t, --tunnel <tunnelId>", "Tunnel ID")
    .action(async (opts) => {
      const base = getBaseUrl(program);
      const result = await fetchJSON<Tunnel>(
        `${base}/api/pods/${opts.pod}/tunnels/${opts.tunnel}/disconnect`,
        { method: "PUT" },
      );
      console.log(chalk.yellow(`\n  Disconnected tunnel: ${result.dev_name} (${result.tunnel_id})\n`));
    });
}
