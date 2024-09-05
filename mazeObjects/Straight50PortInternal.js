import * as THREE from 'three';
import '../style.css';
import { createTexturedHallway } from './HallwayModule.js';
import { RapierDebugRenderer } from "../utils/RapierDebugRenderer";
import RAPIER from '@dimforge/rapier3d-compat';

async function init() {
    // Scene setup
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(90, window.innerWidth / window.innerHeight, 0.1, 1000);
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

    let latestSensorData = null;

    // Function to generate simulated sensor data
    function generateSimulatedSensorData() {
        const time = Date.now() * 0.001; // Current time in seconds
        return {
            x: Math.sin(time) * 5, // Simulated x position
            y: Math.cos(time) * 5, // Simulated y position
            vx: Math.cos(time) * 0.5, // Simulated x velocity
            vy: -Math.sin(time) * 0.5, // Simulated y velocity
            angle: (Math.sin(time * 0.5) * Math.PI) / 4, // Simulated angle
            angular_velocity: Math.cos(time * 0.5) * 0.1 // Simulated angular velocity
        };
    }

    // Update sensor data in animation loop
    function updateSensorData() {
        latestSensorData = generateSimulatedSensorData();
    }

    function updatePlayerMovement() {
        if (latestSensorData) {
            const { x, y, vx, vy, angle, angular_velocity } = latestSensorData;

            const moveForce = new THREE.Vector3(vx, 0, vy);
            moveForce.multiplyScalar(20); // Scale the force

            playerBody.applyImpulse(moveForce, true);
            playerBody.setAngvel({ x: 0, y: angular_velocity, z: 0 }, true);

            updateCameraPositionAndOrientation(angle);
        }
    }

    function updateCameraPositionAndOrientation(angle) {
        const playerPosition = playerBody.translation();
        // Position the camera at the player's position, slightly raised
        camera.position.set(playerPosition.x, playerPosition.y + playerRadius * 0.8, playerPosition.z);

        // Set the camera's rotation based on the player's angle
        camera.rotation.y = -angle;
    }

    // Helper to show player's facing direction (now in front of the camera)
    const directionHelper = new THREE.Object3D();
    const arrowHelper = new THREE.ArrowHelper(
        new THREE.Vector3(0, 0, -1),
        new THREE.Vector3(0, 0, 0),
        2,
        0x00ff00
    );
    directionHelper.add(arrowHelper);
    scene.add(directionHelper);

    // Animation loop
    function animate() {
        requestAnimationFrame(animate);

        updateSensorData(); // Generate new sensor data each frame
        updatePlayerMovement();
        rapierDebugRenderer.update();
        world.step();

        const playerPosition = playerBody.translation();

        // Update direction helper
        directionHelper.position.copy(camera.position);
        directionHelper.rotation.y = camera.rotation.y;

        // console.log('Player position:', playerPosition);
        // console.log('Camera position:', camera.position);
        // console.log('Camera rotation:', camera.rotation);

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