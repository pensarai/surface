package main

import (
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"
)

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool { return true },
}

// listUsers is a plain JSON API handler — no upgrade.
func listUsers(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{"users": []string{"alice", "bob"}})
}

// chatHandler upgrades the connection to websocket via gorilla.
func chatHandler(c *gin.Context) {
	conn, err := upgrader.Upgrade(c.Writer, c.Request, nil)
	if err != nil {
		return
	}
	defer conn.Close()
	for {
		_, msg, err := conn.ReadMessage()
		if err != nil {
			break
		}
		if err := conn.WriteMessage(websocket.TextMessage, msg); err != nil {
			break
		}
	}
}

func main() {
	r := gin.Default()
	r.GET("/api/users", listUsers)
	r.GET("/ws", chatHandler)
	r.Run(":8080")
}
