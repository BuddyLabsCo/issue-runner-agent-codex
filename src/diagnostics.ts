export function diagnostic(
  sessionref: string | undefined,
  message: string,
): void {
  try {
    process.stderr.write(
      `[codex] sessionref=${sessionref ?? "unbound"} ${message}\n`,
    );
  } catch {
    // Diagnostic output must not fail the Runner lifecycle.
  }
}
