import "dotenv/config";
import { createApp } from "./app.js";
import { config } from "./config.js";

const { app, manager } = await createApp();
const server = app.listen(config.port, config.host, () => {
  console.log(`video-server listening on http://${config.host}:${config.port}`);
});

function shutdown(): void {
  manager.stop();
  if (!server.listening) return;
  server.close((error) => {
    if (error) {
      console.error(error);
      process.exitCode = 1;
    }
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
