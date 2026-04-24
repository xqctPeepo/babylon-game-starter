package main

import (
	"encoding/json"
	"io"
	"log"
	"math"
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
			"environmentName": envName,
			"newAuthorityId":  clientID,
			"prevAuthorityId": nil,
			"reason":          "arrival", // §6.9: first arrival into empty env
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

// Invariants P (pose-only wire) and E (no Euler anywhere on item paths) —
// see MULTIPLAYER_SYNCH.md §5.2. Every `ItemInstanceState` row carries exactly two
// transform fields: `pos` (JSON array of length 3) and `rot` (JSON array of length
// 4; unit quaternion [x,y,z,w]). Legacy fields (`matrix`, `position`, `rotation`,
// `velocity`) are rejected/stripped.
const itemPosLen = 3
const itemRotLen = 4

// itemPosEpsilon is the per-component tolerance (meters) for the pos field used by
// the dirty filter (MULTIPLAYER_SYNCH.md §5.2.1).
//
// Value rationale: the threshold MUST exceed the Havok idle-jitter amplitude of a
// settled body on the owner client. Empirically, ~5 mm is comfortably above Havok's
// settled-body jitter for our scale range while remaining well below the
// player-character collision radius (so real motion remains perceptible on replicas).
const itemPosEpsilon = 5e-3

// itemRotDotThreshold is the dirty-filter threshold on the quaternion dot product.
// Two unit quaternions represent the same orientation iff |q1·q2| ≈ 1; the angle
// between them satisfies cos(θ/2) = |q1·q2|. A dot-product below this threshold
// corresponds to roughly a ≥0.5° orientation change, which matches the translational
// jitter floor (itemPosEpsilon ≈ 5 mm) in visual significance.
//
// Using |dot| handles the double-cover property: q and -q represent the same rotation
// and must compare as equal.
const itemRotDotThreshold = 0.99996 // ≈ cos(0.5°)

// coerceItemPose validates a row's `pos` and `rot` fields. On success it returns
// canonical slices (pos length 3, rot length 4, all finite). On failure it returns
// nil slices; callers MUST drop the row unless isCollected=true.
func coerceItemPose(row map[string]interface{}) ([]float64, []float64) {
	pos := coerceFloatSlice(row["pos"], itemPosLen)
	rot := coerceFloatSlice(row["rot"], itemRotLen)
	return pos, rot
}

func coerceFloatSlice(raw interface{}, n int) []float64 {
	arr, ok := raw.([]interface{})
	if !ok || len(arr) != n {
		return nil
	}
	out := make([]float64, n)
	for i, v := range arr {
		f, ok := v.(float64)
		if !ok {
			return nil
		}
		if math.IsNaN(f) || math.IsInf(f, 0) {
			return nil
		}
		out[i] = f
	}
	return out
}

// stripLegacyItemTransformFields removes any legacy transform keys that may arrive
// from older clients (Invariants P and E). The server refuses to propagate them
// even if present in the incoming row.
func stripLegacyItemTransformFields(row map[string]interface{}) {
	delete(row, "matrix")
	delete(row, "position")
	delete(row, "rotation")
	delete(row, "velocity")
}

// isPosDirty returns true when any component of position a differs from b by more
// than itemPosEpsilon. Both slices must have length itemPosLen.
func isPosDirty(a, b []float64) bool {
	for i := 0; i < itemPosLen; i++ {
		if math.Abs(a[i]-b[i]) > itemPosEpsilon {
			return true
		}
	}
	return false
}

// isRotDirty returns true when the quaternion dot-product magnitude is below
// itemRotDotThreshold (i.e. the rotation has changed by more than ~0.5°). Both
// slices must have length itemRotLen and be approximately unit length.
func isRotDirty(a, b []float64) bool {
	dot := a[0]*b[0] + a[1]*b[1] + a[2]*b[2] + a[3]*b[3]
	if dot < 0 {
		dot = -dot
	}
	return dot < itemRotDotThreshold
}

// isDirtyRow compares an accepted item row against the cached transform to decide whether
// the row carries new information worth broadcasting (MULTIPLAYER_SYNCH.md §5.2.1).
//
// A row is DIRTY when any of the following hold:
//   - No cache entry exists (first accepted row for this instanceId).
//   - The pos differs component-wise beyond itemPosEpsilon.
//   - The rot quaternion differs (|dot| below itemRotDotThreshold).
//   - Any categorical field (isCollected, collectedByClientId, ownerClientId) changed.
//
// Callers must hold ms.mu (write lock).
func (ms *MultiplayerServer) isDirtyRow(
	iid string,
	pos, rot []float64,
	isCollected bool,
	collectedBy string,
	ownerID string,
) bool {
	cached, ok := ms.itemTransformCache[iid]
	if !ok {
		return true // first row — always dirty
	}
	if isCollected != cached.IsCollected {
		return true
	}
	if collectedBy != cached.CollectedByClientID {
		return true
	}
	if ownerID != cached.OwnerClientID {
		return true
	}
	if pos != nil && isPosDirty(pos, cached.Pos[:]) {
		return true
	}
	if rot != nil && isRotDirty(rot, cached.Rot[:]) {
		return true
	}
	return false
}

// updateTransformCache writes the latest accepted row values into itemTransformCache.
// Callers must hold ms.mu (write lock).
func (ms *MultiplayerServer) updateTransformCache(
	iid string,
	itemName string,
	pos, rot []float64,
	isCollected bool,
	collectedBy string,
	ownerID string,
	now int64,
) {
	entry := CachedItemTransform{
		IsCollected:         isCollected,
		CollectedByClientID: collectedBy,
		OwnerClientID:       ownerID,
		LastBroadcastAt:     now,
	}
	// Preserve itemName from the first row that sets it; never overwrite with empty.
	if itemName != "" {
		entry.ItemName = itemName
	} else if existing, ok := ms.itemTransformCache[iid]; ok {
		entry.ItemName = existing.ItemName
	}
	// Preserve last-known pose for collection-only rows (isCollected=true, no pose).
	if pos != nil {
		copy(entry.Pos[:], pos)
	} else if existing, ok := ms.itemTransformCache[iid]; ok {
		entry.Pos = existing.Pos
	}
	if rot != nil {
		copy(entry.Rot[:], rot)
	} else if existing, ok := ms.itemTransformCache[iid]; ok {
		entry.Rot = existing.Rot
	}
	ms.itemTransformCache[iid] = entry
}

// handleItemStateUpdate processes item state updates under the hybrid authority model
// (MULTIPLAYER_SYNCH.md §5.2 / §7.5). Rows are filtered per-instance against the server's
// itemOwners and envAuthority maps:
//
//   - Explicit owner row (itemOwners[iid] exists, sender == owner): accept, refresh LastUpdatedAt.
//   - Unowned row: accept from env-authority (§4.8) or base-synchronizer fallback (§4.6).
//   - Otherwise: silently drop the row.
//
// After authority filtering, accepted rows pass through the dirty filter (§5.2.1): rows
// whose pose (pos + rot) and categorical fields are within epsilon of the cached values
// are dropped from the broadcast (but still refresh activity tracking). Only DIRTY rows
// are broadcast.
//
// Broadcast uses broadcastExcept(senderSessionID) so the resolved owner never receives its
// own rows back (owner-pin invariant, §5.2.2 rule 2).
//
// Invariant P: rows without a valid `pos` (len 3) AND `rot` (len 4) are dropped unless
// isCollected=true. Invariant E: legacy transform fields (matrix/position/rotation/velocity)
// are stripped before broadcast.
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
	clientInfo, known := ms.clients[sender]
	var senderSessionID string
	if clientInfo != nil {
		senderSessionID = clientInfo.SessionID
	}
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

	// dirtyUpdates holds rows that passed both authority AND dirty filters — these go to peers.
	dirtyUpdates := make([]interface{}, 0)
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

			// Invariant P: every row MUST carry a valid `pos` (len 3) AND `rot`
			// (len 4). Collection-only rows (isCollected toggling without transform)
			// are permitted to omit both ONLY when isCollected is true — the receiver
			// hides the mesh and no transform is needed.
			pos, rot := coerceItemPose(row)
			if pos == nil || rot == nil {
				if collected, _ := row["isCollected"].(bool); !collected {
					droppedRows++
					continue
				}
				// Don't mix partial pose into a collection-only row.
				pos = nil
				rot = nil
			}
			// Invariant E: never forward legacy transform fields even if a legacy
			// client sent them alongside `pos`/`rot`.
			stripLegacyItemTransformFields(row)

			// --- Authority filter (§7.5) ---
			cur, exists := ms.itemOwners[iid]
			accept := false
			var resolvedOwnerID string // the clientId that the server resolves as owner

			if exists && cur != nil {
				// Tier 1: explicit owner row — only the owner may publish.
				if cur.OwnerClientID == sender {
					cur.LastUpdatedAt = now
					accept = true
					resolvedOwnerID = sender
				}
			} else {
				// Tier 2: unowned row — accept from env-authority (primary) or
				// base-synchronizer (fallback for envs without an env-authority).
				envName := envNameFromInstanceID(iid)
				envAuth := ms.envAuthority[envName]
				if envAuth != "" && sender == envAuth {
					accept = true
					resolvedOwnerID = envAuth
				} else if sender == syncID && syncID != "" && envAuth == "" {
					// Base-synchronizer fallback only when no env-authority is set.
					accept = true
					resolvedOwnerID = syncID
				}
			}

			if !accept {
				droppedRows++
				continue
			}

			// Stamp ownerClientId so the client's first defense-in-depth check
			// (ownerClientId === selfId) fires for both explicit and env-authority rows.
			row["ownerClientId"] = resolvedOwnerID

			// --- Dirty filter (§5.2.1) ---
			isCollected, _ := row["isCollected"].(bool)
			collectedBy, _ := row["collectedByClientId"].(string)
			itemName, _ := row["itemName"].(string) // preserved in cache for bootstrap reconstruction

			dirty := ms.isDirtyRow(iid, pos, rot, isCollected, collectedBy, resolvedOwnerID)

			// Always refresh activity tracking regardless of dirty status (§5.2.1 Activity side effects).
			if o, ok := ms.itemOwners[iid]; ok && o != nil && o.OwnerClientID == sender {
				o.LastUpdatedAt = now
			}

			if dirty {
				ms.updateTransformCache(iid, itemName, pos, rot, isCollected, collectedBy, resolvedOwnerID, now)
				dirtyUpdates = append(dirtyUpdates, row)
				if pos != nil {
					log.Printf("[ItemState] Accepted dirty row %s pos=(%.2f,%.2f,%.2f) owner=%s", iid, pos[0], pos[1], pos[2], resolvedOwnerID)
				}
			}
			// CLEAN rows: activity already refreshed above; skip broadcast.
		}
		ms.mu.Unlock()
	}

	collections := update["collections"]

	if droppedRows > 0 {
		log.Printf("[ItemState] Filtered %d unauthorized row(s) from sender=%s", droppedRows, sender)
	}

	if len(dirtyUpdates) > 0 || collections != nil {
		broadcast := map[string]interface{}{
			"updates":   dirtyUpdates,
			"timestamp": update["timestamp"],
		}
		if collections != nil {
			broadcast["collections"] = collections
		}
		// Owner-pin invariant (§5.2.2 rule 2): do NOT send item rows back to their sender.
		// broadcastExcept ensures the resolved owner receives no echo of its own transforms.
		ms.broadcastExcept(senderSessionID, "item-state-update", broadcast)
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
	// reason "disconnect" is the correct §6.9 token for tab-close / network-drop events
	// (same semantics as "failover"; distinguished for diagnostics).
	for _, fo := range envFailovers {
		log.Printf("[EnvAuthority] Failover in '%s': %s → %s", fo.envName, fo.prevAuthId, fo.newAuthorityId)
		ms.broadcastToAll("env-item-authority-changed", map[string]interface{}{
			"environmentName": fo.envName,
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
//
// Item bootstrap uses itemTransformCache (§5.2.1 / §5.2.3 *Bootstrap on environment entry*):
// one ItemInstanceState row is emitted per cached instanceId so the late joiner always
// receives the full item set, not just the last partial PATCH. This replaces the former
// single lastItemState blob which could be a partial update in multi-owner scenarios.
func (ms *MultiplayerServer) pushSnapshotToSession(sessionID string) {
	ms.mu.RLock()

	// Build bootstrap rows from itemTransformCache — one row per known instanceId.
	itemRows := make([]interface{}, 0, len(ms.itemTransformCache))
	for iid, cached := range ms.itemTransformCache {
		posIface := make([]interface{}, itemPosLen)
		for i, v := range cached.Pos {
			posIface[i] = v
		}
		rotIface := make([]interface{}, itemRotLen)
		for i, v := range cached.Rot {
			rotIface[i] = v
		}
		row := map[string]interface{}{
			"instanceId":  iid,
			"itemName":    cached.ItemName, // required by client-side coerceItemInstanceState
			"pos":         posIface,
			"rot":         rotIface,
			"isCollected": cached.IsCollected,
			"timestamp":   cached.LastBroadcastAt,
		}
		if cached.CollectedByClientID != "" {
			row["collectedByClientId"] = cached.CollectedByClientID
		}
		if cached.OwnerClientID != "" {
			row["ownerClientId"] = cached.OwnerClientID
		}
		itemRows = append(itemRows, row)
	}

	charSnaps := make([]interface{}, 0, len(ms.lastCharacterStates))
	for cid, v := range ms.lastCharacterStates {
		if _, stillHere := ms.clients[cid]; stillHere {
			charSnaps = append(charSnaps, v)
		}
	}
	ms.mu.RUnlock()

	if len(itemRows) > 0 {
		log.Printf("[Bootstrap] Sending %d item rows to session %s", len(itemRows), sessionID)
		for _, r := range itemRows {
			if row, ok := r.(map[string]interface{}); ok {
				if pos, ok := row["pos"].([]interface{}); ok && len(pos) == itemPosLen {
					x, _ := pos[0].(float64)
					y, _ := pos[1].(float64)
					z, _ := pos[2].(float64)
					log.Printf("[Bootstrap]   %s itemName=%v pos=(%.2f,%.2f,%.2f)", row["instanceId"], row["itemName"], x, y, z)
				}
			}
		}
		_ = ms.sendToSession(sessionID, "item-state-update", map[string]interface{}{
			"updates":   itemRows,
			"timestamp": time.Now().UnixMilli(),
		})
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

	// Authority snapshot MUST be pushed before the item-transform snapshot so that by the
	// time the client's item-state-update listener fires, the authority tracker already
	// knows who owns each item. This lets the client correctly skip setting DYNAMIC bodies
	// to kinematic before the item snapshot arrives, preventing the spawn-position freeze
	// where items were kinematic at the wrong (spawn) positions.
	ms.pushAuthoritySnapshotToSession(sessionID)
	ms.pushSnapshotToSession(sessionID)

	// Settled-positions safety net: the bootstrap snapshot above reflects whatever is in
	// itemTransformCache at this exact moment, which may contain pre-settlement scatter
	// positions if the env-authority client's physics items had not yet come to rest when
	// it first published rows. Physics items typically settle within ~1 second of spawn.
	// Scheduling a second snapshot push at 1.5 s ensures the joining client receives the
	// correct floor-level transforms even if it arrived during the settling window.
	// If items were already settled at join time the two snapshots are identical (harmless
	// redundancy). The goroutine exits early if the session has already closed.
	go func() {
		time.Sleep(1500 * time.Millisecond)
		ms.sseMu.RLock()
		stillOpen := ms.sseSessions[sessionID] != nil && !ms.sseSessions[sessionID].IsClosed()
		ms.sseMu.RUnlock()
		if stillOpen {
			log.Printf("[Bootstrap] Sending settled-positions re-snapshot to session %s", sessionID)
			ms.pushSnapshotToSession(sessionID)
		}
	}()

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
					reason:          "env_switch", // §6.9: reason MUST be "env_switch" for env-switch transitions
				})
			} else if _, had := ms.envAuthority[oldEnv]; had {
				// Defensive: if the authority was someone else (shouldn't happen when the
				// client was in envClientOrder) leave it alone.
				_ = had
			}
		} else if ms.envAuthority[oldEnv] == clientID {
			next := ms.envClientOrder[oldEnv][0]
			ms.envAuthority[oldEnv] = next
			transitions = append(transitions, envTransition{
				envName:         oldEnv,
				newAuthorityID:  next,
				prevAuthorityID: clientID,
				reason:          "env_switch", // §6.9: reason MUST be "env_switch" for env-switch transitions
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
			reason:          "arrival", // §6.9: first arrival into empty env
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
			"environmentName": t.envName, // §6.9 field name
			"reason":          t.reason,
			"timestamp":       now,
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
			"environmentName": newEnv, // §6.9 field name
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
