import { performance } from "node:perf_hooks";

const NODE_COUNT = 250;
const EDGE_COUNT = 720;
const RUNS = 200;
const nodeTypes = ["actor", "issue", "source", "document", "argument"];
const nodes = Array.from({ length: NODE_COUNT }, (_, index) => ({ id: `node-${index}`, type: nodeTypes[index % nodeTypes.length], cycle_created: index % 5 }));
const edges = Array.from({ length: EDGE_COUNT }, (_, index) => ({ source: `node-${index % NODE_COUNT}`, target: `node-${(index * 17 + 11) % NODE_COUNT}`, label: index % 4 ? "soutient" : "conteste" }));

function analyzeGraph() {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const adjacency = new Map(nodes.map((node) => [node.id, new Set()]));
  edges.forEach((edge) => {
    if (!byId.has(edge.source) || !byId.has(edge.target)) return;
    adjacency.get(edge.source).add(edge.target);
    adjacency.get(edge.target).add(edge.source);
  });
  const selected = new Set(["node-0"]);
  let frontier = ["node-0"];
  for (let depth = 0; depth < 2 && frontier.length; depth += 1) {
    const next = [];
    frontier.forEach((id) => adjacency.get(id).forEach((neighbor) => {
      if (!selected.has(neighbor) && selected.size < 20) {
        selected.add(neighbor);
        next.push(neighbor);
      }
    }));
    frontier = next;
  }
  return edges.filter((edge) => selected.has(edge.source) && selected.has(edge.target));
}

const durations = [];
for (let run = 0; run < RUNS; run += 1) {
  const started = performance.now();
  analyzeGraph();
  durations.push(performance.now() - started);
}
durations.sort((left, right) => left - right);
const p95 = durations[Math.floor(durations.length * .95)];
const average = durations.reduce((sum, value) => sum + value, 0) / durations.length;
console.log(JSON.stringify({ nodes: NODE_COUNT, edges: EDGE_COUNT, runs: RUNS, average_ms: Number(average.toFixed(3)), p95_ms: Number(p95.toFixed(3)), renderer: "WebGL high-density mode above 200 nodes" }, null, 2));
if (p95 > 20) {
  console.error(`Graph preparation p95 ${p95.toFixed(2)}ms exceeds the 20ms budget.`);
  process.exit(1);
}
