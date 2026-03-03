import fs from "node:fs";
import path from "node:path";

function ensureExists(targetPath, label) {
  if (!fs.existsSync(targetPath)) {
    throw new Error(`${label} introuvable: ${targetPath}`);
  }
}

const rootDir = process.cwd();
const frontendDir = path.join(rootDir, "frontend");
const frontendNextDir = path.join(frontendDir, ".next");
const rootNextDir = path.join(rootDir, ".next");
const routesManifestPath = path.join(frontendNextDir, "routes-manifest.json");

ensureExists(frontendDir, "Dossier frontend");
ensureExists(frontendNextDir, "Build Next frontend (.next)");
ensureExists(routesManifestPath, "routes-manifest.json frontend");

fs.rmSync(rootNextDir, { recursive: true, force: true });
fs.cpSync(frontendNextDir, rootNextDir, { recursive: true });

const frontendPublicDir = path.join(frontendDir, "public");
const rootPublicDir = path.join(rootDir, "public");
if (fs.existsSync(frontendPublicDir)) {
  fs.rmSync(rootPublicDir, { recursive: true, force: true });
  fs.cpSync(frontendPublicDir, rootPublicDir, { recursive: true });
}

console.log("[vercel-sync] frontend/.next -> .next copie avec succes");
