package main

import (
	"encoding/json"
	"log"
	"net/http"
	"strings"
	"time"
)

// envNameFromInstanceID extracts the environment name from an env-scoped instanceId.
// The client-side format is "envName::localId" (configured items) or
// "envName::::ENVPHYS::::meshName" (environment physics objects); in both cases the
// env name is the text before the first "::".
func envNameFromInstanceID(instanceID string) string {
	if idx := strings.Index(instanceID, "::"); idx >= 0 {
		return instanceID[:idx]
	}
	return ""
}

// ItemAuthorityClaimRequest mirrors MULTIPLAYER_SYNCH.md §5.6.
type ItemAuthorityClaimRequest struct {
	InstanceID     string                  `json:"instanceId"`
	ClientPosition *map[string]interface{} `json:"clientPosition,omitempty"`
	Reason         string                  `json:"reason,omitempty"`
	Timestamp      int64                   `json:"timestamp"`
}

// ItemAuthorityClaimResponse mirrors MULTIPLAYER_SYNCH.md §5.6.
type ItemAuthorityClaimResponse struct {
	OK              bool    `json:"ok"`
	Accepted        bool    `json:"accepted"`
	InstanceID      string  `json:"instanceId"`
	OwnerClientID   *string `json:"ownerClientId"`
	CurrentOwnerID  string  `json:"currentOwnerId,omitempty"`
	ServerTimestamp int64   `json:"serverTimestamp"`
}

// ItemAuthorityReleaseRequest mirrors MULTIPLAYER_SYNCH.md §5.7.
type ItemAuthorityReleaseRequest struct {
	InstanceID string `json:"instanceId"`
	Reason     string `json:"reason,omitempty"`
	Timestamp  int64  `json:"timestamp"`
}

// ItemAuthorityReleaseResponse mirrors MULTIPLAYER_SYNCH.md §5.7.
type ItemAuthorityReleaseResponse struct {
	OK              bool   `json:"ok"`
	Released        bool   `json:"released"`
	InstanceID      string `json:"instanceId"`
	ServerTimestamp int64  `json:"serverTimestamp"`
}

// itemAuthorityChanged builds the payload for the item-authority-changed SSE signal (§6.8).
func itemAuthorityChanged(instanceID string, prevOwner, newOwner *string, reason string, ts int64) map[string]interface{} {
	return map[string]interface{}{
		"instanceId":      instanceID,
		"previousOwnerId": prevOwner,
		"newOwnerId":      newOwner,
		"reason":          reason,
		"timestamp":       ts,
	}
}

// handleItemAuthorityClaim implements MULTIPLAYER_SYNCH.md §5.6.
func (ms *MultiplayerServer) handleItemAuthorityClaim(w http.ResponseWriter, r *http.Request) {
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
	ms.mu.RUnlock()
	if !known {
		http.Error(w, "Unknown client", http.StatusUnauthorized)
		return
	}

	var req ItemAuthorityClaimRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid JSON", http.StatusBadRequest)
		return
	}
	instanceID := strings.TrimSpace(req.InstanceID)
	if instanceID == "" {
		http.Error(w, "Missing instanceId", http.StatusBadRequest)
		return
	}

	now := time.Now().UnixMilli()

	ms.mu.Lock()
	cur, exists := ms.itemOwners[instanceID]

	var (
		accepted  bool
		prevOwner *string
		broadcast bool
	)

	switch {
	case !exists || cur == nil:
		ms.itemOwners[instanceID] = &ItemOwner{OwnerClientID: sender, LastUpdatedAt: now}
		accepted = true
		prevOwner = nil
		broadcast = true

	case cur.OwnerClientID == sender:
		cur.LastUpdatedAt = now
		accepted = true
		broadcast = false

	default:
		_, otherConnected := ms.clients[cur.OwnerClientID]
		idle := now-cur.LastUpdatedAt >= ms.claimIdleTimeoutMs
		if !otherConnected || idle {
			owner := cur.OwnerClientID
			prevOwner = &owner
			cur.OwnerClientID = sender
			cur.LastUpdatedAt = now
			accepted = true
			broadcast = true
		} else {
			accepted = false
		}
	}

	var (
		responseOwner *string
		currentOwner  string
	)
	if o, ok := ms.itemOwners[instanceID]; ok && o != nil {
		cp := o.OwnerClientID
		responseOwner = &cp
		currentOwner = cp
	}
	ms.mu.Unlock()

	if broadcast {
		senderCopy := sender
		payload := itemAuthorityChanged(instanceID, prevOwner, &senderCopy, "claim", now)
		ms.broadcastToAll("item-authority-changed", payload)
		log.Printf("[ItemAuthority] %s claimed by %s (prev=%v)", instanceID, sender, prevOwner)
	}

	resp := ItemAuthorityClaimResponse{
		OK:              true,
		Accepted:        accepted,
		InstanceID:      instanceID,
		OwnerClientID:   responseOwner,
		ServerTimestamp: now,
	}
	if !accepted {
		resp.CurrentOwnerID = currentOwner
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(resp)
}

// handleItemAuthorityRelease implements MULTIPLAYER_SYNCH.md §5.7.
func (ms *MultiplayerServer) handleItemAuthorityRelease(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPatch {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	sender := strings.TrimSpace(r.Header.Get("X-Client-ID"))
	if sender == "" {
		http.Error(w, "Missing X-Client-ID", http.StatusUnauthorized)
		return
	}

	var req ItemAuthorityReleaseRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid JSON", http.StatusBadRequest)
		return
	}
	instanceID := strings.TrimSpace(req.InstanceID)
	if instanceID == "" {
		http.Error(w, "Missing instanceId", http.StatusBadRequest)
		return
	}

	now := time.Now().UnixMilli()

	ms.mu.Lock()
	cur, exists := ms.itemOwners[instanceID]
	released := false
	var prevOwner *string
	if exists && cur != nil && cur.OwnerClientID == sender {
		owner := cur.OwnerClientID
		prevOwner = &owner
		delete(ms.itemOwners, instanceID)
		released = true
	}
	ms.mu.Unlock()

	if released {
		payload := itemAuthorityChanged(instanceID, prevOwner, nil, "release", now)
		ms.broadcastToAll("item-authority-changed", payload)
		log.Printf("[ItemAuthority] %s released by %s", instanceID, sender)
	}

	resp := ItemAuthorityReleaseResponse{
		OK:              true,
		Released:        released,
		InstanceID:      instanceID,
		ServerTimestamp: now,
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(resp)
}

// releaseItemsOwnedBy removes every entry in itemOwners owned by clientID and returns the
// per-instance metadata needed to broadcast item-authority-changed signals for each.
// Caller must hold ms.mu (write lock).
func (ms *MultiplayerServer) releaseItemsOwnedByLocked(clientID string) []string {
	released := make([]string, 0)
	for id, owner := range ms.itemOwners {
		if owner != nil && owner.OwnerClientID == clientID {
			delete(ms.itemOwners, id)
			released = append(released, id)
		}
	}
	return released
}

// broadcastAuthorityReleasesAfterDisconnect emits item-authority-changed signals with
// reason=disconnect for each instanceId whose owner just left.
func (ms *MultiplayerServer) broadcastAuthorityReleasesAfterDisconnect(clientID string, instanceIDs []string) {
	if len(instanceIDs) == 0 {
		return
	}
	now := time.Now().UnixMilli()
	cid := clientID
	for _, id := range instanceIDs {
		payload := itemAuthorityChanged(id, &cid, nil, "disconnect", now)
		ms.broadcastToAll("item-authority-changed", payload)
	}
	log.Printf("[ItemAuthority] disconnect released %d items previously owned by %s", len(instanceIDs), clientID)
}

// pushAuthoritySnapshotToSession replays the current authority state to a single session
// so late joiners learn ownership without waiting for the next transition (§6.8 bootstrap).
// It emits two event types:
//
//  1. An `item-authority-changed` replay for every entry in itemOwners (§4.7 explicit
//     per-item ownership).
//
//  2. An `env-item-authority-changed` event for every environment that currently has a
//     registered env-authority (§4.8 environment-item authority). This allows the arriving
//     client to immediately call seedMotionTypesForEnv and flip items it is not the
//     env-authority of to ANIMATED, instead of remaining in the ANIMATED-default-with-no-
//     promotion state until the next live transition arrives.
//
// MULTIPLAYER_SYNCH.md §4.5 SSE-open ordering (client contract): this function is called
// synchronously on SSE open, before client-joined and any item-state-update broadcasts.
func (ms *MultiplayerServer) pushAuthoritySnapshotToSession(sessionID string) {
	ms.mu.RLock()
	now := time.Now().UnixMilli()

	// Snapshot itemOwners.
	itemEntries := make([]map[string]interface{}, 0, len(ms.itemOwners))
	for id, owner := range ms.itemOwners {
		if owner == nil || owner.OwnerClientID == "" {
			continue
		}
		cid := owner.OwnerClientID
		itemEntries = append(itemEntries, itemAuthorityChanged(id, nil, &cid, "claim", now))
	}

	// Snapshot envAuthority.
	envEntries := make([]map[string]interface{}, 0, len(ms.envAuthority))
	for envName, authClientID := range ms.envAuthority {
		if envName == "" || authClientID == "" {
			continue
		}
		envEntries = append(envEntries, map[string]interface{}{
			"envName":         envName,
			"newAuthorityId":  authClientID,
			"prevAuthorityId": nil,
			"reason":          "snapshot",
			"timestamp":       now,
		})
	}
	ms.mu.RUnlock()

	for _, e := range itemEntries {
		_ = ms.sendToSession(sessionID, "item-authority-changed", e)
	}
	for _, e := range envEntries {
		_ = ms.sendToSession(sessionID, "env-item-authority-changed", e)
	}
}
