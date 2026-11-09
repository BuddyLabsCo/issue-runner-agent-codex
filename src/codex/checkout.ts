import childProcess from "node:child_process";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import type { Log } from "./log.ts";
import type { EnhancementContext } from "issue-runner-core/terminal";

function git(
  context: EnhancementContext,
  args: string[],
  log: Log,
): Promise<string> {
  log.info("Git query", { cwd: context.cwd, args: ["rev-parse", ...args] });
  return new Promise((resolve, reject) => {
    const child = childProcess.spawn("git", ["rev-parse", ...args], {
      cwd: context.cwd,
      env: { ...process.env, ...context.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const deadline = log.schedule(
      "Git query deadline",
      10_000,
      "primary checkout discovery",
    );
    const timer = setTimeout(() => {
      deadline("timed out");
      log.info("Git query stop");
      child.kill();
      reject(new Error("Codex primary checkout discovery timed out"));
    }, 10_000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
    });
    child.stderr.resume();
    child.once("error", (error) => {
      log.error("Git query failed", error);
      clearTimeout(timer);
      deadline("cancelled");
      reject(new Error("Codex primary checkout discovery failed"));
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      deadline("cancelled");
      if (code === 0) resolve(output.replace(/\r?\n$/u, ""));
      else reject(new Error("Codex primary checkout discovery failed"));
    });
  });
}

export async function primaryCheckout(
  context: EnhancementContext,
  log: Log,
): Promise<{ primary: string; worktree: string }> {
  const common = await git(
    context,
    ["--path-format=absolute", "--git-common-dir"],
    log,
  );
  if (!isAbsolute(common) || basename(common) !== ".git")
    throw new Error("Codex trust requires an ordinary primary checkout");
  const primary = resolve(dirname(common));
  const primaryContext = { ...context, cwd: primary };
  const root = await git(primaryContext, ["--show-toplevel"], log);
  const gitDir = await git(primaryContext, ["--absolute-git-dir"], log);
  if (
    !isAbsolute(root) ||
    !isAbsolute(gitDir) ||
    resolve(root) !== primary ||
    resolve(gitDir) !== resolve(common)
  )
    throw new Error("Codex trust requires an ordinary primary checkout");
  const worktree = await git(context, ["--show-toplevel"], log);
  if (!isAbsolute(worktree))
    throw new Error("Codex trust requires an ordinary task checkout");
  return { primary, worktree: resolve(worktree) };
}
