import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";

export interface PackageArtifact {
  manifest: Record<string, unknown>;
  manifestText: string;
  files: string[];
  integrity: string;
}

function readField(header: Buffer, start: number, end: number): string {
  return header
    .subarray(start, end)
    .toString("utf8")
    .replace(/\0[\s\S]*$/, "");
}

// npm tarballs are a gzip-compressed ustar archive rooted at `package/`. Reading
// the header directly keeps the inspection identical on every runner and avoids
// trusting a separate `npm pack --dry-run` listing.
function readTarEntries(bytes: Buffer): Map<string, Buffer> {
  const entries = new Map<string, Buffer>();
  let offset = 0;
  while (offset + 512 <= bytes.length) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = readField(header, 0, 100);
    const prefix = readField(header, 345, 500);
    const size = Number.parseInt(readField(header, 124, 136).trim() || "0", 8);
    const type = String.fromCharCode(header[156] ?? 0);
    const start = offset + 512;
    if (type === "0" || type === "\0" || type === "") {
      entries.set(
        prefix === "" ? name : `${prefix}/${name}`,
        bytes.subarray(start, start + size),
      );
    }
    offset = start + Math.ceil(size / 512) * 512;
  }
  return entries;
}

export function inspectPackageArtifact(file: string): PackageArtifact {
  let bytes: Buffer;
  try {
    bytes = readFileSync(file);
  } catch {
    throw new Error(
      `TARBALL must point to the packed candidate tarball; could not read ${file}`,
    );
  }
  let entries: Map<string, Buffer>;
  try {
    entries = readTarEntries(gunzipSync(bytes));
  } catch {
    throw new Error(`${file} is not a readable npm package tarball`);
  }
  const manifestBytes = entries.get("package/package.json");
  if (manifestBytes === undefined) {
    throw new Error(
      `${file} is not an npm package tarball: package/package.json is missing`,
    );
  }
  const manifestText = manifestBytes.toString("utf8");
  let manifest: unknown;
  try {
    manifest = JSON.parse(manifestText);
  } catch {
    throw new Error(`${file} contains an unreadable package/package.json`);
  }
  if (
    typeof manifest !== "object" ||
    manifest === null ||
    Array.isArray(manifest)
  ) {
    throw new Error(
      `${file} contains a package/package.json that is not an object`,
    );
  }
  const files = [...entries.keys()]
    .filter((name) => name.startsWith("package/") && !name.endsWith("/"))
    .map((name) => name.slice("package/".length));
  return {
    manifest: manifest as Record<string, unknown>,
    manifestText,
    files,
    integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
  };
}
