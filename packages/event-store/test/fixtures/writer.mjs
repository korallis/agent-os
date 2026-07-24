// Kill -9 fixture: appends config.changed events in a tight loop until killed.
// Usage: node writer.mjs <homeDir> <count>
import { EventStore } from "../../dist/index.js";

const [, , homeDir, countArg] = process.argv;
if (!homeDir) {
  console.error("usage: writer.mjs <homeDir> <count>");
  process.exit(2);
}
const count = Number(countArg ?? 1000);

const { store } = EventStore.open(homeDir);
for (let i = 0; i < count; i += 1) {
  store.append({
    type: "config.changed",
    payload: {
      domain: "supervision",
      layer: "global",
      hotReloaded: true,
      contentHash: `hash-${i}`,
    },
  });
  // Signal progress so the parent can kill us mid-stream.
  if (i % 10 === 0) process.stdout.write(`${i}\n`);
}
store.close();
process.stdout.write("done\n");
