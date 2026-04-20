package main

import (
	"crypto/rand"
	"fmt"
	"math"
	"sync"
	"time"
)

var clientIDCounter int64
var clientIDMutex sync.Mutex

// generateClientID generates a unique client identifier
func generateClientID() string {
	clientIDMutex.Lock()
	defer clientIDMutex.Unlock()

	clientIDCounter++
	randBytes := make([]byte, 6)
	rand.Read(randBytes)

	return fmt.Sprintf("client-%d-%x", time.Now().Unix(), randBytes)
}

// generateSessionID generates a unique session token
func generateSessionID() string {
	randBytes := make([]byte, 16)
	rand.Read(randBytes)
	return fmt.Sprintf("%x", randBytes)
}

// validateClientID checks if a client ID is well-formed
func validateClientID(id string) bool {
	return len(id) > 0 && len(id) < 256
}

// validateVector3 checks if a vector is within reasonable bounds
func validateVector3(x, y, z float64) bool {
	const maxDistance = 10000.0
	distSq := x*x + y*y + z*z
	return !math.IsNaN(x) && !math.IsNaN(y) && !math.IsNaN(z) &&
		!math.IsInf(x, 0) && !math.IsInf(y, 0) && !math.IsInf(z, 0) &&
		distSq <= maxDistance*maxDistance
}

// validateEulerAngles checks if Euler angles are within valid range [-2π, 2π]
func validateEulerAngles(x, y, z float64) bool {
	const maxAngle = 2 * math.Pi
	return !math.IsNaN(x) && !math.IsNaN(y) && !math.IsNaN(z) &&
		!math.IsInf(x, 0) && !math.IsInf(y, 0) && !math.IsInf(z, 0) &&
		math.Abs(x) <= maxAngle && math.Abs(y) <= maxAngle && math.Abs(z) <= maxAngle
}

// validateQuaternion checks if quaternion is normalized (length ≈ 1.0)
func validateQuaternion(x, y, z, w float64) bool {
	if math.IsNaN(x) || math.IsNaN(y) || math.IsNaN(z) || math.IsNaN(w) {
		return false
	}
	if math.IsInf(x, 0) || math.IsInf(y, 0) || math.IsInf(z, 0) || math.IsInf(w, 0) {
		return false
	}

	lengthSq := x*x + y*y + z*z + w*w
	const tolerance = 0.01 // Allow slight denormalization
	return math.Abs(lengthSq-1.0) < tolerance
}

// validateColor checks if RGB/RGBA values are valid [0, 1]
func validateColor(components []float64) bool {
	if len(components) < 3 || len(components) > 4 {
		return false
	}
	for _, c := range components {
		if math.IsNaN(c) || math.IsInf(c, 0) || c < 0 || c > 1 {
			return false
		}
	}
	return true
}

// validateAnimationState checks if animation state is valid
func validateAnimationState(state string) bool {
	validStates := map[string]bool{
		"idle": true,
		"walk": true,
		"run":  true,
		"jump": true,
		"fall": true,
	}
	return validStates[state]
}

// validateTimestamp checks if timestamp is recent (within 30 seconds)
func validateTimestamp(timestamp int64) bool {
	now := time.Now().UnixMilli()
	diff := now - timestamp
	return diff >= 0 && diff < 30000 // Allow up to 30 seconds old
}

// validateBoostType checks if boost type is valid
func validateBoostType(boostType string) bool {
	validBoosts := map[string]bool{
		"superJump":    true,
		"invisibility": true,
	}
	return boostType == "" || validBoosts[boostType] // Empty string means no boost
}

// validateLightType checks if light type is valid
func validateLightType(lightType string) bool {
	validTypes := map[string]bool{
		"POINT":            true,
		"DIRECTIONAL":      true,
		"SPOT":             true,
		"HEMISPHERIC":      true,
		"RECTANGULAR_AREA": true,
	}
	return validTypes[lightType]
}

// validateSkyEffectType checks if sky effect type is valid
func validateSkyEffectType(effectType string) bool {
	validTypes := map[string]bool{
		"base":          true,
		"heatLightning": true,
		"colorBlend":    true,
		"colorTint":     true,
	}
	return validTypes[effectType]
}

// validateAnimationFrame checks if animation frame is in valid range [0, 1]
func validateAnimationFrame(frame float64) bool {
	return !math.IsNaN(frame) && !math.IsInf(frame, 0) && frame >= 0 && frame <= 1
}

// validateIntensity checks if light intensity is valid
func validateIntensity(intensity float64) bool {
	const maxIntensity = 2.0
	return !math.IsNaN(intensity) && !math.IsInf(intensity, 0) &&
		intensity >= 0 && intensity <= maxIntensity
}

// validateRange checks if light range is valid
func validateRange(r float64) bool {
	const maxRange = 5000.0
	return !math.IsNaN(r) && !math.IsInf(r, 0) && r > 0 && r <= maxRange
}

// validateAngle checks if angle (for spot lights) is valid in [0, 2π]
func validateAngle(angle float64) bool {
	return !math.IsNaN(angle) && !math.IsInf(angle, 0) &&
		angle >= 0 && angle <= 2*math.Pi
}

// CurrentTimeMs returns current time in milliseconds since epoch
func CurrentTimeMs() int64 {
	return time.Now().UnixMilli()
}

// IsOutOfDate checks if an update is too old
func IsOutOfDate(timestamp int64, maxAgeMs int64) bool {
	return CurrentTimeMs()-timestamp > maxAgeMs
}
