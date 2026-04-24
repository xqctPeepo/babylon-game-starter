// ============================================================================
// NODE MATERIAL MANAGER
// ============================================================================

export class NodeMaterialManager {
  private static scene: BABYLON.Scene | null = null;
  private static activeNodeMaterials = new Map<string, BABYLON.NodeMaterial>();

  /** Mesh name must include `#nmSnippetId` for NME substitution (most GLBs, e.g. Red crewmate, use standard materials only). */
  private static readonly NM_SNIPPET_NAME_PATTERN = /#nm([A-Z0-9]+)/;

  private static hasInitializedAnimatedInputs(nodeMaterial: BABYLON.NodeMaterial): boolean {
    return Reflect.get(nodeMaterial, 'animatedInputs') !== null;
  }

  /**
   * Initializes the NodeMaterialManager with a scene
   */
  public static initialize(scene: BABYLON.Scene): void {
    this.scene = scene;
  }

  /**
   * Processes a specific mesh to check for #nmSnippetId pattern and apply node material
   * @param mesh The mesh to process
   */
  public static async processMeshForNodeMaterial(mesh: BABYLON.Mesh): Promise<void> {
    if (!this.scene) {
      return;
    }

    const nmMatch = NodeMaterialManager.NM_SNIPPET_NAME_PATTERN.exec(mesh.name);
    if (!nmMatch) {
      return; // No node material snippet ID found
    }

    const snippetId = nmMatch[1];
    if (!snippetId || snippetId.length === 0) {
      return; // No valid snippet ID found
    }

    try {
      // Check if we already have this node material cached
      let nodeMaterial = this.activeNodeMaterials.get(snippetId);

      if (!nodeMaterial) {
        try {
          // Parse the node material from the snippet only if not cached
          nodeMaterial = await BABYLON.NodeMaterial.ParseFromSnippetAsync(snippetId, this.scene);

          if (!nodeMaterial || typeof nodeMaterial !== 'object') {
            return; // Failed to parse
          }

          // Guard: ensure internal state is fully initialized before use.
          // animatedInputs being null indicates an incomplete build which would
          // crash the render loop — force a rebuild to resolve it.
          if (!this.hasInitializedAnimatedInputs(nodeMaterial)) {
            try {
              nodeMaterial.build(false);
            } catch {
              return; // Material is not usable
            }
          }

          // Final safety check before caching
          if (!this.hasInitializedAnimatedInputs(nodeMaterial)) {
            return; // Still not initialized — skip to avoid render-loop crash
          }

          // Store the node material for reuse (keyed by snippet ID)
          this.activeNodeMaterials.set(snippetId, nodeMaterial);
        } catch {
          return; // Parsing failed
        }
      }

      if (nodeMaterial) {
        try {
          // Apply the node material to the mesh
          mesh.material = nodeMaterial;
        } catch {
          // Failed to apply material
        }
      }
    } catch {
      // Silently handle errors to match playground manager style
    }
  }

  /**
   * Processes meshes from a model import result (NME snippets in mesh names only).
   * No-op when the asset has no `#nm…` markers — typical for glTF PBR like the Red character.
   */
  public static async processImportResult(result: {
    meshes: BABYLON.AbstractMesh[];
  }): Promise<void> {
    if (!this.scene || !result.meshes?.length) {
      return;
    }

    let anyNodeMaterialMesh = false;
    for (const mesh of result.meshes) {
      if (mesh instanceof BABYLON.Mesh && NodeMaterialManager.NM_SNIPPET_NAME_PATTERN.test(mesh.name)) {
        anyNodeMaterialMesh = true;
        break;
      }
    }
    if (!anyNodeMaterialMesh) {
      return;
    }

    for (const mesh of result.meshes) {
      if (mesh instanceof BABYLON.Mesh) {
        await this.processMeshForNodeMaterial(mesh);
      }
    }
  }

  /**
   * Processes meshes for node materials
   */
  public static async processMeshesForNodeMaterials(): Promise<void> {
    if (!this.scene) {
      return;
    }

    // Process all meshes in the scene
    for (const mesh of this.scene.meshes) {
      if (mesh instanceof BABYLON.Mesh) {
        await this.processMeshForNodeMaterial(mesh);
      }
    }
  }

  /**
   * Gets a node material by name
   */
  public static getNodeMaterial(name: string): BABYLON.NodeMaterial | undefined {
    return this.activeNodeMaterials.get(name);
  }

  /**
   * Gets all active node materials
   */
  public static getActiveNodeMaterials(): Map<string, BABYLON.NodeMaterial> {
    return new Map(this.activeNodeMaterials);
  }

  /**
   * Disposes of the NodeMaterialManager
   */
  public static dispose(): void {
    this.activeNodeMaterials.forEach((material) => {
      material.dispose();
    });
    this.activeNodeMaterials.clear();
    this.scene = null;
  }
}
