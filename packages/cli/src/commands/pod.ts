import type { Command } from "commander";
import chalk from "chalk";
import type { Pod, OrgPodSummary, ArchivedPod, PodArchiveJob } from "@pim/shared";
import { getPressureLevel, getPressureLabel } from "@pim/shared";
import { getBaseUrl, fetchJSON } from "../util.js";

export function registerPodCommands(program: Command) {
  const pod = program.command("pod").description("Manage pods");

  pod
    .command("create")
    .description("Create a new pod")
    .requiredOption("-n, --name <name>", "Pod name")
    .option("-d, --sprint-days <days>", "Sprint duration in days", "5")
    .option("-m, --milestone <name>", "Milestone name", "Sprint Goal")
    .action(async (opts) => {
      const base = getBaseUrl(program);
      const pod = await fetchJSON<Pod>(`${base}/api/pods`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: opts.name,
          sprint_days: parseInt(opts.sprintDays, 10),
          milestone_name: opts.milestone,
        }),
      });

      console.log(chalk.green("\n  Pod created successfully!\n"));
      console.log(`  ID:        ${chalk.bold(pod.pod_id)}`);
      console.log(`  Name:      ${pod.name}`);
      console.log(`  Sprint:    Day ${pod.day_number} of ${pod.total_days}`);
      console.log(`  Milestone: ${pod.milestone.name} (target: ${pod.milestone.target_date})`);
      console.log(`\n  ${chalk.dim("UI:")} http://localhost:5173/pod/${pod.pod_id}`);
      console.log();
    });

  pod
    .command("list")
    .description("List active pods")
    .action(async () => {
      const base = getBaseUrl(program);
      const pods = await fetchJSON<OrgPodSummary[]>(`${base}/api/org/pods`);

      if (pods.length === 0) {
        console.log(chalk.yellow("\n  No active pods.\n"));
        return;
      }

      console.log(chalk.bold("\n  Active Pods\n"));

      for (const p of pods) {
        const level = getPressureLabel(getPressureLevel(p.conflict_pressure));
        const pressureColor =
          p.conflict_pressure >= 0.8 ? chalk.red :
          p.conflict_pressure >= 0.6 ? chalk.yellow :
          p.conflict_pressure >= 0.3 ? chalk.yellow :
          chalk.green;

        console.log(`  ${chalk.bold(p.name)}  ${chalk.dim(`(${p.pod_id})`)}`);
        console.log(`    Day ${p.day_number}/${p.total_days}  |  Pressure: ${pressureColor(`${p.conflict_pressure.toFixed(2)} ${level}`)}  |  Conflicts: ${p.open_conflicts}  |  Tunnels: ${p.active_tunnels}`);
        console.log();
      }
      console.log();
    });

  pod
    .command("status")
    .description("Show pod details")
    .argument("<podId>", "Pod ID")
    .action(async (podId: string) => {
      const base = getBaseUrl(program);
      const pod = await fetchJSON<Pod>(`${base}/api/pods/${podId}`);

      const level = getPressureLabel(getPressureLevel(pod.conflict_pressure));

      console.log(chalk.bold(`\n  ${pod.name}`));
      console.log(chalk.dim("  " + "-".repeat(50)));
      console.log(`  Sprint:    Day ${pod.day_number} of ${pod.total_days} (${pod.sprint_start} — ${pod.sprint_end})`);
      console.log(`  Pressure:  ${pod.conflict_pressure.toFixed(2)} (${level})`);
      console.log(`  Milestone: ${pod.milestone.name} — ${pod.milestone.percent_complete}% complete (target: ${pod.milestone.target_date})`);

      console.log(chalk.bold("\n  Areas"));
      for (const area of pod.areas) {
        const icon =
          area.status === "done" ? chalk.green("done") :
          area.status === "in_progress" ? chalk.blue("in progress") :
          area.status === "blocked" ? chalk.red("blocked") :
          chalk.dim("waiting");
        console.log(`    ${area.scope.padEnd(12)} ${icon}  ${chalk.dim(area.owner)}`);
      }
      console.log();
    });

  pod
    .command("archive")
    .description("Archive a completed pod")
    .argument("<podId>", "Pod ID")
    .action(async (podId: string) => {
      const base = getBaseUrl(program);
      const started = await fetchJSON<ArchivedPod | PodArchiveJob>(`${base}/api/pods/${podId}/archive`, {
        method: "POST",
      });
      const result = isArchiveJob(started)
        ? await pollArchiveJob(base, started)
        : started;
      console.log(chalk.green(`\n  Archived: ${result.name}`));
      console.log(`  Duration: ${result.duration_days} days | Final pressure: ${result.final_pressure.toFixed(2)}`);
      if (result.canonical_memory_intake) {
        console.log(
          `  Candidates submitted for validation/review: ${result.canonical_memory_intake.candidates_submitted} (not active yet)`,
        );
      } else if (typeof result.learnings_extracted === "number") {
        console.log(`  Legacy graph learnings added: ${result.learnings_extracted}`);
      }
      console.log();
    });
}

function isArchiveJob(value: ArchivedPod | PodArchiveJob): value is PodArchiveJob {
  return "job_id" in value && "status" in value && "status_url" in value;
}

async function pollArchiveJob(base: string, initial: PodArchiveJob): Promise<ArchivedPod> {
  let job = initial;
  if (job.status === "completed" && job.archived) return job.archived;
  if (job.status === "failed") throw new Error(job.error ?? "Archive failed");

  console.log(chalk.yellow(`\n  Archive job started: ${job.job_id}`));
  for (let attempt = 0; attempt < 120; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    job = await fetchJSON<PodArchiveJob>(`${base}${job.status_url}`);
    if (job.status === "completed" && job.archived) return job.archived;
    if (job.status === "failed") throw new Error(job.error ?? "Archive failed");
  }
  throw new Error("Archive did not complete before the polling timeout");
}
