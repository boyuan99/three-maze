import * as THREE from 'three';
import '../style.css';
import { createTexturedHallway } from './HallwayModule.js';
import { UI } from '../utils/UI';
import { FollowCam } from '../utils/FollowCam';
import { KeyboardController } from '../utils/KeyboardController';
import { RapierDebugRenderer } from "../utils/RapierDebugRenderer";
import RAPIER from '@dimforge/rapier3d-compat';

async function init(vel, wakeUp){    // Scene setup
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(100, window.innerWidth / window.innerHeight, 0.01, 1000);
    camera.position.set(0, 5, 10);
    const renderer = new THREE.WebGLRenderer();
    renderer.setSize(window.innerWidth, window.innerHeight);
    document.body.appendChild(renderer.domElement);

    // Lighting
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
    scene.add(ambientLight);
    const directionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
    directionalLight.position.set(0, 20, 0);
    scene.add(directionalLight);

    // Initialize UI and controllers
    const ui = new UI(renderer);
    const followCam = new FollowCam(scene, camera, renderer);
    const keyboard = new KeyboardController(renderer);

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
        // Ensure the geometry's bounding box is computed
        child.geometry.computeBoundingBox();

        const bbox = child.geometry.boundingBox;
        const width = bbox.max.x - bbox.min.x;
        const height = bbox.max.y - bbox.min.y;
        const depth = bbox.max.z - bbox.min.z;

        const { x: px, y: py, z: pz } = child.position;

        // Create rigid bodies for each segment of the hallway
        const body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(px, py, pz));
        const collider = world.createCollider(RAPIER.ColliderDesc.cuboid(width / 2, height / 2, depth / 2).setRestitution(0).setFriction(1), body);
    });

    // Sphere setup (as before)
    const ballGeometry = new THREE.SphereGeometry(1, 32, 32);
    const ballMaterial = new THREE.MeshBasicMaterial({ color: 0xff0000 });
    const ball = new THREE.Mesh(ballGeometry, ballMaterial);
    ball.position.set(0, 1, 0); // Position it higher to observe falling
    scene.add(ball);

    // Physics for the ball
    const ballBodyDesc = RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(0, 1, 0)
        .setLinearDamping(0.9)  // Higher value for quicker reduction of linear velocity
        .setAngularDamping(0.9); // Higher value to reduce rotation/inertia
    const ballBody = world.createRigidBody(ballBodyDesc);
    const ballCollider = world.createCollider(RAPIER.ColliderDesc.ball(1).setRestitution(0).setFriction(1), ballBody);

    // Animation loop
    function animate(vel, wakeUp) {
        requestAnimationFrame(animate);

        rapierDebugRenderer.update();

        const moveForce = new THREE.Vector3(0, 0, 0);
        const maxSpeed = 50;
        const rawSpeed = 20;
        const isMoving = keyboard.keyMap['KeyW'] || keyboard.keyMap['KeyA'] || keyboard.keyMap['KeyS'] || keyboard.keyMap['KeyD'];

        if (isMoving) {
            if (keyboard.keyMap['KeyW']) moveForce.z -= rawSpeed;
            if (keyboard.keyMap['KeyS']) moveForce.z += rawSpeed;
            if (keyboard.keyMap['KeyA']) moveForce.x -= rawSpeed;
            if (keyboard.keyMap['KeyD']) moveForce.x += rawSpeed;

            // Apply camera's yaw rotation to the moveForce
            moveForce.applyEuler(new THREE.Euler(0, followCam.yaw.rotation.y, 0));

            // Apply force to the ball
            ballBody.applyImpulse(moveForce, true);
        } else {
            // If no keys are pressed, immediately stop the ball
            ballBody.setLinvel({x: 0, y: 0, z: 0}, wakeUp);
            ballBody.setAngvel({x: 0, y: 0, z: 0}, wakeUp);
        }

        // Limit the ball's velocity
        const velocity = ballBody.linvel();
        const speed = Math.sqrt(velocity.x ** 2 + velocity.y ** 2 + velocity.z ** 2);
        if (speed > maxSpeed) {
            const scaleFactor = maxSpeed / speed;
            ballBody.setLinvel({
                x: velocity.x * scaleFactor,
                y: velocity.y * scaleFactor,
                z: velocity.z * scaleFactor
            }, wakeUp);
        }

        // Update physics world
        world.step();

        // Sync Three.js object positions with Rapier physics bodies
        const ballPosition = ballBody.translation();
        ball.position.set(ballPosition.x, ballPosition.y, ballPosition.z);

        followCam.update(ball);

        renderer.render(scene, camera);
    }

    window.addEventListener("resize", onWindowResize, false);
    function onWindowResize() {
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(window.innerWidth, window.innerHeight);
        renderer.render(scene, camera);
    }

    animate();
}

init().then(() => {
    console.log('Initialization complete');
});
