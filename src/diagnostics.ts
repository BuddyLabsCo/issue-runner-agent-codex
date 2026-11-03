export function diagnostic(
  sessionref: string | undefined,
  message: string,
): void {
  process.stderr.write(
    `[codex] sessionref=${sessionref ?? "unbound"} ${message}\n`,
  );
}
