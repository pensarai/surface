import express from "express";
import { Server } from "socket.io";
import { createServer } from "http";
import { PluginRegistry } from "./plugins.js";

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);

// Genuine socket.io namespace on the server instance → websocket at /rooms.
io.of("/rooms").on("connection", (socket) => {
  socket.emit("hello");
});

// Unrelated builder that ALSO exposes an `.of(...)` method. Even though this
// file imports socket.io, this `.of()` is NOT on the io instance and must not
// be emitted as a websocket endpoint.
const registry = new PluginRegistry();
registry.of("/plugins").register();

app.get("/socket-api/status", (req, res) => {
  res.json({ ok: true });
});

export default app;
