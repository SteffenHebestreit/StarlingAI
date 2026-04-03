import { rm } from "node:fs/promises";
import path from "node:path";

const targetPath = path.resolve(process.argv[2] ?? "dist");

await rm(targetPath, { recursive: true, force: true });