import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const frontendRoot = path.resolve(__dirname, "..");

const nextDir = path.join(frontendRoot, ".next");
const cacheDir = path.join(frontendRoot, "node_modules", ".cache");

await rm(nextDir, { recursive: true, force: true });
await rm(cacheDir, { recursive: true, force: true });
