import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import config from '@tmroot/config.json';

export async function initPhysics() {
  await RAPIER.init();
  const world = new RAPIER.World(config.physics.gravity);
  return world;
}

export function addPhysicsToHallway(hallway, world) {
  hallway.traverse((child) => {
    if (child.isMesh) {
      child.updateWorldMatrix(true, false);
      const bbox = new THREE.Box3().setFromObject(child);
      const size = new THREE.Vector3();
      bbox.getSize(size);
      const position = new THREE.Vector3();
      bbox.getCenter(position);

      const bodyDesc = RAPIER.RigidBodyDesc.fixed().setTranslation(
        position.x,
        position.y,
        position.z
      );
      const body = world.createRigidBody(bodyDesc);

      const colliderDesc = RAPIER.ColliderDesc.cuboid(
        size.x / 2,
        size.y / 2,
        size.z / 2
      )
        .setRestitution(config.player.collider.restitution)
        .setFriction(config.player.collider.friction);

      world.createCollider(colliderDesc, body);
    }
  });
}

export function createPlayer(world) {
  const playerRadius = config.player.radius;
  const playerHeight = config.player.height;

  const playerBodyDesc = RAPIER.RigidBodyDesc.dynamic()
    .setTranslation(
      config.player.startPosition.x,
      config.player.startPosition.y + playerHeight / 2,
      config.player.startPosition.z
    )
    .setLinearDamping(config.physics.linearDamping)
    .setAngularDamping(config.physics.angularDamping)
    .setAdditionalMass(config.player.mass);

  const playerBody = world.createRigidBody(playerBodyDesc);

  const colliderDesc = RAPIER.ColliderDesc.capsule(playerHeight / 2, playerRadius)
    .setRestitution(config.player.collider.restitution)
    .setFriction(config.player.collider.friction);

  world.createCollider(colliderDesc, playerBody);

  return playerBody;
}