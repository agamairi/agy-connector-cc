#!/usr/bin/env node
process.on("SIGTERM", () => {});
process.stdout.write("ready\n");
setInterval(() => {}, 1_000);
