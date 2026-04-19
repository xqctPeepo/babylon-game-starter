// ============================================================================
// CUTSCENE MANAGER
// ============================================================================
// Handles fullscreen cutscene display with image/video and optional audio
// ============================================================================

import { Time } from '../utils/time';

import type { CutScene } from '../types/environment';

const DEFAULT_FADE_DURATION_MS = 600;

export class CutSceneManager {
  private static getFadeDurationMs(cutScene: CutScene): number {
    const d = cutScene.fadeDurationMs;
    return typeof d === 'number' && Number.isFinite(d) && d > 0 ? d : DEFAULT_FADE_DURATION_MS;
  }

  /**
   * Animates an element's opacity from `from` to `to` over `durationMs` (CSS transition + timeout).
   */
  private static animateElementOpacity(
    element: HTMLElement,
    from: number,
    to: number,
    durationMs: number
  ): Promise<void> {
    if (durationMs <= 0) {
      element.style.opacity = String(to);
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      element.style.transition = `opacity ${durationMs}ms ease-in-out`;
      element.style.opacity = String(from);
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          element.style.opacity = String(to);
          window.setTimeout(() => {
            element.style.transition = '';
            resolve();
          }, durationMs);
        });
      });
    });
  }

  /**
   * Plays a cutscene with fullscreen display
   * @param scene The Babylon.js scene to use for timing
   * @param cutScene The cutscene configuration to play
   * @returns Promise that resolves when the cutscene completes
   */
  public static async playCutScene(scene: BABYLON.Scene, cutScene: CutScene): Promise<void> {
    const fadeMs = CutSceneManager.getFadeDurationMs(cutScene);
    const fadeInEnabled = cutScene.fadeInEnabled === true;
    const fadeOutEnabled = cutScene.fadeOutEnabled === true;

    // Create fullscreen overlay container
    const overlay = document.createElement('div');
    overlay.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            width: 100vw;
            height: 100vh;
            z-index: 10000;
            background: #000000;
            display: flex;
            align-items: center;
            justify-content: center;
        `;

    let audioElement: HTMLAudioElement | null = null;
    let fadeObserver: BABYLON.Observer<BABYLON.Scene> | null = null;
    let cleanupObserver: BABYLON.Observer<BABYLON.Scene> | null = null;
    try {
      // Create audio element if audioUrl is provided
      if (cutScene.audioUrl) {
        audioElement = document.createElement('audio');
        audioElement.src = cutScene.audioUrl;
        audioElement.autoplay = true;
        audioElement.volume = 1.0;
        try {
          await audioElement.play();
        } catch {
          // Autoplay may fail in some browsers, continue without audio
        }
      }

      // Handle image type
      if (cutScene.type === 'image') {
        document.body.appendChild(overlay);

        const img = document.createElement('img');
        img.src = cutScene.visualUrl;
        img.style.cssText = `
                    width: 100%;
                    height: 100%;
                    object-fit: cover;
                    opacity: ${fadeInEnabled ? 0 : 1};
                `;
        overlay.appendChild(img);

        // Wait for image to load
        await new Promise<void>((resolve) => {
          img.onload = () => {
            resolve();
          };
          img.onerror = () => {
            resolve();
          };
        });

        if (fadeInEnabled) {
          await CutSceneManager.animateElementOpacity(img, 0, 1, fadeMs);
        }

        // Start audio fade-out at 9 seconds (1 second before end)
        if (audioElement) {
          const fadeStartTime = performance.now();
          fadeObserver = scene.onBeforeRenderObservable.add(() => {
            const elapsed = performance.now() - fadeStartTime;
            if (elapsed >= 9000) {
              const fadeProgress = Math.min((elapsed - 9000) / 1000, 1.0);
              if (audioElement) {
                audioElement.volume = Math.max(0, 1.0 - fadeProgress);
              }
            }
          });
        }

        await new Promise<void>((resolve) => {
          Time.runDelayed(scene, 10000, () => {
            resolve();
          });
        });

        if (fadeOutEnabled) {
          await CutSceneManager.animateElementOpacity(img, 1, 0, fadeMs);
        }
      }
      // Handle video type
      else if (cutScene.type === 'video') {
        const video = document.createElement('video');
        video.src = cutScene.visualUrl;
        video.autoplay = true;
        video.playsInline = true;
        video.muted = false;
        video.style.cssText = `
                    width: 100%;
                    height: 100%;
                    object-fit: cover;
                    opacity: ${fadeInEnabled ? 0 : 1};
                `;
        overlay.appendChild(video);

        document.body.appendChild(overlay);

        await new Promise<void>((resolve, reject) => {
          video.onloadeddata = async () => {
            try {
              await video.play();
              resolve();
            } catch {
              video.muted = true;
              try {
                await video.play();
                resolve();
              } catch {
                reject(new Error('Failed to play cutscene video'));
              }
            }
          };
          video.onerror = () => {
            reject(new Error('Failed to load cutscene video'));
          };
        });

        if (fadeInEnabled) {
          await CutSceneManager.animateElementOpacity(video, 0, 1, fadeMs);
        }

        if (audioElement) {
          cleanupObserver = scene.onBeforeRenderObservable.add(() => {
            if (video.readyState >= 2) {
              const duration = video.duration;
              const currentTime = video.currentTime;
              if (duration > 0 && currentTime > 0 && duration - currentTime <= 1.0) {
                const fadeProgress = 1.0 - (duration - currentTime) / 1.0;
                if (audioElement) {
                  audioElement.volume = Math.max(0, 1.0 - fadeProgress);
                }
              }
            }
          });
        }

        await new Promise<void>((resolve) => {
          video.onended = () => {
            resolve();
          };
        });

        if (fadeOutEnabled) {
          await CutSceneManager.animateElementOpacity(video, 1, 0, fadeMs);
        }
      }

      if (audioElement) {
        audioElement.pause();
        audioElement.currentTime = 0;
      }
    } finally {
      if (fadeObserver) {
        scene.onBeforeRenderObservable.remove(fadeObserver);
      }
      if (cleanupObserver) {
        scene.onBeforeRenderObservable.remove(cleanupObserver);
      }

      if (overlay.parentElement) {
        overlay.remove();
      }
      if (audioElement && audioElement.parentElement) {
        audioElement.remove();
      }
    }
  }
}
