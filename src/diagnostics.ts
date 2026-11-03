export function disconnected(sessionref: string | undefined): void {
  process.stderr.write(
    `[codex] sessionref=${sessionref ?? "unbound"} observation disconnected\n`,
  );
}
