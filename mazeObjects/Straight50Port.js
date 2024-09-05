import * as THREE from 'three';
import '../style.css';
import { createTexturedHallway } from './HallwayModule.js';
import { RapierDebugRenderer } from "../utils/RapierDebugRenderer";
import RAPIER from '@dimforge/rapier3d-compat';

async function init() {
    // Scene setup
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
    const renderer = new THREE.WebGLRenderer();
    renderer.setSize(window.innerWidth, window.innerHeight);
    document.body.appendChild(renderer.domElement);

    // Lighting
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
    scene.add(ambientLight);
    const directionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
    directionalLight.position.set(0, 20, 0);
    scene.add(directionalLight);

    // Initialize Rapier Physics World
    await RAPIER.init();
    const gravity = { x: 0.0, y: -9.81, z: 0.0 };
    const world = new RAPIER.World(gravity);

    const rapierDebugRenderer = new RapierDebugRenderer(scene, world);

    // Load the textured hallway
    const hallway = createTexturedHallway();
    scene.add(hallway);

    // Adding physics to the hallway
    hallway.children.forEach(child => {
        child.geometry.computeBoundingBox();
        const bbox = child.geometry.boundingBox;
        const width = bbox.max.x - bbox.min.x;
        const height = bbox.max.y - bbox.min.y;
        const depth = bbox.max.z - bbox.min.z;
        const { x: px, y: py, z: pz } = child.position;
        const body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(px, py, pz));
        const collider = world.createCollider(RAPIER.ColliderDesc.cuboid(width / 2, height / 2, depth / 2).setRestitution(0).setFriction(1), body);
    });

    // Physics for the ball (player)
    const playerRadius = 1;
    const playerBodyDesc = RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(0, 1, 0)
        .setLinearDamping(0.9)
        .setAngularDamping(0.9)
        .setAdditionalMass(1);

    const playerBody = world.createRigidBody(playerBodyDesc);
    const playerCollider = world.createCollider(RAPIER.ColliderDesc.ball(playerRadius).setRestitution(0).setFriction(1), playerBody);

    // Socket.IO connection
    const socket = io('http://localhost:8765');

    let latestSensorData = null;

    socket.on('sensor_data', function(data) {
        latestSensorData = data;
    });

    function updatePlayerMovement() {
        if (latestSensorData) {
            const { x, y, vx, vy, angle, angular_velocity } = latestSensorData;

            const moveForce = new THREE.Vector3(vx, 0, vy);
            moveForce.multiplyScalar(1000); // Increased force magnitude

            playerBody.applyImpulse(moveForce, true);
            playerBody.setAngvel({ x: 0, y: angular_velocity, z: 0 }, true);

            updateCameraPositionAndOrientation(angle);
        }
    }

    function updateCameraPositionAndOrientation(angle) {
        const playerPosition = playerBody.translation();
        camera.position.set(playerPosition.x, playerPosition.y, playerPosition.z);
        camera.rotation.y = -angle;
    }

    // Animation loop
    function animate() {
        requestAnimationFrame(animate);

        updatePlayerMovement();
        rapierDebugRenderer.update();
        world.step();

        const playerPosition = playerBody.translation();
        console.log('Player position:', playerPosition);

        renderer.render(scene, camera);
    }

    window.addEventListener("resize", onWindowResize, false);
    function onWindowResize() {
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(window.innerWidth, window.innerHeight);
    }

    // Start the animation loop immediately
    animate();
}

// Start the initialization immediately when the script loads
init().then(() => {
    console.log('Initialization complete');
});
