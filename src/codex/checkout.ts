import childProcess from "node:child_process";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import type { EnhancementContext } from "issue-runner-core/terminal";

function git(context: EnhancementContext, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = childProcess.spawn("git", ["rev-parse", ...args], {
      cwd: context.cwd,
      env: { ...process.env, ...context.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("Codex primary checkout discovery timed out"));
    }, 10_000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
    });
    child.stderr.resume();
    child.once("error", () => {
      clearTimeout(timer);
      reject(new Error("Codex primary checkout discovery failed"));
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(output.replace(/\r?\n$/u, ""));
      else reject(new Error("Codex primary checkout discovery failed"));
    });
  });
}

export async function primaryCheckout(
  context: EnhancementContext,
): Promise<string> {
  const common = await git(context, [
    "--path-format=absolute",
    "--git-common-dir",
  ]);
  if (!isAbsolute(common) || basename(common) !== ".git")
    throw new Error("Codex trust requires an ordinary primary checkout");
  const primary = resolve(dirname(common));
  const primaryContext = { ...context, cwd: primary };
  const root = await git(primaryContext, ["--show-toplevel"]);
  const gitDir = await git(primaryContext, ["--absolute-git-dir"]);
  if (
    !isAbsolute(root) ||
    !isAbsolute(gitDir) ||
    resolve(root) !== primary ||
    resolve(gitDir) !== resolve(common)
  )
    throw new Error("Codex trust requires an ordinary primary checkout");
  return primary;
}
