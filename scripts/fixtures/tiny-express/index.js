// Minimal Express app — used by scripts/smoke-test.mjs to exercise surface's
// map() against a known-shape input. Two routes is enough: the smoke test
// only asserts non-empty.

const express = require("express");

const app = express();

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

app.post("/users", (req, res) => {
  res.json({ created: true });
});

app.listen(3000);
