package main

import (
	"encoding/json"
	"io"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/starfederation/datastar-go/datastar"
)

// JoinRequest is sent by client when joining multiplayer session
type JoinRequest struct {
	EnvironmentName string `json:"environment_name"`
	CharacterName   string `json:"character_name"`
}

// JoinResponse returns connection details to client
type JoinResponse struct {
	ClientID        string `json:"client_id"`
	IsSynchronizer  bool   `json:"is_synchronizer"`
	ExistingClients int    `json:"existing_clients"`
	SessionID       string `json:"session_id"`
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
		ID:              clientID,
		IsSynchronizer:  false, // Will be set below
		LastSeen:        time.Now().Unix(),
		SessionID:       sessionID,
		EnvironmentName: req.EnvironmentName,
		CharacterName:   req.CharacterName,
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

	// Per-environment authority (§4.8): first client in each env becomes the env-authority.
	// envClientOrder[envName] preserves join order for FIFO failover on leave.
	envName := strings.TrimSpace(req.EnvironmentName)
	var becameEnvAuthority bool
	if envName != "" {
		ms.envClientOrder[envName] = append(ms.envClientOrder[envName], clientID)
		if len(ms.envClientOrder[envName]) == 1 {
			ms.envAuthority[envName] = clientID
			becameEnvAuthority = true
		}
	}

	existingClients := len(ms.clients) - 1 // Exclude self

	ms.mu.Unlock()

	// Emit env-item-authority-changed so every connected client (including the new arrival
	// whose SSE is not yet open) can learn the current env-authority. The new arrival's own
	// client will receive this via pushAuthoritySnapshotToSession on SSE open; other clients
	// in the env need to know so they can demote themselves if they were acting as env-authority
	// before this client joined (the FIFO rule means the earlier client stays authority, but the
	// new one needs to know who is authoritative). On first-join (becameEnvAuthority=true) we
	// broadcast to all so any peer in the same env can learn the identity.
	if becameEnvAuthority {
		now := time.Now().UnixMilli()
		ms.broadcastToAll("env-item-authority-changed", map[string]interface{}{
			"envName":         envName,
			"newAuthorityId":  clientID,
			"prevAuthorityId": nil,
			"reason":          "join",
			"timestamp":       now,
		})
		log.Printf("[EnvAuthority] %s became env-authority for '%s'", clientID, envName)
	}

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

	// client-joined is broadcast from handleSSE after the SSE session is registered
	// so at least one EventSource exists to receive it.
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

// handleCharacterStateUpdate processes character state updates from each owning client (X-Client-ID).
func (ms *MultiplayerServer) handleCharacterStateUpdate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPatch {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	// Parse state update
	var update map[string]interface{}
	if err := json.NewDecoder(r.Body).Decode(&update); err != nil {
		http.Error(w, "Invalid JSON", http.StatusBadRequest)
		return
	}

	// Each client sends their own pose (not only the synchronizer); X-Client-ID must match every update.clientId.
	if !ms.verifyCharacterPoseSender(r, update) {
		http.Error(w, "Invalid character-state sender or payload", http.StatusForbidden)
		return
	}

	ms.mergeCharacterSnapshot(update)

	log.Printf("[CharacterState] Update received: %v", update)

	// Broadcast to all clients
	ms.broadcastToAll("character-state-update", update)

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(map[string]bool{"ok": true})
}

// handleItemStateUpdate processes item state updates under the hybrid authority model
// (MULTIPLAYER_SYNCH.md §5.2 / §7.5). Rows are filtered per-instance against the server's
// itemOwners map:
//
//   - If the instance is currently owned and sender == owner: accept (refresh LastUpdatedAt).
//   - If the instance is unowned: accept from the env-authority of that item's environment
//     (§4.8 — envAuthority[envName]) or, as a global fallback, the base synchronizer (§4.6).
//   - Otherwise: silently drop the row.
//
// The environment name is extracted from the env-scoped instanceId prefix (format: "envName::…").
//
// ItemCollectionEvents are first-write-wins. Any row's claim of `isCollected=true` is
// persisted into lastItemState so late joiners get the latest view.
func (ms *MultiplayerServer) handleItemStateUpdate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPatch {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	sender := strings.TrimSpace(r.Header.Get("X-Client-ID"))
	if sender == "" {
		http.Error(w, "Missing X-Client-ID", http.StatusUnauthorized)
		return
	}

	ms.mu.RLock()
	_, known := ms.clients[sender]
	syncID := ms.synchronizerID
	ms.mu.RUnlock()
	if !known {
		http.Error(w, "Unknown client", http.StatusUnauthorized)
		return
	}

	var update map[string]interface{}
	if err := json.NewDecoder(r.Body).Decode(&update); err != nil {
		http.Error(w, "Invalid JSON", http.StatusBadRequest)
		return
	}

	now := time.Now().UnixMilli()

	filteredUpdates := make([]interface{}, 0)
	droppedRows := 0

	if rawUpdates, ok := update["updates"].([]interface{}); ok {
		ms.mu.Lock()
		for _, raw := range rawUpdates {
			row, ok := raw.(map[string]interface{})
			if !ok {
				continue
			}
			iid, _ := row["instanceId"].(string)
			iid = strings.TrimSpace(iid)
			if iid == "" {
				continue
			}

			cur, exists := ms.itemOwners[iid]
			accept := false
			if exists && cur != nil {
				// Explicit owner row: only the owner may publish.
				if cur.OwnerClientID == sender {
					cur.LastUpdatedAt = now
					accept = true
				}
			} else {
				// Unowned row: accept from env-authority (primary) or global
				// base-synchronizer (fallback for envs where no env-authority is
				// tracked, or legacy clients). Both paths are per §4.8 / §4.6.
				envName := envNameFromInstanceID(iid)
				envAuth := ms.envAuthority[envName]
				if envAuth != "" && sender == envAuth {
					accept = true
				} else if sender == syncID && syncID != "" {
					accept = true
				}
			}

			if !accept {
				droppedRows++
				continue
			}

			if o, ok := ms.itemOwners[iid]; ok && o != nil {
				row["ownerClientId"] = o.OwnerClientID
			} else if _, present := row["ownerClientId"]; !present {
				row["ownerClientId"] = nil
			}

			filteredUpdates = append(filteredUpdates, row)
		}
		ms.mu.Unlock()
	}

	collections := update["collections"]

	broadcast := map[string]interface{}{
		"updates":   filteredUpdates,
		"timestamp": update["timestamp"],
	}
	if collections != nil {
		broadcast["collections"] = collections
	}

	ms.mu.Lock()
	ms.lastItemState = broadcast
	ms.mu.Unlock()

	if droppedRows > 0 {
		log.Printf("[ItemState] Filtered %d unauthorized row(s) from sender=%s", droppedRows, sender)
	}

	if len(filteredUpdates) > 0 || collections != nil {
		ms.broadcastToAll("item-state-update", broadcast)
	}

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

// verifyCharacterPoseSender ensures X-Client-ID is a known client and each updates[] entry targets only that client.
func (ms *MultiplayerServer) verifyCharacterPoseSender(r *http.Request, payload map[string]interface{}) bool {
	sender := strings.TrimSpace(r.Header.Get("X-Client-ID"))
	if sender == "" {
		return false
	}

	ms.mu.RLock()
	_, known := ms.clients[sender]
	ms.mu.RUnlock()
	if !known {
		return false
	}

	rawUpdates, ok := payload["updates"].([]interface{})
	if !ok || len(rawUpdates) == 0 {
		return false
	}

	for _, u := range rawUpdates {
		um, ok := u.(map[string]interface{})
		if !ok {
			return false
		}
		cid, ok := um["clientId"].(string)
		if !ok || cid != sender {
			return false
		}
		mid, ok := um["characterModelId"].(string)
		if !ok || strings.TrimSpace(mid) == "" {
			return false
		}
	}
	return true
}

// removeClient removes a client from the server
func (ms *MultiplayerServer) removeClient(clientID string) {
	type envFailover struct {
		envName        string
		newAuthorityId string
		prevAuthId     string
	}

	var (
		wasSynchronizer bool
		remaining       int
		newSyncID       string
		shouldPromote   bool
		envFailovers    []envFailover
		clientEnvName   string
	)

	ms.mu.Lock()
	client, exists := ms.clients[clientID]
	if !exists {
		ms.mu.Unlock()
		return
	}

	wasSynchronizer = client.IsSynchronizer
	clientEnvName = strings.TrimSpace(client.EnvironmentName)
	delete(ms.clients, clientID)
	delete(ms.lastCharacterStates, clientID)
	for i, id := range ms.clientOrder {
		if id == clientID {
			ms.clientOrder = append(ms.clientOrder[:i], ms.clientOrder[i+1:]...)
			break
		}
	}
	delete(ms.sessionIDToClientID, client.SessionID)

	releasedItems := ms.releaseItemsOwnedByLocked(clientID)

	remaining = len(ms.clients)
	if wasSynchronizer && remaining > 0 {
		newSyncID = ms.clientOrder[0]
		if c := ms.clients[newSyncID]; c != nil {
			c.IsSynchronizer = true
		}
		ms.setSynchronizerID(newSyncID)
		shouldPromote = true
	} else if wasSynchronizer {
		ms.setSynchronizerID("")
	}

	// Per-environment authority failover (§4.8). Remove the leaving client from the
	// per-env order list and, if it was the env-authority, promote the next in line.
	if clientEnvName != "" {
		order := ms.envClientOrder[clientEnvName]
		for i, id := range order {
			if id == clientID {
				ms.envClientOrder[clientEnvName] = append(order[:i], order[i+1:]...)
				break
			}
		}
		remaining_in_env := len(ms.envClientOrder[clientEnvName])
		if remaining_in_env == 0 {
			delete(ms.envClientOrder, clientEnvName)
			delete(ms.envAuthority, clientEnvName)
		} else if ms.envAuthority[clientEnvName] == clientID {
			// Promote next client in arrival order.
			newAuth := ms.envClientOrder[clientEnvName][0]
			ms.envAuthority[clientEnvName] = newAuth
			envFailovers = append(envFailovers, envFailover{
				envName:        clientEnvName,
				newAuthorityId: newAuth,
				prevAuthId:     clientID,
			})
		}
	}

	ms.mu.Unlock()

	log.Printf("[Leave] Client %s disconnected (WasSynchronizer: %v, Env: %s)", clientID, wasSynchronizer, clientEnvName)

	ms.broadcastAuthorityReleasesAfterDisconnect(clientID, releasedItems)

	if shouldPromote {
		log.Printf("[Synchronizer] Failover to %s", newSyncID)
		ms.broadcastToAll("synchronizer-changed", map[string]interface{}{
			"newSynchronizerId": newSyncID,
			"reason":            "disconnection",
			"timestamp":         time.Now().UnixMilli(),
		})
	}

	// Broadcast env-authority changes so all peers can re-derive motion types (§6.2 rule 5b).
	for _, fo := range envFailovers {
		log.Printf("[EnvAuthority] Failover in '%s': %s → %s", fo.envName, fo.prevAuthId, fo.newAuthorityId)
		ms.broadcastToAll("env-item-authority-changed", map[string]interface{}{
			"envName":         fo.envName,
			"newAuthorityId":  fo.newAuthorityId,
			"prevAuthorityId": fo.prevAuthId,
			"reason":          "disconnect",
			"timestamp":       time.Now().UnixMilli(),
		})
	}

	ms.broadcastToAll("client-left", map[string]interface{}{
		"eventType":    "left",
		"clientId":     clientID,
		"totalClients": remaining,
		"timestamp":    time.Now().UnixMilli(),
	})
}

// mergeCharacterSnapshot updates per-client pose cache used for late-join SSE snapshots.
func (ms *MultiplayerServer) mergeCharacterSnapshot(update map[string]interface{}) {
	rawUpdates, ok := update["updates"].([]interface{})
	if !ok {
		return
	}

	ms.mu.Lock()
	defer ms.mu.Unlock()

	for _, u := range rawUpdates {
		um, ok := u.(map[string]interface{})
		if !ok {
			continue
		}
		cid, ok := um["clientId"].(string)
		if !ok || cid == "" {
			continue
		}
		ms.lastCharacterStates[cid] = um
	}
}

// pushSnapshotToSession sends the latest item/world and character poses to one new SSE session.
func (ms *MultiplayerServer) pushSnapshotToSession(sessionID string) {
	ms.mu.RLock()
	itemSnap := ms.lastItemState
	charSnaps := make([]interface{}, 0, len(ms.lastCharacterStates))
	for cid, v := range ms.lastCharacterStates {
		if _, stillHere := ms.clients[cid]; stillHere {
			charSnaps = append(charSnaps, v)
		}
	}
	ms.mu.RUnlock()

	if itemSnap != nil {
		_ = ms.sendToSession(sessionID, "item-state-update", itemSnap)
	}
	if len(charSnaps) > 0 {
		_ = ms.sendToSession(sessionID, "character-state-update", map[string]interface{}{
			"updates":   charSnaps,
			"timestamp": time.Now().UnixMilli(),
		})
	}
}

// handleSSE manages Datastar SSE connections for real-time signal broadcasting
func (ms *MultiplayerServer) handleSSE(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

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

	// Reject a second live stream for the same session: overwriting the map would strand
	// the previous handler's defer (unregister / removeClient) on the wrong generator.
	ms.sseMu.Lock()
	if cur := ms.sseSessions[sessionID]; cur != nil && !cur.IsClosed() {
		ms.sseMu.Unlock()
		http.Error(w, "Stream already open for this session", http.StatusConflict)
		return
	}
	ms.sseMu.Unlock()

	log.Printf("[SSE] Client %s establishing SSE connection", clientID)

	sse := datastar.NewSSE(w, r)
	ms.registerSSESession(sessionID, sse)

	ms.pushSnapshotToSession(sessionID)
	ms.pushAuthoritySnapshotToSession(sessionID)

	ms.mu.RLock()
	total := len(ms.clients)
	var env, char string
	if c := ms.clients[clientID]; c != nil {
		env = c.EnvironmentName
		char = c.CharacterName
	}
	ms.mu.RUnlock()
	ms.broadcastToAll("client-joined", map[string]interface{}{
		"eventType":    "joined",
		"clientId":     clientID,
		"environment":  env,
		"character":    char,
		"totalClients": total,
		"timestamp":    time.Now().UnixMilli(),
	})

	defer func() {
		ms.unregisterSSESession(sessionID)
		// Tab close / network drop: remove logical client so role and counts stay correct
		ms.removeClient(clientID)
		log.Printf("[SSE] Client %s stream ended", clientID)
	}()

	<-sse.Context().Done()
}

// EnvSwitchRequest is the JSON body for PATCH /api/multiplayer/env-switch.
type EnvSwitchRequest struct {
	EnvironmentName string `json:"environmentName"`
}

// EnvSwitchResponse echoes the new env and the current env-authority for it. The client
// uses `envAuthority[newEnv]` to optimistically update its ItemAuthorityTracker before the
// SSE echo of `env-item-authority-changed` arrives (MULTIPLAYER_SYNCH.md §4.8).
type EnvSwitchResponse struct {
	OK              bool              `json:"ok"`
	EnvAuthority    map[string]string `json:"envAuthority"`
	ServerTimestamp int64             `json:"serverTimestamp"`
}

// handleEnvSwitch processes client-driven environment changes so the server's
// `envAuthority` / `envClientOrder` maps stay in sync with the actual env each client
// occupies. Without this, `handleJoin`-time env assignments become stale the moment a
// client walks through an in-game portal (the prior break: envAuthority never set for the
// new env → no env-item-authority-changed broadcast → all clients stuck in
// ANIMATED-default-with-no-publisher, presents simulate independently per client).
//
// Flow (MULTIPLAYER_SYNCH.md §4.8 env-authority lifecycle):
//
//  1. Remove clientID from envClientOrder[oldEnv]. If it was envAuthority[oldEnv], promote
//     the FIFO head (if any) or clear envAuthority[oldEnv] outright.
//
//  2. Append clientID to envClientOrder[newEnv]. If it is now the only entry, set
//     envAuthority[newEnv] = clientID. Otherwise leave the prior authority in place.
//
//  3. Emit env-item-authority-changed broadcasts for any transitions (old or new env).
//     Also send a targeted snapshot to the switcher for newEnv so it learns the current
//     authority when joining an env whose authority did not transition.
func (ms *MultiplayerServer) handleEnvSwitch(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPatch {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	clientID := strings.TrimSpace(r.Header.Get("X-Client-ID"))
	if clientID == "" {
		http.Error(w, "Missing X-Client-ID", http.StatusUnauthorized)
		return
	}

	var req EnvSwitchRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid JSON", http.StatusBadRequest)
		return
	}
	newEnv := strings.TrimSpace(req.EnvironmentName)
	if newEnv == "" {
		http.Error(w, "Missing environmentName", http.StatusBadRequest)
		return
	}

	type envTransition struct {
		envName         string
		newAuthorityID  string // "" encodes null (no authority)
		prevAuthorityID string // "" encodes null (no prior authority)
		reason          string
	}

	var (
		transitions    []envTransition
		sessionID      string
		newEnvAuthID   string
		oldEnv         string
	)

	ms.mu.Lock()
	client, exists := ms.clients[clientID]
	if !exists {
		ms.mu.Unlock()
		http.Error(w, "Unknown client", http.StatusUnauthorized)
		return
	}

	sessionID = client.SessionID
	oldEnv = strings.TrimSpace(client.EnvironmentName)

	if oldEnv == newEnv {
		newEnvAuthID = ms.envAuthority[newEnv]
		ms.mu.Unlock()
		// No-op transition; still respond with current authority so the client can apply.
		resp := EnvSwitchResponse{
			OK:              true,
			EnvAuthority:    map[string]string{newEnv: newEnvAuthID},
			ServerTimestamp: time.Now().UnixMilli(),
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(resp)
		return
	}

	// 1. Remove from old env.
	if oldEnv != "" {
		order := ms.envClientOrder[oldEnv]
		for i, id := range order {
			if id == clientID {
				ms.envClientOrder[oldEnv] = append(order[:i], order[i+1:]...)
				break
			}
		}
		remaining := len(ms.envClientOrder[oldEnv])
		if remaining == 0 {
			delete(ms.envClientOrder, oldEnv)
			if ms.envAuthority[oldEnv] == clientID {
				delete(ms.envAuthority, oldEnv)
				transitions = append(transitions, envTransition{
					envName:         oldEnv,
					newAuthorityID:  "",
					prevAuthorityID: clientID,
					reason:          "disconnect",
				})
			} else if _, had := ms.envAuthority[oldEnv]; had {
				// Defensive: if the authority was someone else (shouldn't happen when the
				// client was in envClientOrder) leave it alone.
			}
		} else if ms.envAuthority[oldEnv] == clientID {
			next := ms.envClientOrder[oldEnv][0]
			ms.envAuthority[oldEnv] = next
			transitions = append(transitions, envTransition{
				envName:         oldEnv,
				newAuthorityID:  next,
				prevAuthorityID: clientID,
				reason:          "disconnect",
			})
		}
	}

	// 2. Add to new env.
	ms.envClientOrder[newEnv] = append(ms.envClientOrder[newEnv], clientID)
	if len(ms.envClientOrder[newEnv]) == 1 {
		ms.envAuthority[newEnv] = clientID
		transitions = append(transitions, envTransition{
			envName:         newEnv,
			newAuthorityID:  clientID,
			prevAuthorityID: "",
			reason:          "join",
		})
	}
	newEnvAuthID = ms.envAuthority[newEnv]

	// 3. Update client's record.
	client.EnvironmentName = newEnv

	ms.mu.Unlock()

	log.Printf("[EnvSwitch] %s moved %q -> %q (newAuth=%s)", clientID, oldEnv, newEnv, newEnvAuthID)

	now := time.Now().UnixMilli()
	for _, t := range transitions {
		payload := map[string]interface{}{
			"envName":   t.envName,
			"reason":    t.reason,
			"timestamp": now,
		}
		if t.newAuthorityID == "" {
			payload["newAuthorityId"] = nil
		} else {
			payload["newAuthorityId"] = t.newAuthorityID
		}
		if t.prevAuthorityID == "" {
			payload["prevAuthorityId"] = nil
		} else {
			payload["prevAuthorityId"] = t.prevAuthorityID
		}
		ms.broadcastToAll("env-item-authority-changed", payload)
	}

	// Targeted snapshot for the switcher so it learns the current auth even when it did not
	// transition (joining a non-empty env whose authority was unchanged).
	if newEnvAuthID != "" {
		_ = ms.sendToSession(sessionID, "env-item-authority-changed", map[string]interface{}{
			"envName":         newEnv,
			"newAuthorityId":  newEnvAuthID,
			"prevAuthorityId": nil,
			"reason":          "snapshot",
			"timestamp":       now,
		})
	}

	resp := EnvSwitchResponse{
		OK:              true,
		EnvAuthority:    map[string]string{newEnv: newEnvAuthID},
		ServerTimestamp: now,
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(resp)
}
