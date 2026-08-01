import { writeFileSync } from "node:fs";
import { createArtifactServer } from "./http-server.js";

const [target, kind, route, readyPath] = process.argv.slice(2, 6);

try {
  const server = createArtifactServer({ target, kind, route });
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    writeFileSync(readyPath, JSON.stringify({ port: address.port }), { mode: 0o600 });
  });

  const stop = () => server.close(() => process.exit(0));
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
} catch (error) {
  writeFileSync(readyPath, JSON.stringify({ error: error.message }), { mode: 0o600 });
  process.exitCode = 1;
}
