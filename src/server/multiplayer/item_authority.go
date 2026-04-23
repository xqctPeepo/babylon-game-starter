package main

import (
	"encoding/json"
	"log"
	"net/http"
	"strings"
	"time"
)

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

// pushAuthoritySnapshotToSession replays the current itemOwners map to a single session so
// late joiners learn ownership without waiting for the next transition (§6.8 bootstrap).
func (ms *MultiplayerServer) pushAuthoritySnapshotToSession(sessionID string) {
	ms.mu.RLock()
	entries := make([]map[string]interface{}, 0, len(ms.itemOwners))
	now := time.Now().UnixMilli()
	for id, owner := range ms.itemOwners {
		if owner == nil || owner.OwnerClientID == "" {
			continue
		}
		cid := owner.OwnerClientID
		entries = append(entries, itemAuthorityChanged(id, nil, &cid, "claim", now))
	}
	ms.mu.RUnlock()

	for _, e := range entries {
		_ = ms.sendToSession(sessionID, "item-authority-changed", e)
	}
}
