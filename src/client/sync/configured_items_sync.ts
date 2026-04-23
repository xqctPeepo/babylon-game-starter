// ============================================================================
// CONFIGURED ITEMS SYNC — replicate `environment.items` (collectibles + cake)
// ============================================================================
//
// Mirrors `environment_physics_sync.ts` but for items spawned by the
// `CollectiblesManager` (both collectibles such as Presents and non-collectible
// physics items such as Cake). Replication splits along the hybrid authority model
// defined in MULTIPLAYER_SYNCH.md:
//
//   - Non-collectible dynamic items (e.g. Cake) use **per-item authority**
//     (§4.7 / §7.5). Only the current item owner publishes transform rows.
//     (../../../MULTIPLAYER_SYNCH.md#47-item-authority-lifecycle)
//   - Collectibles (e.g. Presents) use **first-write-wins collection events**
//     (§5.2). Transform is bootstrap-only and MAY be emitted by the base
//     synchronizer. (../../../MULTIPLAYER_SYNCH.md#52-item-state)
//
// Today's implementation still samples from whichever client is the base
// synchronizer; the per-item-authority implementation plan layers the
// claim/release and owner-check logic on top of this module.

import { CollectiblesManager } from '../managers/collectibles_manager';
import {
  meshRotationToWireQuaternion
} from '../utils/multiplayer_serialization';

import { ItemSync } from './item_sync';
import { clampCoordComponent } from './multiplayer_wire_guards';

import type { ItemCollectionEvent, ItemInstanceState } from '../types/multiplayer';

/** Separator used when env-scoping a local CollectiblesManager instance id onto the wire. */
const ENV_ITEM_SEPARATOR = '::';

export function envScopedInstanceId(environmentName: string, localId: string): string {
  return `${environmentName}${ENV_ITEM_SEPARATOR}${localId}`;
}

export function parseEnvScopedInstanceId(
  wireInstanceId: string
): { envName: string; localId: string } | null {
  const idx = wireInstanceId.indexOf(ENV_ITEM_SEPARATOR);
  if (idx <= 0) {
    return null;
  }
  const envName = wireInstanceId.slice(0, idx);
  const localId = wireInstanceId.slice(idx + ENV_ITEM_SEPARATOR.length);
  if (!envName || !localId) {
    return null;
  }
  return { envName, localId };
}

function velocityFromAggregate(
  body: BABYLON.PhysicsAggregate | null
): [number, number, number] {
  if (!body || body.body.isDisposed) {
    return [0, 0, 0];
  }
  try {
    const v = body.body.getLinearVelocity();
    return [
      clampCoordComponent(v.x),
      clampCoordComponent(v.y),
      clampCoordComponent(v.z)
    ];
  } catch {
    return [0, 0, 0];
  }
}

function absolutePositionTriplet(
  mesh: BABYLON.AbstractMesh
): [number, number, number] | null {
  try {
    const p = mesh.getAbsolutePosition ? mesh.getAbsolutePosition() : mesh.absolutePosition;
    return [clampCoordComponent(p.x), clampCoordComponent(p.y), clampCoordComponent(p.z)];
  } catch {
    return null;
  }
}

/**
 * Builds `ItemInstanceState` rows for every collectible + non-collectible physics item
 * tracked by the CollectiblesManager. Uses env-scoped instance ids so non-synchronizer
 * clients filter by their current environment, and preserves the config `name` on the
 * wire's `itemName` field so the routing in the bootstrap can distinguish these rows
 * from `ENV_PHYSICS_ITEM_MARKER` rows.
 */
export function sampleConfiguredItems(
  environmentName: string
): ItemInstanceState[] {
  if (environmentName.trim() === '') {
    return [];
  }

  const ts = Date.now();
  const out: ItemInstanceState[] = [];

  const push = (
    id: string,
    entry: { mesh: BABYLON.AbstractMesh; body: BABYLON.PhysicsAggregate | null; config: { name: string } }
  ): void => {
    const mesh = entry.mesh;
    if (!mesh || mesh.isDisposed()) {
      return;
    }
    const isCollected = CollectiblesManager.isCollectedInstance(id);
    const pos = absolutePositionTriplet(mesh);
    if (!pos) {
      return;
    }
    out.push({
      instanceId: envScopedInstanceId(environmentName, id),
      itemName: entry.config.name,
      position: pos,
      rotation: meshRotationToWireQuaternion(mesh),
      velocity: isCollected ? [0, 0, 0] : velocityFromAggregate(entry.body),
      isCollected,
      timestamp: ts
    });
  };

  for (const [id, entry] of CollectiblesManager.getCollectibleEntries()) {
    push(id, entry);
  }
  for (const [id, entry] of CollectiblesManager.getPhysicsItemEntries()) {
    push(id, entry);
  }

  return out;
}

/** Non-synchronizer apply: transform teleport + collection gating for configured items. */
export function applyRemoteConfiguredItemState(
  currentEnvironmentName: string,
  state: ItemInstanceState
): void {
  const parsed = parseEnvScopedInstanceId(state.instanceId);
  if (!parsed || parsed.envName !== currentEnvironmentName) {
    return;
  }

  if (state.isCollected) {
    // Silent reconciliation branch. Per MULTIPLAYER_SYNCH.md §6.2 rule 1, the canonical
    // feedback channel for remote collections is `collections[]` (see
    // `applyRemoteConfiguredCollections` below, which routes through the feedback variant).
    // If an `updates[]` row with `isCollected: true` arrives alongside or after that
    // event, firing feedback again would produce two particle bursts / two sounds. This
    // branch therefore stays silent.
    if (!CollectiblesManager.isCollectedInstance(parsed.localId)) {
      CollectiblesManager.applyRemoteCollected(parsed.localId);
    }
    return;
  }

  const handle = CollectiblesManager.getMeshAndBody(parsed.localId);
  if (!handle) {
    return;
  }

  ItemSync.applyRemoteItemState(handle.mesh, state, handle.body);
}

/** Applies explicit `ItemCollectionEvent`s received from the server. */
export function applyRemoteConfiguredCollections(
  currentEnvironmentName: string,
  collections: readonly ItemCollectionEvent[]
): void {
  for (const ev of collections) {
    const parsed = parseEnvScopedInstanceId(ev.instanceId);
    if (!parsed || parsed.envName !== currentEnvironmentName) {
      continue;
    }
    if (CollectiblesManager.isCollectedInstance(parsed.localId)) {
      continue;
    }
    // MULTIPLAYER_SYNCH.md §6.2 rule 1 "Remote-collect feedback parity": observers
    // play the same particle burst + spatialized collection sound as the collector.
    // No credits / inventory / scoring side-effects — those stay on the collector.
    CollectiblesManager.applyRemoteCollectedWithFeedback(parsed.localId);
  }
}
