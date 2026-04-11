// ============================================================================
// CHARACTER STATES CONFIGURATION
// ============================================================================

export const CHARACTER_STATES = {
    IN_AIR: "IN_AIR",
    ON_GROUND: "ON_GROUND",
    START_JUMP: "START_JUMP"
} as const;

export type CharacterState = typeof CHARACTER_STATES[keyof typeof CHARACTER_STATES];
