// ============================================================================
// CAMERA MANAGER
// ============================================================================

import type { SmoothFollowCameraController } from '../controllers/smooth_follow_camera_controller';

export class CameraManager {
  private static smoothFollowController: SmoothFollowCameraController | null = null;

  /**
   * Initializes the CameraManager with a smooth follow camera controller
   * @param controller The SmoothFollowCameraController instance
   */
  public static initialize(controller: SmoothFollowCameraController): void {
    this.smoothFollowController = controller;
  }

  /**
   * Sets the camera offset
   * @param offset The new camera offset vector
   */
  public static setOffset(offset: BABYLON.Vector3): void {
    if (this.smoothFollowController) {
      this.smoothFollowController.setOffset(offset);
    }
  }

  /**
   * Disposes the CameraManager and clears the controller reference
   */
  public static dispose(): void {
    this.smoothFollowController = null;
  }
}

const globalWithCameraManager = globalThis as typeof globalThis & {
  CameraManager?: typeof CameraManager;
};

globalWithCameraManager.CameraManager = CameraManager;
