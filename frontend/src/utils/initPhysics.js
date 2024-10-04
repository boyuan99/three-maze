import * as THREE from 'three';

import RAPIER from '@dimforge/rapier3d-compat';

export async function initPhysics() {
  await RAPIER.init();
  const gravity = { x: 0.0, y: -9.81, z: 0.0 };
  const world = new RAPIER.World(gravity);

  return world;
}

export function addPhysicsToHallway(hallway, world) {
  hallway.traverse((child) => {
    if (child.isMesh) {
      // Update the world matrix of the child
      child.updateWorldMatrix(true, false);

      // Compute the bounding box in world space
      const bbox = new THREE.Box3().setFromObject(child);
      const size = new THREE.Vector3();
      bbox.getSize(size);

      const position = new THREE.Vector3();
      bbox.getCenter(position);

      // Create a fixed rigid body at the position of the child mesh
      const bodyDesc = RAPIER.RigidBodyDesc.fixed().setTranslation(
        position.x,
        position.y,
        position.z
      );
      const body = world.createRigidBody(bodyDesc);

      // Create a collider matching the dimensions of the child mesh
      const colliderDesc = RAPIER.ColliderDesc.cuboid(
        size.x / 2,
        size.y / 2,
        size.z / 2
      )
        .setRestitution(0)
        .setFriction(1);

      world.createCollider(colliderDesc, body);
    }
  });
}

export function createPlayer(world) {
  const playerRadius = 1; // Adjust as needed
  const playerHeight = 1; // For a capsule collider, adjust as needed

  // Create a dynamic rigid body for the player
  const playerBodyDesc = RAPIER.RigidBodyDesc.dynamic()
    .setTranslation(0, playerHeight / 2 + 1, 0) // Start above the ground
    .setLinearDamping(0.9)
    .setAngularDamping(0.9)
    .setAdditionalMass(1);

  const playerBody = world.createRigidBody(playerBodyDesc);

  // Create a capsule collider for the player
  const colliderDesc = RAPIER.ColliderDesc.capsule(playerHeight / 2, playerRadius)
    .setRestitution(0)
    .setFriction(1);

  world.createCollider(colliderDesc, playerBody);

  return playerBody;
}
