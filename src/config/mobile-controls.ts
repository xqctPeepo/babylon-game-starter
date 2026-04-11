// ============================================================================
// MOBILE CONTROLS CONFIGURATION
// ============================================================================

export const MOBILE_CONTROLS = {
    JOYSTICK_RADIUS: 60,
    JOYSTICK_DEADZONE: 10,
    BUTTON_SIZE: 80,
    BUTTON_SPACING: 20,
    OPACITY: 0.7,
    COLORS: {
        JOYSTICK_BG: '#333333',
        JOYSTICK_STICK: '#ffffff',
        BUTTON_BG: '#444444',
        BUTTON_ACTIVE: '#00ff88',
        BUTTON_TEXT: '#ffffff'
    },
    POSITIONS: {
        JOYSTICK: {
            BOTTOM: 120,
            LEFT: 0
        },
        JUMP_BUTTON: {
            BOTTOM: 220, // Above boost button
            RIGHT: 0
        },
        BOOST_BUTTON: {
            BOTTOM: 120, // Bottom right
            RIGHT: 0
        }
    },
    VISIBILITY: {
        SHOW_JOYSTICK: true,
        SHOW_JUMP_BUTTON: true,
        SHOW_BOOST_BUTTON: true
    }
} as const;
