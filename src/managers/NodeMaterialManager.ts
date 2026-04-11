// ============================================================================
// NODE MATERIAL MANAGER
// ============================================================================

export class NodeMaterialManager {
    private static scene: BABYLON.Scene | null = null;
    private static activeNodeMaterials: Map<string, BABYLON.NodeMaterial> = new Map();

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

        // Check if mesh name contains #nm pattern
        const nmMatch = mesh.name.match(/#nm([A-Z0-9]+)/);
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
                // Parse the node material from the snippet only if not cached
                nodeMaterial = await BABYLON.NodeMaterial.ParseFromSnippetAsync(snippetId, this.scene);

                if (nodeMaterial) {
                    // Store the node material for reuse (keyed by snippet ID)
                    this.activeNodeMaterials.set(snippetId, nodeMaterial);
                }
            }

            if (nodeMaterial) {
                // Apply the node material to the mesh
                mesh.material = nodeMaterial;
            }
        } catch (_error) {
            // Silently handle errors to match playground manager style
        }
    }

    /**
     * Processes meshes from a model import result
     */
    public static async processImportResult(result: { meshes: BABYLON.AbstractMesh[] }): Promise<void> {
        if (!this.scene) {
            return;
        }

        if (result.meshes) {
            for (const mesh of result.meshes) {
                if (mesh instanceof BABYLON.Mesh) {
                    await this.processMeshForNodeMaterial(mesh);
                }
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
        this.activeNodeMaterials.forEach(material => {
            material.dispose();
        });
        this.activeNodeMaterials.clear();
        this.scene = null;
    }
}
