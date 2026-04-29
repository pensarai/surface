import express from "express";
import expressWs from "express-ws";

const app = express();
expressWs(app);

// API route — returns JSON.
app.get("/api/users", (req, res) => {
  res.json({ users: [] });
});

// API route with explicit POST.
app.post("/api/users", (req, res) => {
  res.json({ created: true });
});

// Page route — server-side rendered template.
app.get("/about", (req, res) => {
  res.render("about", { title: "About" });
});

// Page route — file response.
app.get("/file", (req, res) => {
  res.sendFile("/var/data/doc.pdf");
});

// WebSocket route via express-ws.
app.ws("/chat", (ws, req) => {
  ws.on("message", (msg) => {
    ws.send(`echo: ${msg}`);
  });
});

app.listen(3000);
