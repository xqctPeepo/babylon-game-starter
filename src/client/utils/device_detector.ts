/**
 * Device detection utilities for determining device type and capabilities
 */
export class DeviceDetector {
  /**
   * Detects if the current device is a mobile device
   */
  public static isMobileDevice(): boolean {
    return (
      /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent) ||
      'ontouchstart' in window ||
      navigator.maxTouchPoints > 0
    );
  }

  /**
   * Detects if the current device is an iPad
   */
  public static isIPad(): boolean {
    // More specific iPad detection
    return (
      /iPad/i.test(navigator.userAgent) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 0)
    );
  }

  /**
   * Detects if the current iPad device has a keyboard attached
   */
  public static isIPadWithKeyboard(): boolean {
    if (!this.isIPad()) return false;

    // Check for keyboard presence using various methods
    const hasKeyboard = this.checkForKeyboardPresence();
    const hasExternalKeyboard = this.checkForExternalKeyboard();

    return hasKeyboard || hasExternalKeyboard;
  }

  /**
   * Checks for keyboard presence by comparing viewport and screen heights
   */
  private static checkForKeyboardPresence(): boolean {
    // Method 1: Check if virtual keyboard is likely present
    // This is not 100% reliable but gives us a good indication
    const viewportHeight = window.innerHeight;
    const screenHeight = window.screen.height;
    const keyboardLikelyPresent = viewportHeight < screenHeight * 0.8;

    return keyboardLikelyPresent;
  }

  /**
   * Checks for external keyboard by monitoring keyboard events
   */
  private static checkForExternalKeyboard(): boolean {
    // Method 2: Check for external keyboard events
    // We'll track if we receive keyboard events that suggest an external keyboard
    let keyboardEventCount = 0;
    const keyboardThreshold = 3; // Number of events to consider keyboard present

    const checkKeyboardEvents = (event: KeyboardEvent) => {
      // Only count events that are likely from a physical keyboard
      // (not virtual keyboard events which often have different characteristics)
      if (
        event.key.length === 1 ||
        ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'Shift'].includes(event.key)
      ) {
        keyboardEventCount++;

        if (keyboardEventCount >= keyboardThreshold) {
          // Remove the listener once we've confirmed keyboard presence
          document.removeEventListener('keydown', checkKeyboardEvents);
          if (keyboardDetectionTimeout) {
            clearTimeout(keyboardDetectionTimeout);
            keyboardDetectionTimeout = null;
          }
          return true;
        }
      }
      return false;
    };

    // Add listener for a short period to detect keyboard
    document.addEventListener('keydown', checkKeyboardEvents);

    // Use setTimeout instead of scene observable for keyboard detection
    let keyboardDetectionTimeout: number | null = window.setTimeout(() => {
      document.removeEventListener('keydown', checkKeyboardEvents);
    }, 5000);

    return false; // Will be updated by the event listener
  }
}
