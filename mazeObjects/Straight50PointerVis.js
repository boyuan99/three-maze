import * as THREE from 'three';
import '../style.css';
import { createTexturedHallway } from './HallwayModule.js';
import { UI } from '../ui';
import { FollowCam } from '../followCam';
import { KeyboardController } from '../keyboardController';
import { RapierDebugRenderer } from "../RapierDebugRenderer";
import RAPIER from '@dimforge/rapier3d-compat';

async function init() {
    // Scene setup
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
    const sphereGeometry = new THREE.SphereGeometry(1, 32, 32);
    const sphereMaterial = new THREE.MeshBasicMaterial({ color: 0xff0000 });
    const sphere = new THREE.Mesh(sphereGeometry, sphereMaterial);
    sphere.position.set(0, 5, 0); // Position it higher to observe falling
    scene.add(sphere);

    // Physics for the sphere
    const sphereBody = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(0, 5, 0));
    const sphereCollider = world.createCollider(RAPIER.ColliderDesc.ball(1).setRestitution(0).setFriction(1), sphereBody);

    // Animation loop
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

        sphereBody.applyImpulse(moveForce, true);

        // Update physics world
        world.step();

        // Sync Three.js object positions with Rapier physics bodies
        const spherePosition = sphereBody.translation();
        sphere.position.set(spherePosition.x, spherePosition.y, spherePosition.z);

        followCam.update(sphere);

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
