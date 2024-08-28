import * as THREE from 'three';
import '../style.css';
import { createTexturedHallway } from './HallwayModule.js';
import { UI } from '../utils/UI';
import { FixedCam } from '../utils/FixedCam';
import { KeyboardController } from '../utils/KeyboardController';
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

    // Initialize UI and controllers
    const ui = new UI(renderer);
    const fixedCam = new FixedCam(scene, camera, renderer);
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
    const ballRadius = 1;
    const ballBodyDesc = RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(0, 1, 0)
        .setLinearDamping(0.9)
        .setAngularDamping(0.9)
        .setAdditionalMass(0.0001);

    const ballBody = world.createRigidBody(ballBodyDesc);
    const ballCollider = world.createCollider(RAPIER.ColliderDesc.ball(ballRadius).setRestitution(0).setFriction(1), ballBody);

    // Animation loop
    function animate() {
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
            moveForce.applyEuler(new THREE.Euler(0, fixedCam.yaw.rotation.y, 0));

            // Apply force to the ball
            ballBody.applyImpulse(moveForce, true);
        }

        // Limit the ball's velocity
        const velocity = ballBody.linvel();
        const speed = Math.sqrt(velocity.x ** 2 + velocity.y ** 2 + velocity.z ** 2);
        if (speed > maxSpeed) {
            const scaleFactor = maxSpeed / speed;
            ballBody.setLinvel({ x: velocity.x * scaleFactor, y: velocity.y * scaleFactor, z: velocity.z * scaleFactor });
        }

        // Update physics world
        world.step();

        // Get ball position
        const ballPosition = ballBody.translation();

        // Update camera position to follow the ball
        fixedCam.update({ position: new THREE.Vector3(ballPosition.x, ballPosition.y + ballRadius, ballPosition.z) });

        renderer.render(scene, camera);
    }

    window.addEventListener("resize", onWindowResize, false);
    function onWindowResize() {
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(window.innerWidth, window.innerHeight);
    }

    animate();
}

init();
