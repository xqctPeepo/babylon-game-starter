export type OverlayPosition = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';

export interface LocalDevDebugConfig {
  enabled: boolean;
  requireDebugParam: boolean;
  paramName: string;
  overlays: {
    fps: {
      enabled: boolean;
      position: OverlayPosition;
    };
    stats: {
      enabled: boolean;
      position: OverlayPosition;
      fields: {
        engine: boolean;
        meshes: boolean;
        lights: boolean;
        cameras: boolean;
        materials: boolean;
      };
    };
  };
}

export const LOCAL_DEV_DEBUG: LocalDevDebugConfig = {
  enabled: true,
  requireDebugParam: true,
  paramName: 'debug',
  overlays: {
    fps: {
      enabled: true,
      position: 'bottom-right'
    },
    stats: {
      enabled: true,
      position: 'bottom-left',
      fields: {
        engine: true,
        meshes: true,
        lights: true,
        cameras: true,
        materials: true
      }
    }
  }
};
