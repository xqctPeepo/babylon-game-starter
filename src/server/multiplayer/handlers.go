package main

import (
	"encoding/json"
	"io"
	"log"
	"net/http"
	"time"
)

// JoinRequest is sent by client when joining multiplayer session
type JoinRequest struct {
	EnvironmentName string `json:"environment_name"`
	CharacterName   string `json:"character_name"`
}

// JoinResponse returns connection details to client
type JoinResponse struct {
	ClientID       string `json:"client_id"`
	IsSynchronizer bool   `json:"is_synchronizer"`
	ExistingClients int   `json:"existing_clients"`
	SessionID      string `json:"session_id"`
}

// ClientStateMessage wraps client state info
type ClientStateMessage struct {
	ClientID    string `json:"client_id"`
	Environment string `json:"environment"`
	Character   string `json:"character"`
	Timestamp   int64  `json:"timestamp"`
}

// handleJoin processes client join requests
func (ms *MultiplayerServer) handleJoin(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	// Parse request body
	var req JoinRequest
	body, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, "Failed to read request body", http.StatusBadRequest)
		return
	}
	defer r.Body.Close()

	if err := json.Unmarshal(body, &req); err != nil {
		http.Error(w, "Invalid request JSON", http.StatusBadRequest)
		return
	}

	// Generate new client ID
	clientID := generateClientID()
	sessionID := generateSessionID()

	ms.mu.Lock()

	// Check max clients
	if len(ms.clients) >= ms.maxClients {
		ms.mu.Unlock()
		http.Error(w, "Server full", http.StatusServiceUnavailable)
		return
	}

	// Add client to ordered collection
	client := &ClientConnection{
		ID:            clientID,
		IsSynchronizer: false, // Will be set below
		LastSeen:      time.Now().Unix(),
		SessionID:     sessionID,
	}

	ms.clients[clientID] = client
	ms.clientOrder = append(ms.clientOrder, clientID)
	ms.sessionIDToClientID[sessionID] = clientID

	// Determine if this client should be synchronizer
	// First connected client becomes synchronizer
	isSynchronizer := len(ms.clientOrder) == 1
	if isSynchronizer {
		client.IsSynchronizer = true
		ms.setSynchronizerID(clientID)
	}

	existingClients := len(ms.clients) - 1 // Exclude self

	ms.mu.Unlock()

	log.Printf(
		"[Join] Client %s joined (Env: %s, Char: %s, Sync: %v, Total: %d)",
		clientID,
		req.EnvironmentName,
		req.CharacterName,
		isSynchronizer,
		len(ms.clients),
	)

	// Return join response
	resp := JoinResponse{
		ClientID:        clientID,
		IsSynchronizer:  isSynchronizer,
		ExistingClients: existingClients,
		SessionID:       sessionID,
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(resp)

	// Broadcast client joined signal to all clients
	ms.broadcastClientEvent("client_joined", ClientStateMessage{
		ClientID:    clientID,
		Environment: req.EnvironmentName,
		Character:   req.CharacterName,
		Timestamp:   time.Now().UnixMilli(),
	})
}

// handleLeave processes client disconnect
func (ms *MultiplayerServer) handleLeave(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	// Get client ID from header or query param
	clientID := r.Header.Get("X-Client-ID")
	if clientID == "" {
		clientID = r.URL.Query().Get("client_id")
	}

	if clientID == "" {
		http.Error(w, "Missing client_id", http.StatusBadRequest)
		return
	}

	ms.removeClient(clientID)

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(map[string]bool{"ok": true})
}

// handleHealth returns server health status
func (ms *MultiplayerServer) handleHealth(w http.ResponseWriter, r *http.Request) {
	ms.mu.RLock()
	clientCount := len(ms.clients)
	ms.mu.RUnlock()

	resp := map[string]interface{}{
		"ok":        true,
		"service":   "multiplayer",
		"clients":   clientCount,
		"timestamp": time.Now().UnixMilli(),
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(resp)
}

// handleCharacterStateUpdate processes character state updates from synchronizer
func (ms *MultiplayerServer) handleCharacterStateUpdate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPatch {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	if !ms.verifySynchronizer(r) {
		http.Error(w, "Only synchronizer can update state", http.StatusForbidden)
		return
	}

	// Parse state update
	var update map[string]interface{}
	if err := json.NewDecoder(r.Body).Decode(&update); err != nil {
		http.Error(w, "Invalid JSON", http.StatusBadRequest)
		return
	}

	log.Printf("[CharacterState] Update received: %v", update)

	// Validate state update (security/constraints)
	// TODO: Implement validation

	// Broadcast to all clients
	ms.broadcastToAll("character-state-update", update)

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(map[string]bool{"ok": true})
}

// handleItemStateUpdate processes item state updates from synchronizer
func (ms *MultiplayerServer) handleItemStateUpdate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPatch {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	if !ms.verifySynchronizer(r) {
		http.Error(w, "Only synchronizer can update state", http.StatusForbidden)
		return
	}

	var update map[string]interface{}
	if err := json.NewDecoder(r.Body).Decode(&update); err != nil {
		http.Error(w, "Invalid JSON", http.StatusBadRequest)
		return
	}

	log.Printf("[ItemState] Update received: %v", update)

	ms.broadcastToAll("item-state-update", update)

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(map[string]bool{"ok": true})
}

// handleEffectsStateUpdate processes effects state updates
func (ms *MultiplayerServer) handleEffectsStateUpdate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPatch {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	if !ms.verifySynchronizer(r) {
		http.Error(w, "Only synchronizer can update state", http.StatusForbidden)
		return
	}

	var update map[string]interface{}
	if err := json.NewDecoder(r.Body).Decode(&update); err != nil {
		http.Error(w, "Invalid JSON", http.StatusBadRequest)
		return
	}

	log.Printf("[EffectsState] Update received: %v", update)

	ms.broadcastToAll("effects-state-update", update)

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(map[string]bool{"ok": true})
}

// handleLightsStateUpdate processes lights state updates
func (ms *MultiplayerServer) handleLightsStateUpdate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPatch {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	if !ms.verifySynchronizer(r) {
		http.Error(w, "Only synchronizer can update state", http.StatusForbidden)
		return
	}

	var update map[string]interface{}
	if err := json.NewDecoder(r.Body).Decode(&update); err != nil {
		http.Error(w, "Invalid JSON", http.StatusBadRequest)
		return
	}

	log.Printf("[LightsState] Update received: %v", update)

	ms.broadcastToAll("lights-state-update", update)

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(map[string]bool{"ok": true})
}

// handleSkyEffectsStateUpdate processes sky effects state updates
func (ms *MultiplayerServer) handleSkyEffectsStateUpdate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPatch {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	if !ms.verifySynchronizer(r) {
		http.Error(w, "Only synchronizer can update state", http.StatusForbidden)
		return
	}

	var update map[string]interface{}
	if err := json.NewDecoder(r.Body).Decode(&update); err != nil {
		http.Error(w, "Invalid JSON", http.StatusBadRequest)
		return
	}

	log.Printf("[SkyEffectsState] Update received: %v", update)

	ms.broadcastToAll("sky-effects-state-update", update)

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(map[string]bool{"ok": true})
}

// verifySynchronizer checks if request is from current synchronizer
func (ms *MultiplayerServer) verifySynchronizer(r *http.Request) bool {
	clientID := r.Header.Get("X-Client-ID")
	ms.mu.RLock()
	defer ms.mu.RUnlock()
	return clientID == ms.synchronizerID && ms.synchronizerID != ""
}

// broadcastClientEvent broadcasts client connection/disconnection events
func (ms *MultiplayerServer) broadcastClientEvent(eventType string, msg ClientStateMessage) {
	ms.broadcastToAll(eventType, msg)
}

// removeClient removes a client from the server
func (ms *MultiplayerServer) removeClient(clientID string) {
	ms.mu.Lock()
	defer ms.mu.Unlock()

	client, exists := ms.clients[clientID]
	if !exists {
		return
	}

	// Remove from clients map
	delete(ms.clients, clientID)

	// Remove from order slice
	for i, id := range ms.clientOrder {
		if id == clientID {
			ms.clientOrder = append(ms.clientOrder[:i], ms.clientOrder[i+1:]...)
			break
		}
	}

	// Remove session mapping
	delete(ms.sessionIDToClientID, client.SessionID)

	log.Printf("[Leave] Client %s disconnected (WasSynchronizer: %v)", clientID, client.IsSynchronizer)

	// If synchronizer disconnected, promote next client
	if client.IsSynchronizer && len(ms.clientOrder) > 0 {
		newSyncID := ms.clientOrder[0]
		ms.clients[newSyncID].IsSynchronizer = true
		ms.setSynchronizerID(newSyncID)

		log.Printf("[Synchronizer] Failover to %s", newSyncID)

		ms.broadcastToAll("synchronizer-changed", map[string]interface{}{
			"new_synchronizer_id": newSyncID,
			"reason":              "disconnection",
			"timestamp":           time.Now().UnixMilli(),
		})
	}
}

// handleSSE manages Datastar SSE connections for real-time signal broadcasting
func (ms *MultiplayerServer) handleSSE(w http.ResponseWriter, r *http.Request) {
	// Get session ID from query or header
	sessionID := r.URL.Query().Get("sid")
	if sessionID == "" {
		sessionID = r.Header.Get("X-Session-ID")
	}

	if sessionID == "" {
		http.Error(w, "Missing session ID", http.StatusBadRequest)
		return
	}

	ms.mu.RLock()
	clientID, exists := ms.sessionIDToClientID[sessionID]
	ms.mu.RUnlock()

	if !exists {
		http.Error(w, "Invalid session", http.StatusUnauthorized)
		return
	}

	log.Printf("[SSE] Client %s establishing SSE connection", clientID)

	// Create Datastar broker (SSE endpoint)
	broker := ms.brokerFactory.NewBroker()

	// Register this broker session for broadcasts
	ms.registerBrokerSession(sessionID, broker)

	// Defer cleanup on disconnect
	defer func() {
		ms.unregisterBrokerSession(sessionID)
		log.Printf("[SSE] Client %s disconnected", clientID)
	}()

	// Handle SSE connection (Datastar will handle the response headers)
	broker.Handle(w, r)
}
