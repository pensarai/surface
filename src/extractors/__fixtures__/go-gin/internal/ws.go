package internal

import (
	"net/http"

	"github.com/gorilla/websocket"
)

var up = websocket.Upgrader{}

// listUsers here DOES upgrade — a deliberate name collision with the main
// package's plain-HTTP listUsers handler. Per-package scoping must keep the
// two apart so the main package's /api/users route is not mislabeled ws.
func listUsers(w http.ResponseWriter, r *http.Request) {
	conn, err := up.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	_ = conn
}
