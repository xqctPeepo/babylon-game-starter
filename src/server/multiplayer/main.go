package main

import (
	"log"
	"net/http"
	"os"
	"strings"
	"sync"

	"github.com/starfederation/datastar-go/datastar"
)

// ClientConnection represents a connected multiplayer client
type ClientConnection struct {
	ID              string
	IsSynchronizer  bool
	LastSeen        int64
	SessionID       string
	EnvironmentName string
	CharacterName   string
}

// MultiplayerServer manages all connected clients and state synchronization
type MultiplayerServer struct {
	mu                  sync.RWMutex
	clients             map[string]*ClientConnection // Map of clientID -> connection
	clientOrder         []string                     // Maintains connection order for synchronizer role
	synchronizerID      string
	maxClients          int
	sessionIDToClientID map[string]string                             // For SSE auth
	sseSessions         map[string]*datastar.ServerSentEventGenerator // Track active SSE sessions
	sseMu               sync.RWMutex
}

// NewMultiplayerServer creates a new multiplayer server
func NewMultiplayerServer(maxClients int) *MultiplayerServer {
	return &MultiplayerServer{
		clients:             make(map[string]*ClientConnection),
		clientOrder:         make([]string, 0),
		maxClients:          maxClients,
		sessionIDToClientID: make(map[string]string),
		sseSessions:         make(map[string]*datastar.ServerSentEventGenerator),
	}
}

// GetSynchronizerID returns the current synchronizer client ID
func (ms *MultiplayerServer) GetSynchronizerID() string {
	ms.mu.RLock()
	defer ms.mu.RUnlock()
	return ms.synchronizerID
}

// SetSynchronizerID updates the synchronizer (internal use)
func (ms *MultiplayerServer) setSynchronizerID(id string) {
	ms.synchronizerID = id
}

// RegisterRoutes registers all multiplayer HTTP routes
func (ms *MultiplayerServer) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/api/multiplayer/join", ms.handleJoin)
	mux.HandleFunc("/api/multiplayer/leave", ms.handleLeave)
	mux.HandleFunc("/api/multiplayer/stream", ms.handleSSE)
	mux.HandleFunc("/api/multiplayer/health", ms.handleHealth)
	mux.HandleFunc("/api/multiplayer/character-state", ms.handleCharacterStateUpdate)
	mux.HandleFunc("/api/multiplayer/item-state", ms.handleItemStateUpdate)
	mux.HandleFunc("/api/multiplayer/effects-state", ms.handleEffectsStateUpdate)
	mux.HandleFunc("/api/multiplayer/lights-state", ms.handleLightsStateUpdate)
	mux.HandleFunc("/api/multiplayer/sky-effects-state", ms.handleSkyEffectsStateUpdate)
}

// broadcastToAll sends a signal to all connected clients via Datastar patch-signals SSE.
func (ms *MultiplayerServer) broadcastToAll(signalName string, payload interface{}) error {
	if payload == nil {
		return nil
	}

	ms.sseMu.RLock()
	sessions := make([]*datastar.ServerSentEventGenerator, 0, len(ms.sseSessions))
	for _, sse := range ms.sseSessions {
		if sse != nil {
			sessions = append(sessions, sse)
		}
	}
	ms.sseMu.RUnlock()

	if len(sessions) == 0 {
		log.Printf("[Broadcast] No active SSE sessions for signal: %s", signalName)
		return nil
	}

	for _, sse := range sessions {
		if sse == nil || sse.IsClosed() {
			continue
		}
		go func(stream *datastar.ServerSentEventGenerator) {
			if err := stream.MarshalAndPatchSignals(multiplayerSignalPatch(signalName, payload)); err != nil {
				log.Printf("[Broadcast] Failed to patch signals for %s: %v", signalName, err)
			}
		}(sse)
	}

	log.Printf("[Broadcast] Signal %s sent to %d clients", signalName, len(sessions))
	return nil
}

// broadcastExcept sends a signal to all except specified client
func (ms *MultiplayerServer) broadcastExcept(excludedSessionID string, signalName string, payload interface{}) error {
	if payload == nil {
		return nil
	}

	ms.sseMu.RLock()
	for sessionID, sse := range ms.sseSessions {
		if sessionID == excludedSessionID || sse == nil || sse.IsClosed() {
			continue
		}
		go func(stream *datastar.ServerSentEventGenerator) {
			if err := stream.MarshalAndPatchSignals(multiplayerSignalPatch(signalName, payload)); err != nil {
				log.Printf("[Broadcast] Failed to patch signals for %s: %v", signalName, err)
			}
		}(sse)
	}
	ms.sseMu.RUnlock()

	return nil
}

// multiplayerSignalPatch builds the JSON object merged into the client signal root.
// The browser client listens for datastar-patch-signals and dispatches on mp.name / mp.payload.
func multiplayerSignalPatch(signalName string, payload interface{}) map[string]any {
	return map[string]any{
		"mp": map[string]any{
			"name":    signalName,
			"payload": payload,
		},
	}
}

// registerSSESession tracks a new SSE session
func (ms *MultiplayerServer) registerSSESession(sessionID string, sse *datastar.ServerSentEventGenerator) {
	ms.sseMu.Lock()
	defer ms.sseMu.Unlock()
	ms.sseSessions[sessionID] = sse
	log.Printf("[SSE] Session registered: %s (total: %d)", sessionID, len(ms.sseSessions))
}

// unregisterSSESession removes an SSE session
func (ms *MultiplayerServer) unregisterSSESession(sessionID string) {
	ms.sseMu.Lock()
	defer ms.sseMu.Unlock()
	delete(ms.sseSessions, sessionID)
	log.Printf("[SSE] Session unregistered: %s (remaining: %d)", sessionID, len(ms.sseSessions))
}

// main entry point
func main() {
	log.Println("[Multiplayer Server] Starting...")

	// Create multiplayer server (max 100 concurrent clients)
	mpServer := NewMultiplayerServer(100)

	// Setup HTTP routes
	mux := http.NewServeMux()
	mpServer.RegisterRoutes(mux)

	// Health check endpoint
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{"ok":true,"service":"multiplayer"}`))
	})

	port := strings.TrimSpace(os.Getenv("PORT"))
	if port == "" {
		port = "5000"
	}
	if !strings.HasPrefix(port, ":") {
		port = ":" + port
	}

	handler := withCORS(mux)
	log.Printf("[Multiplayer Server] Listening on %s (set PORT to override; CORS via MULTIPLAYER_CORS_ALLOW_ORIGIN)", port)
	if err := http.ListenAndServe(port, handler); err != nil {
		log.Fatalf("[Multiplayer Server] Failed to start: %v", err)
	}
}
