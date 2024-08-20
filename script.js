import './style.css';
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { UI } from './ui';
import { FollowCam } from './followCam';
import { KeyboardController } from './keyboardController';
import { RapierDebugRenderer } from "./RapierDebugRenderer";

async function init() {
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
    camera.position.set(0, 2, 10);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    document.body.appendChild(renderer.domElement);

    const ui = new UI(renderer);

    // Initialize Rapier Physics World
    await RAPIER.init();
    const gravity = { x: 0.0, y: -9.81, z: 0.0 };
    const world = new RAPIER.World(gravity);

    const rapierDebugRenderer = new RapierDebugRenderer(scene, world);

    // Replace the ground plane with a box
    const boxWidth = 50;
    const boxHeight = 1;
    const boxDepth = 50;
    const floorGeometry = new THREE.BoxGeometry(boxWidth, boxHeight, boxDepth);
    const floorMaterial = new THREE.MeshStandardMaterial({ color: 0x808080 });
    const floorMesh = new THREE.Mesh(floorGeometry, floorMaterial);
    floorMesh.position.y = -0.5; // Position it so that the top of the box is at y = 0
    floorMesh.receiveShadow = true;
    scene.add(floorMesh);

    // Physics for ground (using a box)
    const groundBody = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, -0.5, 0));
    const groundCollider = world.createCollider(RAPIER.ColliderDesc.cuboid(boxWidth / 2, boxHeight / 2, boxDepth / 2), groundBody);

    // Ball
    const ballGeometry = new THREE.SphereGeometry(1, 32, 32);
    const ballMaterial = new THREE.MeshStandardMaterial({ color: 0xff0000 });
    const ball = new THREE.Mesh(ballGeometry, ballMaterial);
    ball.castShadow = true;
    ball.position.set(0, 5, 0); // Start higher to see falling effect
    scene.add(ball);

    // Physics for ball
    const ballBody = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(0, 5, 0));
    const ballCollider = world.createCollider(RAPIER.ColliderDesc.ball(1), ballBody);

    // Light
    const light = new THREE.DirectionalLight(0xffffff, 1);
    light.position.set(10, 10, 10);
    light.castShadow = true;
    scene.add(light);

    // const ambientLight = new THREE.AmbientLight(0xffffff, 1); // Color and intensity
    // scene.add(ambientLight);


    // Camera Follow
    const followCam = new FollowCam(scene, camera, renderer);

    const keyboard = new KeyboardController(renderer);

    function animate() {
        requestAnimationFrame(animate);

        rapierDebugRenderer.update();

        const moveForce = new THREE.Vector3(0, 0, 0);
        const speed = 0.5;
        const isMoving = keyboard.keyMap['KeyW'] || keyboard.keyMap['KeyA'] || keyboard.keyMap['KeyS'] || keyboard.keyMap['KeyD'];

        if (isMoving) {
            if (keyboard.keyMap['KeyW']) moveForce.z -= speed;
            if (keyboard.keyMap['KeyS']) moveForce.z += speed;
            if (keyboard.keyMap['KeyA']) moveForce.x -= speed;
            if (keyboard.keyMap['KeyD']) moveForce.x += speed;

            if (!keyboard.isJumping && keyboard.keyMap['Space']) {
                keyboard.isJumping = true;
                moveForce.y += 10;
                setTimeout(() => {
                    keyboard.isJumping = false;
                }, 500); // Prevents multiple jumps
            }

            // Apply camera's yaw rotation to the moveForce
            const euler = new THREE.Euler(0, followCam.yaw.rotation.y, 0);
            moveForce.applyEuler(euler);
        }

        ballBody.applyImpulse(moveForce, true);

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

init();
